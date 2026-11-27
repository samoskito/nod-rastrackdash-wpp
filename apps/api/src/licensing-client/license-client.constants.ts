/** Singleton row id for the LicenseState table — this module only ever tracks one deploy. */
export const LICENSE_STATE_ID = "singleton";

/** Public PalmUP license server for the RastrackDash student edition. */
export const DEFAULT_LICENSE_SERVER_URL = "https://wpptrack-api.rastrack.app";

/** How often a healthy install re-confirms the license with the server. */
export const LICENSE_HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Scheduler tick. On every tick the client checks whether a heartbeat is due:
 * a healthy install still only calls the server every
 * LICENSE_HEARTBEAT_INTERVAL_MS, but after a failed contact it retries on
 * every tick (hourly) so recovery after a license server outage is quick.
 */
export const LICENSE_HEARTBEAT_RETRY_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Minimum time between two background refreshes triggered by the write guard
 * or the status endpoint when the cached confirmation is stale.
 */
export const LICENSE_BACKGROUND_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** Per-request timeout when talking to the license server (a hang counts as unreachable). */
export const LICENSE_SERVER_TIMEOUT_MS = 15_000;

export const LICENSE_HEARTBEAT_QUEUE = "license-heartbeat";
export const LICENSE_HEARTBEAT_JOB_NAME = "license-heartbeat-tick";

/** LICENSE_HEARTBEAT_INTERVAL_MS env override (min 1 minute), falling back to the 6h default. */
export function resolveHeartbeatIntervalMs(env: Record<string, string | undefined>): number {
  const configured = Number(env.LICENSE_HEARTBEAT_INTERVAL_MS ?? LICENSE_HEARTBEAT_INTERVAL_MS);
  return Number.isFinite(configured) && configured >= 60_000 ? configured : LICENSE_HEARTBEAT_INTERVAL_MS;
}
