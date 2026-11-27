/** Response shape shared by `POST /license/activate` and `POST /license/heartbeat`. */
export interface LicenseActionResult {
  status: "active" | "grace" | "blocked";
  softLock: boolean;
  hardLock: boolean;
  usable: boolean;
  expiresAt: string | null;
  validUntil: string;
  cacheToken: string;
  bound: boolean;
  keyPrefix: string;
  /**
   * Subscription period of the license (e.g. "annual"/"monthly"), when the
   * license server reports it. Optional: older servers omit the field and the
   * client simply has no interval to show.
   */
  interval?: string | null;
}

/** Response shape of `GET /license/public-key`. */
export interface LicensePublicKeyResult {
  alg: string;
  publicKey: string;
}

/**
 * Why writes are locked. The first two cover an install that never reached a
 * valid activation (hard-lock); "revoked"/"expired" cover a license that was
 * activated and later stopped being valid. "grace_exceeded" is no longer
 * produced (a license server outage never locks); it stays in the union so
 * older UI builds that still know it keep working.
 */
export type LicenseLockReason =
  | "license_required"
  | "activation_failed"
  | "revoked"
  | "expired"
  | "grace_exceeded";

/** Locally-derived runtime state, as returned by LicenseClientService.getState(). */
export interface LicenseRuntimeState {
  status: "active" | "grace" | "blocked" | "unlicensed";
  softLock: boolean;
  hardLock: boolean;
  usable: boolean;
  expiresAt: string | null;
  validUntil: string | null;
  source: "cache" | "server";
  /** Set whenever writes are locked ("blocked" or never-activated); null otherwise. */
  reason: LicenseLockReason | null;
  /** Subscription period reported by the license server, when known. */
  interval: string | null;
  /** Last successful, verified contact with the license server (ISO), when any. */
  lastCheckedAt: string | null;
  /**
   * True when the latest attempt to reach the license server failed or the
   * cached confirmation is stale. Informational only — never locks by itself.
   */
  serverUnreachable: boolean;
}

/**
 * Write-gate verdict shared by the soft-lock guard and the public status
 * endpoint: may this install mutate data, and if not, why.
 */
export interface LicenseLockState {
  /** True only when LICENSE_SERVER_URL is unset — licensing is entirely off. */
  inert: boolean;
  locked: boolean;
  reason: LicenseLockReason | null;
  state: LicenseRuntimeState;
}
