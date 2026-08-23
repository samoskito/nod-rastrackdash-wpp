import { apiBaseUrl } from "../lib/api";

type LicenseStatus = "active" | "grace" | "blocked" | "unlicensed";

type LicenseStatusResponse = {
  status: LicenseStatus;
  softLock: boolean;
  hardLock: boolean;
  usable: boolean;
  expiresAt: string | null;
  validUntil: string | null;
  source: "cache" | "server";
};

/**
 * Server component: shows a persistent amber banner during the license
 * grace period, or a red banner once writes are soft-locked. Renders
 * nothing for active/unlicensed(dev) or if the status check itself fails —
 * a status-fetch hiccup should never block the app from rendering.
 * See .claude-task-f4-2-softlock.md #4.
 */
export async function LicenseStatusBanner() {
  const status = await fetchLicenseStatus();

  if (!status || status.status === "active" || status.status === "unlicensed") {
    return null;
  }

  if (status.status === "grace") {
    return (
      <div className="feedback-banner warn" role="status">
        <strong>Licença em período de tolerância</strong>
        <span>Licença em período de tolerância — renovar</span>
      </div>
    );
  }

  return (
    <div className="feedback-banner error" role="alert">
      <strong>Licença bloqueada</strong>
      <span>
        Licença bloqueada — operações de escrita desativadas. Contate o
        suporte / reative.
      </span>
    </div>
  );
}

async function fetchLicenseStatus(): Promise<LicenseStatusResponse | null> {
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
