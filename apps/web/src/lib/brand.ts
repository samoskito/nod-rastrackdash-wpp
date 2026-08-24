const DEFAULT_NAME = "RastrackDash";
const DEFAULT_PRIMARY_COLOR = "#0F766E";

const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export type BrandConfig = {
  name: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string;
};

/**
 * Safe defaults used whenever env vars are unset, empty, or invalid. Also
 * exported for callers (e.g. the client app shell) that need a fallback
 * value without touching `process.env` themselves.
 */
export const defaultBrandConfig: BrandConfig = {
  name: DEFAULT_NAME,
  logoUrl: null,
  faviconUrl: null,
  primaryColor: DEFAULT_PRIMARY_COLOR,
};

export function isValidHexColor(value: string): boolean {
  return HEX_COLOR_PATTERN.test(value.trim());
}

function trimmedOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Env-driven whitelabel config for the student agency (F6.2). Reads
 * `BRAND_NAME` / `BRAND_LOGO_URL` / `BRAND_FAVICON_URL` /
 * `BRAND_PRIMARY_COLOR` and never throws — any missing or invalid value
 * falls back to `defaultBrandConfig`. This is intentionally the only
 * whitelabel surface: it never controls whether the RastrackDash + powered
 * by PalmUP residual footer renders (see `BrandFooter`), which is not
 * configurable.
 */
export function getBrandConfig(): BrandConfig {
  try {
    const name = trimmedOrNull(process.env.BRAND_NAME) ?? DEFAULT_NAME;
    const rawColor = process.env.BRAND_PRIMARY_COLOR?.trim();
    const primaryColor =
      rawColor && isValidHexColor(rawColor) ? rawColor : DEFAULT_PRIMARY_COLOR;

    return {
      name,
      logoUrl: trimmedOrNull(process.env.BRAND_LOGO_URL),
      faviconUrl: trimmedOrNull(process.env.BRAND_FAVICON_URL),
      primaryColor,
    };
  } catch {
    return { ...defaultBrandConfig };
  }
}
