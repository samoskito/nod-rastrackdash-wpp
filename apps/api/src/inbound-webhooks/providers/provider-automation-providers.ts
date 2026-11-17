/**
 * Automations whose callback carries the CTWA click (ctwa_clid) of the
 * contact's entry: the conversion belongs to the lead of that verified entry
 * (and may use the entry's authorized page/pixel destination when the ad is
 * unknown). Unnichat first; GoHighLevel follows exactly the same model
 * (porte do SaaS e279af76, só a parte do GoHighLevel deste arquivo).
 */
export const ctwaEntryAutomationProviders = ["unnichat", "gohighlevel"] as const;

export function isCtwaEntryAutomationProvider(
  provider: string | null | undefined,
): boolean {
  return (ctwaEntryAutomationProviders as readonly string[]).includes(
    provider ?? "",
  );
}
