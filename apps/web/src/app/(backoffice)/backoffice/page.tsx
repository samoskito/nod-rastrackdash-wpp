import { BackofficeHome } from "../../../components/backoffice-home";
import { getOnboardingStatus } from "../../../lib/onboarding-status";

/**
 * Student-edition backoffice home (F6.1). Billing / PalmUP multi-tenant
 * operations surfaces were removed from navigation; this page only links
 * student-relevant areas (clients, webhooks, read-only license). F6.3 adds
 * the onboarding checklist — server-fetched, soft/non-blocking.
 */
export default async function BackofficePage() {
  const onboarding = await getOnboardingStatus();

  return <BackofficeHome onboarding={onboarding} />;
}
