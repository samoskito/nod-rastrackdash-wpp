import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import { LicenseClientService } from "../licensing-client/license-client.service";
import { ProviderConversionRulesService } from "./provider-conversion-rules.service";
import { BRIDGE_PROVISIONED_EVENT } from "../inbound-webhooks/bridged-whatsapp-providers";

/**
 * Written by UazapiConversionBridgeService.ensureBridge (Uazapi or WAHA) in the SAME
 * transaction as the bridge, so it works as a durable outbox: nothing is lost
 * if the process dies right after the commit (no new queue). The SaaS also
 * listens to seat events; this edition has no seats.
 */
export const UAZAPI_BRIDGE_PROVISIONED_EVENT: string =
  BRIDGE_PROVISIONED_EVENT.uazapi;
/** Bridge events of every bridged provider (Uazapi and WAHA). */
export const BRIDGE_PROVISIONED_EVENTS: string[] = Object.values(
  BRIDGE_PROVISIONED_EVENT,
);

const TICK_MS = 60_000;
/** Events are retried on every tick while inside this window. */
export const GLOBAL_AUTO_ACTIVATION_EVENT_WINDOW_MS = 15 * 60_000;
/** Safety net: every eligible workspace is reconciled this often. */
export const GLOBAL_AUTO_ACTIVATION_RECONCILE_MS = 60 * 60_000;
/** Workspaces read per page (GROUP BY workspaceId, keyset pagination). */
export const GLOBAL_AUTO_ACTIVATION_PAGE = 200;
/** Work budget of one tick; the next tick resumes where this one stopped. */
export const GLOBAL_AUTO_ACTIVATION_BUDGET_MS = 40_000;
/**
 * The run lock is a transaction-scoped advisory lock held by a dedicated,
 * otherwise idle transaction for the whole run (no audit rows). Its timeout
 * covers the budget plus one workspace in flight.
 */
const RUN_LOCK_TIMEOUT_MS = GLOBAL_AUTO_ACTIVATION_BUDGET_MS + 45_000;
/**
 * Hard stop inside a workspace (checked before each number): the run always
 * ends well before RUN_LOCK_TIMEOUT_MS, so the lock transaction never expires
 * while numbers are still being promoted (another instance could then start).
 */
export const GLOBAL_AUTO_ACTIVATION_HARD_STOP_MS =
  GLOBAL_AUTO_ACTIVATION_BUDGET_MS + 30_000;
const RUN_LOCK_KEY = "provider-rule-global-auto-activation";

type Clock = () => number;

/**
 * Every minute it walks the workspaces that have an active production
 * "Todos os números" rule (keyset pages of GROUP BY workspaceId, resuming
 * from a cursor so every workspace is eventually served) and, for those with
 * a recent bridge event (or all of them on the hourly reconciliation), runs
 * ProviderConversionRulesService.autoActivateGlobalNumbers (system actor,
 * never-live numbers only, with backoff). One instance at a time.
 *
 * Edição do aluno: the SaaS skips workspaces without billing access; here
 * the whole run is skipped while the installation license is locked (same
 * check as the 423 of every manual write).
 *
 * Several API instances: the advisory lock lets only one run at a time, but
 * the timer, the keyset cursor, the hourly reconciliation clock and the
 * failure backoff kept in memory are PER INSTANCE. Each instance therefore
 * does its own hourly reconciliation (serialized by the lock); the work is
 * idempotent, so this only costs repeated reads, never a second promotion.
 */
