/**
 * Client-safe helpers for the template version banner (no server imports, so
 * the dismissible notice can use them from the browser bundle).
 */

/**
 * Fixed public guide for updating a live student instance. The API also
 * returns an `updateGuideUrl`, but the banner never renders a provider-supplied
 * link: only this exact URL is ever shown.
 */
export const TEMPLATE_UPDATE_GUIDE_URL =
  "https://github.com/samoskito/nod-rastrackdash-wpp/blob/main/docs/setup/update.md";

/** The API compares full 40-char lowercase commit SHAs; anything else is not a version. */
export function isFullGitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
