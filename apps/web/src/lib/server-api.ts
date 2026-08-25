import { cookies } from "next/headers";
import { apiBaseUrl } from "./api";
import type { LicenseLockReason } from "./license-status";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const LICENSE_LOCKED_STATUS = 423;

const LICENSE_LOCKED_FALLBACK =
  "Licença não utilizável — operações de escrita bloqueadas. Verifique /backoffice/license.";

/**
 * HTTP 423 from the license guard. Extends ApiRequestError on purpose, so
 * every existing `isApiRequestError(error)` handler keeps working (and keeps
 * showing the API's pt-BR message) while callers that care can branch on the
 * machine-readable reason.
 */
export class LicenseLockedError extends ApiRequestError {
  constructor(
    message: string,
    readonly reason: LicenseLockReason,
  ) {
    super(message, LICENSE_LOCKED_STATUS);
    this.name = "LicenseLockedError";
  }
}

export function isApiRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError;
}

export function isLicenseLockedError(
  error: unknown,
): error is LicenseLockedError {
  return error instanceof LicenseLockedError;
}

export async function serverApiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const startedAt = Date.now();
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  headers["Content-Type"] = headers["Content-Type"] ?? "application/json";

  const cookieHeader = await getCookieHeader();

  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }

  let response: Response;

  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers,
      cache: "no-store",
    });
  } catch (error) {
    logSlowApiRequest(path, Date.now() - startedAt, "network_error");
    throw error;
  }

  logSlowApiRequest(path, Date.now() - startedAt, response.status);

  if (!response.ok) {
    if (response.status === LICENSE_LOCKED_STATUS) {
      throw await licenseLockedError(response);
    }

    throw new ApiRequestError(
      await responseErrorMessage(response),
      response.status,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const body = await response.text();
  return (body.trim() ? JSON.parse(body) : undefined) as T;
}

function logSlowApiRequest(
  path: string,
  durationMs: number,
  status: number | "network_error",
): void {
  const thresholdMs = Number(process.env.WPPTRACK_WEB_SLOW_REQUEST_MS ?? 1500);

  if (!Number.isFinite(thresholdMs) || durationMs < thresholdMs) {
    return;
  }

  console.warn("[wpptrack:web-api] slow request", {
    path,
    status,
    durationMs,
  });
}

async function licenseLockedError(
  response: Response,
): Promise<LicenseLockedError> {
  let reason: LicenseLockReason = "revoked";
  let message = LICENSE_LOCKED_FALLBACK;

  try {
    const body = (await response.json()) as {
      message?: unknown;
      reason?: unknown;
    };

    if (typeof body.message === "string" && body.message.trim()) {
      message = body.message;
    }

    if (typeof body.reason === "string") {
      reason = body.reason as LicenseLockReason;
    }
  } catch {
    // Keep the pt-BR fallback: a 423 without a parsable body is still a lock.
  }

  return new LicenseLockedError(message, reason);
}

async function responseErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };

    if (typeof body.message === "string" && body.message.trim()) {
      return body.message;
    }
  } catch {
    return `API request failed: ${response.status}`;
  }

  return `API request failed: ${response.status}`;
}

async function getCookieHeader(): Promise<string | undefined> {
  try {
    const cookieStore = await cookies();
    const value = cookieStore.toString();

    return value || undefined;
  } catch {
    return undefined;
  }
}
