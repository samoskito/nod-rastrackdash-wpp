import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultBrandConfig,
  getBrandConfig,
  isValidHexColor,
} from "../src/lib/brand";

const BRAND_ENV_KEYS = [
  "BRAND_NAME",
  "BRAND_LOGO_URL",
  "BRAND_FAVICON_URL",
  "BRAND_PRIMARY_COLOR",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of BRAND_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of BRAND_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("isValidHexColor", () => {
  it("accepts 6-digit hex colors", () => {
    expect(isValidHexColor("#0F766E")).toBe(true);
  });

  it("accepts 3-digit hex colors", () => {
    expect(isValidHexColor("#0fe")).toBe(true);
  });

  it("rejects non-hex values", () => {
    expect(isValidHexColor("teal")).toBe(false);
    expect(isValidHexColor("0F766E")).toBe(false);
    expect(isValidHexColor("#0F766")).toBe(false);
    expect(isValidHexColor("")).toBe(false);
  });
});

describe("getBrandConfig", () => {
  it("returns the safe defaults when no env vars are set", () => {
    expect(getBrandConfig()).toEqual(defaultBrandConfig);
  });

  it("uses a valid custom hex color", () => {
    process.env.BRAND_PRIMARY_COLOR = "#123ABC";

    expect(getBrandConfig().primaryColor).toBe("#123ABC");
  });

  it("falls back to the default color when the env value is invalid", () => {
    process.env.BRAND_PRIMARY_COLOR = "not-a-color";

    expect(getBrandConfig().primaryColor).toBe(defaultBrandConfig.primaryColor);
  });

  it("trims the configured name", () => {
    process.env.BRAND_NAME = "  Minha Agencia  ";

    expect(getBrandConfig().name).toBe("Minha Agencia");
  });

  it("falls back to RastrackDash when the name is empty or whitespace", () => {
    process.env.BRAND_NAME = "   ";

    expect(getBrandConfig().name).toBe("RastrackDash");
  });

  it("returns null logoUrl/faviconUrl when unset, and trimmed values when set", () => {
    expect(getBrandConfig().logoUrl).toBeNull();
    expect(getBrandConfig().faviconUrl).toBeNull();

    process.env.BRAND_LOGO_URL = "  https://cdn.example.com/logo.svg  ";
    process.env.BRAND_FAVICON_URL = "https://cdn.example.com/favicon.svg";

    const brand = getBrandConfig();
    expect(brand.logoUrl).toBe("https://cdn.example.com/logo.svg");
    expect(brand.faviconUrl).toBe("https://cdn.example.com/favicon.svg");
  });
});
