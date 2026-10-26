import { providerConversionRuleCapabilitiesSchema } from "@wpptrack/shared";
import { serverApiFetch } from "./server-api";

/**
 * Porte do SaaS #155: whether the API has LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED on (default on).
 * Read from the provider-rules capabilities; any failure (rules disabled,
 * older API, network) answers false, so screens keep today's copy.
 */
export async function getLeadSubmittedOverrideEnabled(): Promise<boolean> {
  try {
    const capabilities = providerConversionRuleCapabilitiesSchema.safeParse(
      await serverApiFetch<unknown>("/conversion-rules/providers/capabilities"),
    );

    return (
      capabilities.success &&
      capabilities.data.leadSubmittedRuleOverrideEnabled === true
    );
  } catch {
    return false;
  }
}
