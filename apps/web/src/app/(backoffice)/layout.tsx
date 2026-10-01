import type { ReactNode } from "react";
import { BackofficeStatusBanners } from "../../components/backoffice-status-banners";
import { BrandFooter } from "../../components/brand-footer";
import { getBrandConfig } from "../../lib/brand";

/**
 * Backoffice pages render standalone (no AppShell sidebar), so this layout
 * is the single mount point for the residual whitelabel footer (F6.2) —
 * every /backoffice/* page gets it without repeating it per page. It is also
 * the only place the owner-only template version banner is mounted, so the
 * workspace product (/overview etc.) never renders or fetches it.
 */
export default function BackofficeLayout({
  children,
}: {
  children: ReactNode;
}) {
  const brand = getBrandConfig();

  return (
    <>
      <BackofficeStatusBanners />
      {children}
      <BrandFooter brand={brand} className="standalone-footer" />
    </>
  );
}