@Injectable()
export class GlobalRuleAutoActivationService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(GlobalRuleAutoActivationService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastReconcileAt = 0;
  /** Keyset cursor of the current pass (null: start over). */
  private cursor: string | null = null;
  /** Whether the pass that is in progress is a reconciliation. */
  private passIsReconcile = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv,
    @Inject(ProviderConversionRulesService)
    private readonly rules: ProviderConversionRulesService,
    @Optional()
    @Inject(LicenseClientService)
    private readonly license?: LicenseClientService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled()) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() =>
        this.logger.warn("provider_rule_global_auto_activation_tick_failed"),
      );
    }, TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private enabled(): boolean {
    const config = parseInboundWebhooksConfig(this.env);
    return (
      config.enabled &&
      config.conversionRulesEnabled &&
      config.productionEnabled &&
      config.conversionProductionEnabled
    );
  }

  /** Whether the installation license currently allows writes. */
  private async licenseAllowsWrites(): Promise<boolean> {
    if (!this.license) return true;
    try {
      const decision = await this.license.getLockState();
      return !decision.locked;
    } catch {
      // Fail-closed: an unknown license state never activates anything.
      return false;
    }
  }

  /**
   * One run; returns the workspaces activated (exposed for tests). `clock`
   * drives the work budget.
   */
  async tick(now = new Date(), clock: Clock = Date.now): Promise<string[]> {
    if (this.running || !this.enabled()) return [];
    if (!(await this.licenseAllowsWrites())) return [];
    this.running = true;
    try {
      let handled: string[] = [];
      const locked = await this.prisma.$transaction(
        async (transaction) => {
          const rows = await transaction.$queryRaw<Array<{ locked: boolean }>>`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${RUN_LOCK_KEY}, 0)) AS locked`;
          if (rows[0]?.locked !== true) return false;
          handled = await this.run(now, clock);
          return true;
        },
        { timeout: RUN_LOCK_TIMEOUT_MS, maxWait: 5_000 },
      );
      return locked ? handled : [];
    } finally {
      this.running = false;
    }
  }

  private async run(now: Date, clock: Clock): Promise<string[]> {
    const startedAt = clock();
    if (this.cursor === null) {
      // A new pass: reconciliation when due, otherwise events only.
      this.passIsReconcile =
        now.getTime() - this.lastReconcileAt >= GLOBAL_AUTO_ACTIVATION_RECONCILE_MS;
      if (this.passIsReconcile) this.lastReconcileAt = now.getTime();
    }
    const since = new Date(now.getTime() - GLOBAL_AUTO_ACTIVATION_EVENT_WINDOW_MS);
    const handled: string[] = [];

    for (;;) {
      if (clock() - startedAt >= GLOBAL_AUTO_ACTIVATION_BUDGET_MS) return handled;
      const page = await this.prisma.providerConversionRuleConfig.groupBy({
        by: ["workspaceId"],
        where: {
          removedAt: null,
          scope: "all_numbers",
          mode: "production",
          conversionRule: { active: true },
          ...(this.cursor ? { workspaceId: { gt: this.cursor } } : {}),
        },
        orderBy: { workspaceId: "asc" },
        take: GLOBAL_AUTO_ACTIVATION_PAGE,
      });
      for (const { workspaceId } of page) {
        if (clock() - startedAt >= GLOBAL_AUTO_ACTIVATION_BUDGET_MS) return handled;
        this.cursor = workspaceId;
        const due = await this.dueTrigger(workspaceId, since);
        if (!due) continue;
        try {
          await this.rules.autoActivateGlobalNumbers(workspaceId, due.trigger, {
            eventAt: due.eventAt,
            now,
            shouldStop: () =>
              clock() - startedAt >= GLOBAL_AUTO_ACTIVATION_HARD_STOP_MS,
          });
          handled.push(workspaceId);
        } catch {
          this.logger.warn(
            JSON.stringify({
              event: "provider_rule_global_auto_activation_failed",
              workspaceId,
            }),
          );
        }
      }
      if (page.length < GLOBAL_AUTO_ACTIVATION_PAGE) {
        this.cursor = null; // pass complete; the next tick starts over
        return handled;
      }
    }
  }

  private async dueTrigger(
    workspaceId: string,
    since: Date,
  ): Promise<{ trigger: string; eventAt: Date | null } | null> {
    const bridgeEvent = await this.prisma.auditLog.findFirst({
      where: {
        workspaceId,
        action: { in: BRIDGE_PROVISIONED_EVENTS },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (bridgeEvent) {
      return { trigger: "bridge_created", eventAt: bridgeEvent.createdAt };
    }
    return this.passIsReconcile ? { trigger: "reconcile", eventAt: null } : null;
  }
}
