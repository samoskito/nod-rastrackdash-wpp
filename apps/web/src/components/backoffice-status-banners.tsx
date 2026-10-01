import { headers } from "next/headers";
import { LicenseStatusBanner } from "./license-status-banner";
import { TemplateVersionBanner } from "./template-version-banner";

const LICENSE_PAGE = "/backoffice/license";

/**
 * Stacked status region above every /backoffice page: the license banner
 * (same component the product shell uses) followed by the owner-only template
 * version banner. The license page already explains the lock in full, so the
 * license banner is skipped there instead of repeating itself. The region
 * collapses (`:empty`) when neither banner has anything to say.
 */
export async function BackofficeStatusBanners() {
  const pathname = await getRequestPathname();

  return (
    <div className="backoffice-status-banners">
      {pathname === LICENSE_PAGE ? null : <LicenseStatusBanner />}
      <TemplateVersionBanner />
    </div>
  );
}

async function getRequestPathname(): Promise<string | null> {
  try {
    const requestHeaders = await headers();
    return requestHeaders.get("x-wpptrack-pathname");
  } catch {
    return null;
  }
}
