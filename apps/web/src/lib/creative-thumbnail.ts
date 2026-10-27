/**
 * Creative thumbnail sources for the web.
 *
 * Persisted thumbnails are served by our API (workspace-scoped) and proxied
 * by the Next route below so the browser sends the session cookie to the
 * same origin. Signed Meta CDN URLs carry their expiry in `oe` (hex unix
 * seconds); an expired one is never rendered.
 */

const AD_ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/u;
const VERSION_PATTERN = /^[0-9a-f]{6,64}$/u;

export function storedCreativeThumbnailSrc(
  adId: string | null | undefined,
  version: string | null | undefined,
): string | null {
  if (!adId || !version) {
    return null;
  }

  if (!AD_ID_PATTERN.test(adId) || !VERSION_PATTERN.test(version)) {
    return null;
  }

  return `/reports/creative-thumbnails/ads/${encodeURIComponent(adId)}?v=${version}`;
}

export function isAllowedCreativeAdId(adId: string): boolean {
  return AD_ID_PATTERN.test(adId);
}

export function liveCreativeImageUrl(
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

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }

  const oe = url.searchParams.get("oe");

  if (oe && /^[0-9a-f]{6,12}$/iu.test(oe)) {
    const expiresAtMs = Number.parseInt(oe, 16) * 1000;

    if (Number.isFinite(expiresAtMs) && expiresAtMs <= now.getTime()) {
      return null;
    }
  }

  return value;
}
