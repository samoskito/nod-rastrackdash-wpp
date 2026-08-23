/** Singleton row id for the LicenseState table — this module only ever tracks one deploy. */
export const LICENSE_STATE_ID = "singleton";

/** Public PalmUP license server for the RastrackDash student edition. */
export const DEFAULT_LICENSE_SERVER_URL = "https://wpptrack-api.rastrack.app";

/** How often the scheduler re-confirms the license with the server. */
export const LICENSE_HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Fail-open window: how long we tolerate the server being unreachable before hard-blocking. */
export const LICENSE_GRACE_WINDOW_MS = 72 * 60 * 60 * 1000;

export const LICENSE_HEARTBEAT_QUEUE = "license-heartbeat";
export const LICENSE_HEARTBEAT_JOB_NAME = "license-heartbeat-tick";
