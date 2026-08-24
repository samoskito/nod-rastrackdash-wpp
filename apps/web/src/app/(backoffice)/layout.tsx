import type { ReactNode } from "react";
import { BrandFooter } from "../../components/brand-footer";
import { getBrandConfig } from "../../lib/brand";

/**
 * Backoffice pages render standalone (no AppShell sidebar), so this layout
 * is the single mount point for the residual whitelabel footer (F6.2) —
 * every /backoffice/* page gets it without repeating it per page.
 */
export default function BackofficeLayout({
  children,
}: {
  children: ReactNode;
}) {
  const brand = getBrandConfig();

  return (
    <>
      {children}
      <BrandFooter brand={brand} className="standalone-footer" />
    </>
  );
}
