import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ProviderConversionRuleBlockedReprocessResultDto } from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import {
  BLOCKED_REPROCESS_AUDIT_ACTION,
  BLOCKED_REPROCESS_BATCH,
  BLOCKED_REPROCESS_COOLDOWN_MS,
  BLOCKED_REPROCESS_RUN_TTL_MS,
  BLOCKED_REPROCESS_SCAN_LIMIT,
  BLOCKED_REPROCESS_STARTED_ACTION,
  BLOCKED_REPROCESS_WINDOW_DAYS,
  blockedReprocessCutoff,
  blockedReprocessWhere,
  findReprocessableExecutions,
  partitionAlreadyConverted,
  ruleAcceptsReprocess,
} from "../conversion-rules/provider-rule-blocked-reprocess";
import { InboundWebhookMetaRouteReaderService } from "./inbound-webhook-meta-route-reader.service";
import { UazapiProviderConversionService } from "./uazapi-provider-conversion.service";
import { leadSubmittedRuleOverrideEnabled } from "../conversion-rules/lead-submitted-rule-override";

/**
 * "Reprocessar bloqueadas" of one rule: retries, through the existing
 * UazapiProviderConversionService.recoverDecision (the same manual-recovery
 * path as the operational recovery script), the executions that were stopped
 * only because their number had never been in production yet (see
 * provider-rule-blocked-reprocess.ts for the selection, the deliberate-pause
 * exclusion and the 7-day Meta window).
 *
 * Safety:
 *  - only for a rule that sends now (active, production, not unified):
 *    recoverDecision follows the live rule MODE and would otherwise resend
 *    conversations of a paused rule;
 *  - never re-evaluates a message: the frozen decision is reused;
 *  - a dry run first: an execution is only written when its disposition is
 *    `eligible` NOW; otherwise it is left untouched (still blocked);
 *  - idempotent: the orchestrator upserts by (rule, occurrence) and never
 *    rewrites materialized/duplicate executions, the production queue job id
 *    is the execution id, and materialization keeps its business dedupe;
 *  - one run at a time per rule: a reservation audit is written under a
 *    transaction-scoped advisory lock before any work, so concurrent clicks
 *    (any API instance) are refused instead of processing the same batch;
 *    plus a cooldown after each run and BLOCKED_REPROCESS_BATCH per click;
 *  - edição do aluno: the route is a POST, so a locked license answers 423
 *    before reaching this service (LicenseSoftlockGuard), and the send itself
 *    is still gated by the license in ConversionEventsService.
 */
@Injectable()
export class ProviderRuleBlockedReprocessService {
  private readonly logger = new Logger(ProviderRuleBlockedReprocessService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv,
    @Inject(UazapiProviderConversionService)
    private readonly uazapi: UazapiProviderConversionService,
  ) {}

