import type { Prisma } from "@prisma/client";

/**
 * Umbler/Unnichat rules "todas as conexoes" keep a connection only as the anchor
 * that stores their deliveries and owns their per-rule URL (the scope spans
 * every connection of the provider). When that connection is removed (the
 * customer deleted the number), the rule would stop receiving everything,
 * including callbacks of the OTHER numbers through the per-event URL. So,
 * in the same transaction as the removal, such a rule moves to another live
 * connection of the same provider (production first, then the oldest).
 *
 * Nothing is deleted: history (deliveries, decisions, executions) stays
 * where it is and an audit row records the move. Without another live
 * connection the rule is left untouched and the screen shows it as
 * "Número removido". Rules for specific numbers are never moved.
 */

export const PROVIDER_RULE_REANCHORED_ACTION =
  "provider_conversion_rule.reanchored";

const SPANNING_AUTOMATION_PROVIDERS = ["unnichat", "umbler", "roichat"] as const;

type ReanchorClient = Pick<
  Prisma.TransactionClient,
  "providerConversionRuleConfig" | "inboundWebhookConnection" | "auditLog"
>;

export async function reanchorSpanningAutomationRules(
  client: ReanchorClient,
  input: {
    workspaceId: string;
    removedConnectionId: string;
    provider: string;
    actorUserId: string | null;
  },
): Promise<Array<{ providerRuleId: string; connectionId: string }>> {
  if (
    !(SPANNING_AUTOMATION_PROVIDERS as readonly string[]).includes(
      input.provider,
    )
  )
    return [];
  const rules = await client.providerConversionRuleConfig.findMany({
    where: {
      workspaceId: input.workspaceId,
      connectionId: input.removedConnectionId,
      removedAt: null,
      scope: "all_numbers",
      // Only rules "todas as conexoes": a per-connection rule belongs to
      // the removed number and shows "Numero removido" instead.
      crossConnectionScope: true,
      conversionRule: { triggerType: "provider_automation" },
      parserRelease: { is: { provider: input.provider as never } },
    },
    select: { id: true },
    take: 200,
  });
  if (rules.length === 0) return [];

  const candidates = await client.inboundWebhookConnection.findMany({
    where: {
      workspaceId: input.workspaceId,
      provider: input.provider as never,
      id: { not: input.removedConnectionId },
      removedAt: null,
      status: { in: ["observation", "production"] },
    },
    select: { id: true, status: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 50,
  });
  const next =
    candidates.find((candidate) => candidate.status === "production") ??
    candidates[0];
  if (!next) return [];

  const moved: Array<{ providerRuleId: string; connectionId: string }> = [];
  for (const rule of rules) {
    const updated = await client.providerConversionRuleConfig.updateMany({
      where: {
        id: rule.id,
        workspaceId: input.workspaceId,
        connectionId: input.removedConnectionId,
        removedAt: null,
      },
      data: { connectionId: next.id },
    });
    if (updated.count !== 1) continue;
    await client.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        actorType: input.actorUserId ? "user" : "system",
        action: PROVIDER_RULE_REANCHORED_ACTION,
        targetType: "ProviderConversionRuleConfig",
        targetId: rule.id,
        reason: "connection_removed",
        sourceIp: null,
        resultStatus: "moved",
        afterSummary: {
          fromConnectionId: input.removedConnectionId,
          toConnectionId: next.id,
        },
      },
    });
    moved.push({ providerRuleId: rule.id, connectionId: next.id });
  }
  return moved;
}
