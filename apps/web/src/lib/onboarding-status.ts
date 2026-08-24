import { serverApiFetch } from "./server-api";

export type OnboardingChecks = {
  database: boolean;
  licenseActive: boolean;
  metaConnected: boolean;
  hasWorkspace: boolean;
};

export type OnboardingStatusResponse = {
  checks: OnboardingChecks;
  completedCount: number;
  totalCount: number;
};

/**
 * Auth-required onboarding checklist (F6.3) — real signals from the API
 * (database reachability, license usability, Meta connection, workspace
 * membership). Returns null on any fetch/parse failure (e.g. no session
 * yet) so callers can render a soft "unavailable" state; this never blocks
 * the app.
 */
export async function getOnboardingStatus(): Promise<OnboardingStatusResponse | null> {
  try {
    return await serverApiFetch<OnboardingStatusResponse>("/onboarding/status");
  } catch {
    return null;
  }
}
