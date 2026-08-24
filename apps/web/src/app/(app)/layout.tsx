import { Suspense, type ReactNode } from "react";
import { AppShell } from "../../components/app-shell";
import { LicenseStatusBanner } from "../../components/license-status-banner";
import { WorkspaceAccessGate } from "../../components/workspace-access-gate";
import { getBrandConfig } from "../../lib/brand";
import ProductRouteLoading from "./loading";

export default function ProductLayout({ children }: { children: ReactNode }) {
  const brand = getBrandConfig();

  return (
    <>
      <LicenseStatusBanner />
      <Suspense
        fallback={
          <AppShell workspace={null} brand={brand}>
            <ProductRouteLoading />
          </AppShell>
        }
      >
        <WorkspaceAccessGate>{children}</WorkspaceAccessGate>
      </Suspense>
    </>
  );
}
