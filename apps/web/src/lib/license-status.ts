import { apiBaseUrl } from "./api";

export type LicenseStatus = "active" | "grace" | "blocked" | "unlicensed";

/** Mirrors LicenseLockReason in apps/api/src/licensing-client/license-client.types.ts. */
export type LicenseLockReason =
  | "license_required"
  | "activation_failed"
  | "revoked"
  | "expired"
  | "grace_exceeded";

export type LicenseStatusResponse = {
  status: LicenseStatus;
  softLock: boolean;
  hardLock: boolean;
  usable: boolean;
  expiresAt: string | null;
  validUntil: string | null;
  source: "cache" | "server";
  /**
   * True when the API is refusing writes. Optional so an older API build
   * (before the license hard-lock) still parses — treated as "not locked".
   */
  locked?: boolean;
  lockReason?: LicenseLockReason | null;
  /** Subscription period reported by the license server, when it sends one. */
  interval?: string | null;
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

const BLOCKED_DETAIL =
  "Licença bloqueada — operações de escrita desativadas. Contate o suporte / reative.";

/** pt-BR copy for each lock reason, shared by the banner and the license page. */
export const licenseLockCopy: Record<
  LicenseLockReason,
  { title: string; detail: string }
> = {
  license_required: {
    title: "Licença não ativada",
    detail:
      "As operações de escrita estão bloqueadas até a ativação. Preencha LICENSE_KEY e LICENSE_ACCOUNT_IDENTITY no .env da API, reinicie a API e ative a licença.",
  },
  activation_failed: {
    title: "Falha ao ativar a licença",
    detail:
      "A última tentativa de ativação não foi concluída. Confira LICENSE_KEY e LICENSE_ACCOUNT_IDENTITY (o e-mail vinculado à compra) e ative novamente.",
  },
  revoked: { title: "Licença bloqueada", detail: BLOCKED_DETAIL },
  expired: { title: "Licença bloqueada", detail: BLOCKED_DETAIL },
  grace_exceeded: { title: "Licença bloqueada", detail: BLOCKED_DETAIL },
};

/**
 * Why writes are locked, or null when they are not. Falls back to "revoked"
 * for a blocked status reported by an API build that predates `lockReason`.
 */
export function licenseLockReason(
  status: LicenseStatusResponse,
): LicenseLockReason | null {
  if (status.locked) {
    return status.lockReason ?? "revoked";
  }

  return status.status === "blocked" ? "revoked" : null;
}

/** True while the instance still has to activate a license to unlock writes. */
export function needsLicenseActivation(
  status: LicenseStatusResponse,
): boolean {
  const reason = licenseLockReason(status);

  return reason === "license_required" || reason === "activation_failed";
}

const INTERVAL_LABELS: Record<string, string> = {
  annual: "Anual",
  yearly: "Anual",
  semiannual: "Semestral",
  quarterly: "Trimestral",
  monthly: "Mensal",
  lifetime: "Vitalícia",
  trial: "Teste",
  trialing: "Teste",
};

/**
 * Human label for the license period. The license server only reports the
 * interval on some responses, so fall back to a generic "Assinatura" whenever
 * there is an expiration date but no interval to name it.
 */
export function licenseIntervalLabel(status: LicenseStatusResponse): string {
  if (status.interval) {
    return INTERVAL_LABELS[status.interval] ?? status.interval;
  }

  return status.expiresAt ? "Assinatura" : "—";
}
