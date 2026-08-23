import { Suspense, type ReactNode } from "react";
import { AppShell } from "../../components/app-shell";
import { LicenseStatusBanner } from "../../components/license-status-banner";
import { WorkspaceAccessGate } from "../../components/workspace-access-gate";
import ProductRouteLoading from "./loading";

export default function ProductLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <LicenseStatusBanner />
      <Suspense
        fallback={
          <AppShell workspace={null}>
            <ProductRouteLoading />
          </AppShell>
        }
      >
        <WorkspaceAccessGate>{children}</WorkspaceAccessGate>
      </Suspense>
    </>
  );
}
