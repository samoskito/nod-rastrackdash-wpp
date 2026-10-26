import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import {
  MANUAL_CONVERSION_ERROR_CODES,
  MANUAL_CONVERSION_TRIGGER,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { readManualDispatchingSince } from "./manual-conversion-payload";

/** A manual send claimed longer ago than this is considered interrupted. */
export const MANUAL_DISPATCH_STUCK_MS = 15 * 60_000;
/** Claims without a readable timestamp: only far older logs are touched. */
const UNTIMED_STUCK_MS = 24 * 60 * 60_000;
const TICK_MS = 5 * 60_000;
const BATCH = 200;
/** Max useful age of a manual dispatch (Meta's 7-day limit + margin). */
export const RECOVERY_WINDOW_MS = 8 * 24 * 60 * 60_000;
const WORKSPACE_CHUNK = 500;

export const MANUAL_DISPATCH_INTERRUPTED_MESSAGE =
  "Envio interrompido: não foi possível confirmar se a Meta recebeu a conversão manual. Ela não é reenviada automaticamente; confira no Gerenciador de Eventos.";

/**
 * Tarefa 21 (6a): a manual conversion stays "dispatching" only for the
 * seconds of the Meta call. If the worker died in between, the outcome is
 * unknown: like the CTWA fence, it is NEVER resent automatically (a resend
 * could duplicate it); it is moved to delivery_unknown with a clear reason so
 * the panel stops showing "em envio" forever. Only manual logs are touched.
 */
@Injectable()
export class ManualConversionDispatchRecoveryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(
    ManualConversionDispatchRecoveryService.name,
  );
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.recoverStuckDispatches().catch(() =>
        this.logger.warn("manual_conversion_dispatch_recovery_failed"),
      );
    }, TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async recoverStuckDispatches(now: Date = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      // Index-bound scan: ConversionEventLog has (workspaceId, status,
      // createdAt), so the query names the workspaces (small table) and a
      // createdAt window. 8 days is the useful window: a manual conversion
      // only reaches "dispatching" while inside Meta's 7-day limit.
      const workspaces = await this.prisma.workspace.findMany({
        select: { id: true },
      });
      const createdAfter = new Date(now.getTime() - RECOVERY_WINDOW_MS);
      const stuck: Array<{
        id: string;
        errorMessage: string | null;
        createdAt: Date;
      }> = [];
      for (
        let start = 0;
        start < workspaces.length && stuck.length < BATCH;
        start += WORKSPACE_CHUNK
      ) {
        stuck.push(
          ...(await this.prisma.conversionEventLog.findMany({
            where: {
              workspaceId: {
                in: workspaces
                  .slice(start, start + WORKSPACE_CHUNK)
                  .map((workspace) => workspace.id),
              },
              status: "dispatching",
              createdAt: { gte: createdAfter },
              sourceTrigger: MANUAL_CONVERSION_TRIGGER,
            },
            select: { id: true, errorMessage: true, createdAt: true },
            take: BATCH - stuck.length,
          })),
        );
      }
      let recovered = 0;
      for (const log of stuck) {
        const since = readManualDispatchingSince(log.errorMessage);
        const age = now.getTime() - (since ?? log.createdAt).getTime();
        if (age < (since ? MANUAL_DISPATCH_STUCK_MS : UNTIMED_STUCK_MS))
          continue;
        const updated = await this.prisma.conversionEventLog.updateMany({
          // Conditional: a sender that finished meanwhile keeps its outcome.
          where: {
            id: log.id,
            status: "dispatching",
            errorMessage: log.errorMessage,
          },
          data: {
            status: "delivery_unknown",
            errorCode: MANUAL_CONVERSION_ERROR_CODES.dispatchInterrupted,
            errorMessage: MANUAL_DISPATCH_INTERRUPTED_MESSAGE,
          },
        });
        recovered += updated.count;
      }
      return recovered;
    } finally {
      this.running = false;
    }
  }
}
