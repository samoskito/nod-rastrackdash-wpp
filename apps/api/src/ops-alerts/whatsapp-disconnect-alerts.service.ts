import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import {
  RUNTIME_ENV,
  RUNTIME_FETCH,
  type RuntimeEnv,
  type RuntimeFetch,
} from "../common/runtime/runtime.module";
import { WhatsappProviderRegistry } from "../integrations/whatsapp-providers/whatsapp-provider.registry";
import type { WhatsappProviderId } from "../integrations/whatsapp-providers/whatsapp-provider.types";

export const DEFAULT_DISCONNECT_ALERT_STREAK = 3;
export const DEFAULT_DISCONNECT_ALERT_INTERVAL_MS = 15 * 60_000;
const WEBHOOK_TIMEOUT_MS = 5_000;

type StreakState = {
  count: number;
  alerted: boolean;
};

/**
 * Watches every registered WhatsApp provider adapter
 * (WhatsappProviderRegistry — uazapi_byo/nod_api/waha/zapi) on a plain
 * setInterval loop (same template as MetaReportAutoSyncService /
 * InboundWebhookMaintenanceService — no @nestjs/schedule) and alerts once
 * a provider's health stays "disconnected" for N consecutive checks in a
 * row (default 3, DISCONNECT_ALERT_STREAK).
 *
 * Streaks are in-memory only (Map<providerId, StreakState>) — they reset
 * on process restart and are not shared across instances. See ./README.md.
 */
@Injectable()
export class WhatsappDisconnectAlertsService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WhatsappDisconnectAlertsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly streaks = new Map<WhatsappProviderId, StreakState>();

  constructor(
    @Inject(WhatsappProviderRegistry)
    private readonly registry: WhatsappProviderRegistry,
    @Optional()
    @Inject(RUNTIME_ENV)
    private readonly env: RuntimeEnv = process.env,
    @Optional()
    @Inject(RUNTIME_FETCH)
    private readonly fetchImpl: RuntimeFetch = fetch,
  ) {}

  onModuleInit(): void {
    if (!this.enabled()) {
      this.logger.log(
        "WhatsApp disconnect alerts disabled (set DISCONNECT_ALERTS_ENABLED=true to enable)",
      );
      return;
    }

    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs());
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Evaluates every provider currently registered. Called by the interval. */
  async runOnce(): Promise<void> {
    for (const adapter of this.registry.list()) {
      await this.evaluateProviderHealth(adapter.id);
    }
  }

  /**
   * Checks one provider's health and updates its disconnect streak.
   * Public (rather than private, interval-only) so tests can drive it
   * directly instead of racing setInterval.
   */
  async evaluateProviderHealth(providerId: WhatsappProviderId): Promise<void> {
    const adapter = this.registry.get(providerId);

    if (!adapter) {
      return;
    }

    let status: string | undefined;
    let message: string | undefined;

    try {
      const health = await adapter.getHealth();
      status = health?.status;
      message = health?.message;
    } catch (error) {
      this.logger.debug(
        `whatsapp_disconnect_health_check_failed provider=${providerId}: ${this.errorMessage(error)}`,
      );
      return;
    }

    if (status === "connected") {
      this.streaks.delete(providerId);
      return;
    }

    if (status === "disconnected") {
      const state = this.streaks.get(providerId) ?? {
        count: 0,
        alerted: false,
      };
      state.count += 1;
      this.streaks.set(providerId, state);

      if (state.count >= this.streakThreshold() && !state.alerted) {
        state.alerted = true;
        await this.fireAlert(providerId, state.count, message);
      }

      return;
    }

    // Ambiguous ("needs_reconnect", "error", "syncing", "pending_payment",
    // or a missing/unknown status) — neither counts toward nor resets the
    // streak; a transient hiccup shouldn't erase real disconnect progress.
    this.logger.debug(
      `whatsapp_disconnect_ambiguous_status provider=${providerId} status=${status ?? "missing"}`,
    );
  }

  private async fireAlert(
    providerId: WhatsappProviderId,
    streak: number,
    message: string | undefined,
  ): Promise<void> {
    this.logger.warn(
      `whatsapp_disconnect_alert provider=${providerId} streak=${streak} message=${message ?? "-"}`,
    );

    const webhookUrl = this.env.OPS_ALERT_WEBHOOK_URL?.trim();

    if (!webhookUrl) {
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    try {
      await this.fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "whatsapp_disconnect",
          provider: providerId,
          streak,
          message: message ?? null,
          checkedAt: new Date().toISOString(),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      this.logger.warn(
        `whatsapp_disconnect_alert_webhook_failed provider=${providerId}: ${this.errorMessage(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private enabled(): boolean {
    return this.env.DISCONNECT_ALERTS_ENABLED?.trim().toLowerCase() === "true";
  }

  private streakThreshold(): number {
    return this.positiveIntegerEnv(
      "DISCONNECT_ALERT_STREAK",
      DEFAULT_DISCONNECT_ALERT_STREAK,
    );
  }

  private intervalMs(): number {
    return this.positiveIntegerEnv(
      "DISCONNECT_ALERT_INTERVAL_MS",
      DEFAULT_DISCONNECT_ALERT_INTERVAL_MS,
    );
  }

  private positiveIntegerEnv(name: string, fallback: number): number {
    const parsed = Number.parseInt(this.env[name] ?? "", 10);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "erro desconhecido";
  }
}
