import type { PrismaService } from "../common/prisma/prisma.service";

/**
 * Events recognized by a provider rule in observation (any provider: Umbler,
 * Unnichat, GoHighLevel, Webhook / n8n, XMAX, Payt...). The source of truth
 * is the rule execution the orchestrator already stores with status
 * "observed" for the matched paid lead: nothing is copied into
 * ConversionEventLog, so the Meta queue, the lifetime lock, the dedupe and
 * the reports (which read only ConversionEventLog) never see them.
 *
 * The lead page, Leads and the CRM read them to show the flow as it would be
 * in production, with the mark "Em observação". When the same occurrence is
 * later sent in production, the orchestrator upserts that same execution
 * (eligible -> materialized): it stops being "observed" and the real log
 * takes its place, so nothing is counted twice. Observed executions of other
 * occurrences stay visible as test history until deleted.
 */
export type ObservedLeadConversion = {
  executionId: string;
  leadId: string;
  eventName: string;
  occurredAt: Date;
  createdAt: Date;
  valueCents: number | null;
  currency: string | null;
  /** Same format as the production log: inbound_webhook:<provider>:<trigger>. */
  sourceTrigger: string;
};

type ExecutionRow = {
  id: string;
  leadId: string | null;
  occurredAt: Date;
  createdAt: Date;
  valueCents: number | null;
  currency: string | null;
  providerDecision: { eventName: string } | null;
  providerRule: {
    conversionRule: { eventName: string; triggerType: string } | null;
    parserRelease: { provider: string } | null;
    connection: { provider: string } | null;
  } | null;
};

export async function loadObservedLeadConversions(
  prisma: Pick<PrismaService, "providerConversionRuleExecution">,
  workspaceId: string,
  leadIds: string[],
): Promise<ObservedLeadConversion[]> {
  // Older test doubles of Prisma have no execution model: nothing observed.
  if (leadIds.length === 0 || !prisma.providerConversionRuleExecution) {
    return [];
  }
  const rows = (await prisma.providerConversionRuleExecution.findMany({
    where: { workspaceId, status: "observed", leadId: { in: leadIds } },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      leadId: true,
      occurredAt: true,
      createdAt: true,
      valueCents: true,
      currency: true,
      providerDecision: { select: { eventName: true } },
      providerRule: {
        select: {
          conversionRule: { select: { eventName: true, triggerType: true } },
          parserRelease: { select: { provider: true } },
          connection: { select: { provider: true } },
        },
      },
    },
  })) as unknown as ExecutionRow[] | undefined;

  return (rows ?? []).flatMap((row) => {
    const eventName =
      row.providerDecision?.eventName ??
      row.providerRule?.conversionRule?.eventName;
    if (!row.leadId || !eventName) return [];
    const provider =
      row.providerRule?.parserRelease?.provider ??
      row.providerRule?.connection?.provider ??
      "provider";
    const trigger =
      row.providerRule?.conversionRule?.triggerType ?? "provider_automation";
    return [
      {
        executionId: row.id,
        leadId: row.leadId,
        eventName,
        occurredAt: row.occurredAt,
        createdAt: row.createdAt,
        valueCents: row.valueCents,
        currency: row.currency,
        sourceTrigger: `inbound_webhook:${provider}:${trigger}`,
      },
    ];
  });
}
