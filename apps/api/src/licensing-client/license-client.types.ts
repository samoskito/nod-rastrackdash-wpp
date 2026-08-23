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
}

/** Response shape of `GET /license/public-key`. */
export interface LicensePublicKeyResult {
  alg: string;
  publicKey: string;
}

/** Locally-derived runtime state, as returned by LicenseClientService.getState(). */
export interface LicenseRuntimeState {
  status: "active" | "grace" | "blocked" | "unlicensed";
  softLock: boolean;
  hardLock: boolean;
  usable: boolean;
  expiresAt: string | null;
  validUntil: string | null;
  source: "cache" | "server";
}
