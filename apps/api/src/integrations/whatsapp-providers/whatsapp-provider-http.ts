import type { RuntimeFetch } from "../../common/runtime/runtime.module";

export const WHATSAPP_PROVIDER_REQUEST_TIMEOUT_MS = 5_000;

/**
 * A BYO provider can legitimately run on an RFC1918 Docker/VPS network, so
 * those addresses remain supported. Loopback, link-local and unspecified
 * destinations are never valid provider endpoints: they are common SSRF
 * pivots and are not needed by the supported deployment topology.
 */
export function normalizeProviderBaseUrl(value: string): string | null {
  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isBlockedProviderHost(url.hostname)
  ) {
    return null;
  }

  return url.toString().replace(/\/$/, "");
}

export async function fetchProviderUrl(
  fetchImpl: RuntimeFetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    WHATSAPP_PROVIDER_REQUEST_TIMEOUT_MS,
  );

  try {
    return await fetchImpl(url, {
      ...init,
      // Do not let a user-controlled BYO endpoint turn a validated request
      // into a request to a different host via an HTTP redirect.
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function providerRequestFailureMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "Provider request timed out";
  }

  return "Provider request failed";
}

function isBlockedProviderHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }

  // Keep the BYO private-network exception limited to IPv4 RFC1918 and
  // internal DNS names. Rejecting literal IPv6 avoids loopback/mapped-IPv4
  // forms that are otherwise easy to miss in string-based validation.
  if (host.includes(":")) {
    return true;
  }

  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/u.test(part))) {
    return false;
  }

  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) {
    return true;
  }

  const [first, second] = octets;
  return (
    first === 0 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}
