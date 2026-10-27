/**
 * Helpers for Meta CDN (fbcdn / cdninstagram) image URLs.
 *
 * Meta signs these URLs and embeds the expiry as a hex unix timestamp in the
 * `oe` query parameter (e.g. `oe=6720A1B3`). After that instant the CDN
 * answers 403 "URL signature expired", which is why storing the bare URL is
 * not enough to keep a thumbnail visible.
 */

const META_CDN_HOST_SUFFIXES = [
  ".fbcdn.net",
  ".cdninstagram.com",
  ".facebook.com",
  ".fbsbx.com",
] as const;

export function isMetaCdnHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  return META_CDN_HOST_SUFFIXES.some(
    (suffix) => host.endsWith(suffix) || host === suffix.slice(1),
  );
}

/** Expiry encoded in the `oe` hex param, or null when absent/unparseable. */
export function metaCdnUrlExpiresAt(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const oe = url.searchParams.get("oe");

  if (!oe || !/^[0-9a-f]{6,12}$/iu.test(oe)) {
    return null;
  }

  const seconds = Number.parseInt(oe, 16);

  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000)
    : null;
}

/**
 * Returns the URL when it is an http(s) URL that is not a known-expired
 * signed Meta CDN URL; otherwise null. URLs without `oe` are kept (unknown
 * expiry), so non-Meta CTWA thumbnails keep working.
 */
export function liveHttpUrl(
  value: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!value) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  const expiresAt = metaCdnUrlExpiresAt(value);

  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  return url.toString();
}
