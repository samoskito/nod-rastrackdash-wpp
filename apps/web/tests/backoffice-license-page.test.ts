import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import LicensePage from "../src/app/(backoffice)/backoffice/license/page";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("backoffice license page", () => {
  it("renders the read-only license fields when active", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        status: "active",
        softLock: false,
        hardLock: false,
        usable: true,
        expiresAt: "2027-01-01T00:00:00.000Z",
        validUntil: null,
        source: "server",
      }),
    );

    const element = await LicensePage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Licença");
    expect(html).toContain("Ativa");
    expect(html).toContain("Servidor de licenciamento");
    expect(html).not.toContain("LICENSE_KEY");
  });

  it("shows the grace-period tolerance window", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        status: "grace",
        softLock: true,
        hardLock: false,
        usable: true,
        expiresAt: "2026-06-01T00:00:00.000Z",
        validUntil: "2026-06-15T00:00:00.000Z",
        source: "cache",
      }),
    );

    const element = await LicensePage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("tolerância");
    expect(html).toContain("Cache local");
  });

  it("shows a configuration CTA without secrets when unlicensed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        status: "unlicensed",
        softLock: true,
        hardLock: true,
        usable: false,
        expiresAt: null,
        validUntil: null,
        source: "cache",
      }),
    );

    const element = await LicensePage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("LICENSE_KEY");
    expect(html).toContain("LICENSE_ACCOUNT_IDENTITY");
    expect(html).toContain(".env");
    expect(html).not.toMatch(/lic_[a-zA-Z0-9]/);
  });

  it("shows an unavailable state when the status endpoint cannot be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("network unreachable"),
    );

    const element = await LicensePage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Não foi possível carregar o status da licença");
  });
});
