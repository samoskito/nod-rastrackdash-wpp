import { apiBaseUrl } from "./api";

export type LicenseStatus = "active" | "grace" | "blocked" | "unlicensed";

export type LicenseStatusResponse = {
  status: LicenseStatus;
  softLock: boolean;
  hardLock: boolean;
  usable: boolean;
  expiresAt: string | null;
  validUntil: string | null;
  source: "cache" | "server";
};

/**
 * Public (no-auth) license status check — coarse status only, no key
 * material or account identity. Returns null on any fetch/parse failure so
 * callers can fail open/closed as appropriate for their context.
 */
export async function fetchLicenseStatus(): Promise<LicenseStatusResponse | null> {
  try {
    const response = await fetch(`${apiBaseUrl}/license-client/status`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as LicenseStatusResponse;
  } catch {
    return null;
  }
}
