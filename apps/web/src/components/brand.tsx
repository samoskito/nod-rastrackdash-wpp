import { defaultBrandConfig, type BrandConfig } from "../lib/brand";

/*
 * RastrackDash brand: the green "R" symbol and the "RASTRACK DASH / WPP"
 * wordmark. A student's whitelabel (BRAND_NAME / BRAND_LOGO_URL) replaces them
 * here, in one place. The residual "RastrackDash · powered by PalmUP" footer
 * is NOT part of this file: it lives in brand-footer.tsx and is never
 * configurable. Only visible branding lives here; internal identifiers
 * (wpptrack_* cookies, WPPTRACK_* variables, @wpptrack packages) keep their
 * names.
 */

function isDefaultBrand(brand: BrandConfig): boolean {
  return brand.name === defaultBrandConfig.name;
}

/** Two-part "R" from the RastrackDash logo, lime-to-green gradient. */
export function BrandSymbol({
  gradientId = "rastrackdash-r",
  className,
}: {
  /** Must be unique per page when the symbol renders more than once. */
  gradientId?: string;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#d4ff3f" />
          <stop offset="0.55" stopColor="#3cf06c" />
          <stop offset="1" stopColor="#12c25a" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientId})`}
        d="M14 10H62C81 10 91 22 91 36C91 47 84 55 73 58L92 90H70L52 60L50 46H62C67 46 70 42 70 36C70 31 67 28 62 28H26Z"
      />
      <path fill={`url(#${gradientId})`} d="M6 34H27L51 72H30Z" />
    </svg>
  );
}

/**
 * Square brand tile used by the shell and the standalone pages: the student's
 * logo when set, the first letter of a custom name, otherwise the "R" symbol.
 */
export function BrandMark({
  brand = defaultBrandConfig,
  gradientId,
}: {
  brand?: BrandConfig;
  gradientId?: string;
}) {
  if (brand.logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary
    // student-provided logo URL, outside next/image's static domain config.
    return <img className="brand-mark brand-mark-logo" src={brand.logoUrl} alt="" />;
  }

  if (!isDefaultBrand(brand)) {
    return (
      <span className="brand-mark brand-mark-letter" aria-hidden="true">
        {brand.name.trim().charAt(0).toUpperCase() || "R"}
      </span>
    );
  }

  return (
    <span className="brand-mark" aria-hidden="true">
      <BrandSymbol gradientId={gradientId} />
    </span>
  );
}

/** "RASTRACKDASH" with the hatched "WPP" line underneath. */
export function BrandWordmark({ showProduct = true }: { showProduct?: boolean }) {
  return (
    <span className="brand-wordmark">
      <span className="brand-wordmark-name">
        <span className="brand-wordmark-light">RASTRACK</span>
        <span className="brand-wordmark-bold">DASH</span>
      </span>
      {showProduct ? (
        <span className="brand-wordmark-product" aria-hidden="true">
          WPP
        </span>
      ) : null}
    </span>
  );
}

/** The wordmark, or the student's own name when BRAND_NAME is set. */
export function BrandName({ brand = defaultBrandConfig }: { brand?: BrandConfig }) {
  return isDefaultBrand(brand) ? <BrandWordmark /> : <strong>{brand.name}</strong>;
}
