import type { ReportDailyComparisonPointDto } from "@wpptrack/shared";

/**
 * Conciliação diária, like for like: the conversations started that Meta
 * reports vs the real ones (every paid conversation that arrived that day,
 * same rule as "Conversas por anúncio"). The Lead event series exists only
 * when the Lead is sent later than the entry (rule override mode of the
 * period); with the Lead sent at the entry it would only repeat the
 * conversations, so it is left out.
 */
export function dailyComparisonSeries(
  points: ReportDailyComparisonPointDto[],
  leadEventDeferred: boolean,
) {
  const rows = points.map((point) => ({
    date: point.date,
    meta: point.metaConversationsStarted,
    // An API without the field: closest available number (novos + retornos).
    conversations:
      point.adConversationsStarted ??
      point.realConversations + (point.returningLeads ?? 0),
    leads: point.realConversations,
  }));
  const sum = (pick: (row: (typeof rows)[number]) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);
  const metaTotal = sum((row) => row.meta);
  const conversationsTotal = sum((row) => row.conversations);

  return {
    rows,
    showLeads: leadEventDeferred,
    metaTotal,
    conversationsTotal,
    leadsTotal: sum((row) => row.leads),
    /** "N conversas a mais na Meta": Meta minus conversas iniciadas reais. */
    difference: metaTotal - conversationsTotal,
  };
}