  async reprocess(
    workspaceId: string,
    providerRuleId: string,
    actorUserId: string,
    now = new Date(),
  ): Promise<ProviderConversionRuleBlockedReprocessResultDto> {
    const config = parseInboundWebhooksConfig(this.env);
    if (!config.enabled || !config.conversionRulesEnabled) {
      throw new ServiceUnavailableException(
        "Eventos de conversão por provedor ainda não estão habilitados",
      );
    }

    const rule = await this.prisma.providerConversionRuleConfig.findFirst({
      where: { id: providerRuleId, workspaceId, removedAt: null },
      select: {
        id: true,
        mode: true,
        removedAt: true,
        unifiedIntoProviderRuleId: true,
        connectionId: true,
        connection: { select: { status: true, removedAt: true } },
        conversionRule: { select: { active: true } },
      },
    });
    if (!rule) {
      throw new NotFoundException(
        "Regra de conversão do provedor não encontrada",
      );
    }
    if (!ruleAcceptsReprocess(rule)) {
      throw new ConflictException({
        statusCode: 409,
        error: "Conflict",
        code: "provider_rule_reprocess_rule_inactive",
        message:
          "Ative o envio automático da regra antes de reprocessar as conversas bloqueadas",
      });
    }

    await this.reserveRun(workspaceId, rule.id, actorUserId, now);

    const counts = {
      reprocessed: 0,
      stillBlocked: 0,
      skipped: 0,
      failed: 0,
    };
    const reprocessedExecutionIds: string[] = [];
    let result: ProviderConversionRuleBlockedReprocessResultDto | null = null;
    try {
      const base = blockedReprocessWhere(workspaceId, rule.id);
      const cutoff = blockedReprocessCutoff(now);
      const [expired, inWindow, candidates] = await Promise.all([
        this.prisma.providerConversionRuleExecution.count({
          where: { ...base, occurredAt: { lt: cutoff } },
        }),
        this.prisma.providerConversionRuleExecution.count({
          where: { ...base, occurredAt: { gte: cutoff } },
        }),
        findReprocessableExecutions(this.prisma, {
          workspaceId,
          rule,
          cutoff,
          limit: BLOCKED_REPROCESS_SCAN_LIMIT,
        }),
      ]);
      // Never re-enqueue what the production job would only mark duplicate
      // (lead already converted by another number / the CTWA entry).
      const { ready, alreadyConverted } = await partitionAlreadyConverted(
        this.prisma,
        {
          workspaceId,
          executions: candidates,
          includeAutoLead: leadSubmittedRuleOverrideEnabled(this.env),
          previewRoute: (route) =>
            new InboundWebhookMetaRouteReaderService(this.prisma).previewRoute(
              route,
            ),
        },
      );
      const batch = ready.slice(0, BLOCKED_REPROCESS_BATCH);

      for (const execution of batch) {
        try {
          const plan = await this.uazapi.recoverDecision({
            decisionId: execution.providerDecisionId,
            workspaceId,
            execute: false,
          });
          if (plan.disposition.state !== "eligible") {
            counts.stillBlocked += 1;
            continue;
          }
          const recovered = await this.uazapi.recoverDecision({
            decisionId: execution.providerDecisionId,
            workspaceId,
            execute: true,
          });
          if (recovered.eligibleExecutionId) {
            counts.reprocessed += 1;
            reprocessedExecutionIds.push(recovered.eligibleExecutionId);
          } else {
            counts.stillBlocked += 1;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (message.includes("not a bridged WhatsApp connection")) {
            counts.skipped += 1;
          } else {
            counts.failed += 1;
            this.logger.warn(
              JSON.stringify({
                event: "provider_rule_blocked_reprocess_failed",
                workspaceId,
                providerRuleId: rule.id,
                executionId: execution.id,
              }),
            );
          }
        }
      }

      result = {
        windowDays: BLOCKED_REPROCESS_WINDOW_DAYS,
        reprocessed: counts.reprocessed,
        // In the window but not retried now: number still not live, paused
        // on purpose at the time, not a QR number, or not eligible on the
        // dry run.
        stillBlocked:
          counts.stillBlocked +
          Math.max(0, inWindow - ready.length - alreadyConverted.length),
        alreadyConverted: alreadyConverted.length,
        skipped: counts.skipped,
        failed: counts.failed,
        expired,
        remaining: Math.max(0, ready.length - batch.length),
      };
      return result;
    } finally {
      // Always closes the reservation, also when the run failed midway.
      await this.prisma.auditLog.create({
        data: {
          workspaceId,
          actorUserId,
          actorType: "user",
          action: BLOCKED_REPROCESS_AUDIT_ACTION,
          targetType: "ProviderConversionRuleConfig",
          targetId: rule.id,
          reason: "Operator reprocessed executions blocked before production",
          sourceIp: null,
          resultStatus: !result
            ? "failed"
            : counts.reprocessed > 0
              ? "reprocessed"
              : "unchanged",
          afterSummary: { ...(result ?? counts), reprocessedExecutionIds },
        },
      });
    }
  }

  /**
   * Serializes runs of one rule across API instances: under a transaction
   * advisory lock, refuses while another run is open (started audit without
   * its completion, for up to BLOCKED_REPROCESS_RUN_TTL_MS) or inside the
   * cooldown of the last run, then records this run as started.
   */
  private async reserveRun(
    workspaceId: string,
    providerRuleId: string,
    actorUserId: string,
    now: Date,
  ): Promise<void> {
    const lockKey = `provider-rule-blocked-reprocess:${workspaceId}:${providerRuleId}`;
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
      const started = await transaction.auditLog.findFirst({
        where: {
          workspaceId,
          action: BLOCKED_REPROCESS_STARTED_ACTION,
          targetType: "ProviderConversionRuleConfig",
          targetId: providerRuleId,
          createdAt: {
            gte: new Date(now.getTime() - BLOCKED_REPROCESS_RUN_TTL_MS),
          },
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (started) {
        const finished = await transaction.auditLog.findFirst({
          where: {
            workspaceId,
            action: BLOCKED_REPROCESS_AUDIT_ACTION,
            targetType: "ProviderConversionRuleConfig",
            targetId: providerRuleId,
            createdAt: { gte: started.createdAt },
          },
          select: { id: true },
        });
        if (!finished) {
          throw new ConflictException({
            statusCode: 409,
            error: "Conflict",
            code: "provider_rule_reprocess_in_progress",
            message: "Já existe um reprocessamento em andamento para esta regra",
          });
        }
      }
      const recent = await transaction.auditLog.findFirst({
        where: {
          workspaceId,
          action: BLOCKED_REPROCESS_AUDIT_ACTION,
          targetType: "ProviderConversionRuleConfig",
          targetId: providerRuleId,
          createdAt: {
            gte: new Date(now.getTime() - BLOCKED_REPROCESS_COOLDOWN_MS),
          },
        },
        select: { id: true },
      });
      if (recent) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            error: "Too Many Requests",
            code: "provider_rule_reprocess_cooldown",
            message: "Aguarde alguns segundos antes de reprocessar de novo",
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      await transaction.auditLog.create({
        data: {
          workspaceId,
          actorUserId,
          actorType: "user",
          action: BLOCKED_REPROCESS_STARTED_ACTION,
          targetType: "ProviderConversionRuleConfig",
          targetId: providerRuleId,
          reason: null,
          sourceIp: null,
          resultStatus: "started",
          afterSummary: {},
        },
      });
    });
  }
}
