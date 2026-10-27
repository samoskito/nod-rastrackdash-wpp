import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  conversionEventCatalogOrder,
  conversionEventDisplayLabel,
  type ConversionEventNameDto,
  type FunnelConfigurationDto,
  type FunnelConfigurationUpdateInputDto,
  type FunnelStageConfigurationDto
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";

type PersistedFunnelStage = {
  eventName: string;
  label: string;
  position: number;
  visible: boolean;
  defaultValueCents: number | null;
  defaultCurrency: string | null;
  defaultContentName: string | null;
};

const defaultFunnelEvents: ConversionEventNameDto[] = [
  "LeadSubmitted",
  "QualifiedLead",
  "Purchase"
];

@Injectable()
export class FunnelConfigurationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getConfiguration(workspaceId: string): Promise<FunnelConfigurationDto> {
    const [persistedStages, activeRules] = await Promise.all([
      this.prisma.funnelStageConfiguration.findMany({
        where: { workspaceId },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: {
          eventName: true,
          label: true,
          position: true,
          visible: true,
          defaultValueCents: true,
          defaultCurrency: true,
          defaultContentName: true
        }
      }) as Promise<PersistedFunnelStage[]>,
      this.prisma.conversionRule.findMany({
        where: { workspaceId, active: true },
        orderBy: { createdAt: "asc" },
        select: { eventName: true }
      }) as Promise<Array<{ eventName: string }>>
    ]);
    const persistedByEvent = new Map(
      persistedStages.map((stage) => [stage.eventName, stage])
    );
    const eventNames = Array.from(
      new Set([
        ...defaultFunnelEvents,
        ...persistedStages.map((stage) => stage.eventName),
        ...activeRules.map((rule) => rule.eventName)
      ])
    ) as ConversionEventNameDto[];
    const stages = eventNames
      .map((eventName) => {
        const persisted = persistedByEvent.get(eventName);

        return {
          eventName,
          label: persisted?.label ?? conversionEventDisplayLabel(eventName),
          position: persisted?.position ?? this.canonicalPosition(eventName, persistedStages),
          visible: persisted?.visible ?? true,
          defaultValueCents: persisted?.defaultValueCents ?? null,
          defaultCurrency: persisted?.defaultCurrency ?? null,
          defaultContentName: persisted?.defaultContentName ?? null
        } satisfies FunnelStageConfigurationDto;
      })
      .sort(
        (left, right) =>
          left.position - right.position ||
          conversionEventCatalogOrder(left.eventName) -
            conversionEventCatalogOrder(right.eventName) ||
          left.label.localeCompare(right.label, "pt-BR")
      )
      .map((stage, index) => ({ ...stage, position: index + 1 }));

    return { stages };
  }

  /**
   * Posicao de uma etapa ainda nao persistida. O default nunca pode ser o indice
   * de insercao: uma regra criada depois (InitiateCheckout em Caxias) ia parar
   * no fim do funil, atras de Purchase. A etapa entra logo depois da ultima
   * etapa persistida que a precede na ordem canonica do catalogo; a
   * renormalizacao final converte a fracao em inteiro.
   */
  private canonicalPosition(
    eventName: string,
    persistedStages: PersistedFunnelStage[]
  ): number {
    const order = conversionEventCatalogOrder(eventName);
    const anchor = persistedStages
      .filter((stage) => conversionEventCatalogOrder(stage.eventName) < order)
      .reduce((highest, stage) => Math.max(highest, stage.position), 0);

    return anchor + 0.5;
  }

  async updateConfiguration(
    workspaceId: string,
    input: FunnelConfigurationUpdateInputDto,
    actorUserId?: string | null
  ): Promise<FunnelConfigurationDto> {
    const normalizedStages = [...input.stages]
      .map((stage, index) => ({ stage, index }))
      .sort(
        (left, right) =>
          left.stage.position - right.stage.position || left.index - right.index
      )
      .map(({ stage }, index) => ({ ...stage, position: index + 1 }));

    await this.prisma.$transaction(async (transaction) => {
      await transaction.funnelStageConfiguration.deleteMany({
        where: { workspaceId }
      });

      if (normalizedStages.length > 0) {
        await transaction.funnelStageConfiguration.createMany({
          data: normalizedStages.map((stage) => ({
            workspaceId,
            eventName: stage.eventName,
            label: stage.label,
            position: stage.position,
            visible: stage.visible,
            defaultValueCents: stage.defaultValueCents ?? null,
            defaultCurrency: stage.defaultCurrency ?? null,
            defaultContentName: stage.defaultContentName ?? null
          }))
        });
      }
    });

    await this.recordAudit({
      workspaceId,
      actorUserId: actorUserId ?? null,
      stages: normalizedStages
    });

    return { stages: normalizedStages };
  }

  private async recordAudit(input: {
    workspaceId: string;
    actorUserId: string | null;
    stages: FunnelStageConfigurationDto[];
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          actorType: input.actorUserId ? "user" : "system",
          action: "funnel_configuration.updated",
          targetType: "Workspace",
          targetId: input.workspaceId,
          reason: null,
          sourceIp: null,
          resultStatus: "success",
          beforeSummary: undefined,
          afterSummary: {
            stages: input.stages.map((stage) => ({
              eventName: stage.eventName,
              label: stage.label,
              position: stage.position,
              visible: stage.visible,
              valueConfigured: stage.defaultValueCents != null,
              currency: stage.defaultCurrency ?? null,
              contentName: stage.defaultContentName ?? null
            }))
          } as Prisma.InputJsonValue
        }
      });
    } catch {
      return;
    }
  }
}
