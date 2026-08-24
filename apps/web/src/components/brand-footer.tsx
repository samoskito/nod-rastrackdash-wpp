import type { BrandConfig } from "../lib/brand";

/**
 * Single source of truth for the residual whitelabel footer (F6.2). The
 * `RastrackDash · powered by PalmUP` residual is NOT configurable — there is
 * no prop to hide or replace it, and it is never gated behind an env var.
 * Mounted in the app shell sidebar, the login page, and the backoffice
 * layout so no surface is brand-orphaned.
 */
export function BrandFooter({
  brand,
  className,
}: {
  brand: BrandConfig;
  className?: string;
}) {
  const residual =
    brand.name === "RastrackDash"
      ? "RastrackDash · powered by PalmUP"
      : `${brand.name} · RastrackDash · powered by PalmUP`;

  return (
    <footer className={["brand-footer", className].filter(Boolean).join(" ")}>
      <span className="brand-footer-label">{residual}</span>
    </footer>
  );
}
