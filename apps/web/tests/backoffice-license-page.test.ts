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
    expect(html).toContain("Última confirmação com o servidor");
    expect(html).not.toContain("LICENSE_KEY");
  });

  it("shows the license interval and expiration date when activated", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        status: "active",
        softLock: false,
        hardLock: false,
        usable: true,
        expiresAt: "2027-06-15T12:00:00.000Z",
        validUntil: null,
        source: "server",
        locked: false,
        lockReason: null,
        interval: "annual",
      }),
    );

    const element = await LicensePage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Tipo de licença");
    expect(html).toContain("Anual");
    expect(html).toContain("Licença válida até");
    expect(html).toContain("15/06/2027");
  });

  it("shows a lifetime license as not expiring instead of the far date", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        status: "active",
        softLock: false,
        hardLock: false,
        usable: true,
        expiresAt: "2099-12-31T23:59:59.000Z",
        validUntil: null,
        source: "server",
        locked: false,
        lockReason: null,
        interval: "lifetime",
      }),
    );

    const element = await LicensePage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Vitalícia");
    expect(html).toContain("Não expira");
    expect(html).not.toContain("2099");
  });

  it("explains how to activate when the instance is locked for lack of a license", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        status: "unlicensed",
        softLock: true,
        hardLock: true,
        usable: false,
        expiresAt: null,
        validUntil: null,
        source: "cache",
        locked: true,
        lockReason: "license_required",
        interval: null,
      }),
    );

    const element = await LicensePage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Licença não ativada");
    expect(html).toContain("escrita");
    expect(html).toContain("LICENSE_KEY");
    expect(html).toContain("LICENSE_ACCOUNT_IDENTITY");
    expect(html).toContain("/license-client/activate");
    expect(html).not.toMatch(/lic_[a-zA-Z0-9]/);
  });

  it("explains how to fix a failed activation attempt", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        status: "unlicensed",
        softLock: true,
        hardLock: true,
        usable: false,
        expiresAt: null,
        validUntil: null,
        source: "cache",
        locked: true,
        lockReason: "activation_failed",
        interval: null,
      }),
    );

    const element = await LicensePage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Falha ao ativar a licença");
    expect(html).toContain("LICENSE_ACCOUNT_IDENTITY");
  });

  it("shows a server-reported grace status without the old tolerance label", async () => {
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
    expect(html).not.toContain("Tolerância até");
    expect(html).not.toContain("Cache local");
  });

  it("shows a license server outage as a working install with a neutral note", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        status: "grace",
        softLock: false,
        hardLock: false,
        usable: true,
        expiresAt: "2027-09-10T12:00:00.000Z",
        validUntil: "2026-11-20T12:00:00.000Z",
        source: "cache",
        locked: false,
        lockReason: null,
        lastCheckedAt: "2026-11-17T12:00:00.000Z",
        serverUnreachable: true,
      }),
    );

    const element = await LicensePage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Licença válida até");
    expect(html).toContain("10/09/2027");
    expect(html).toContain("Última confirmação com o servidor");
    expect(html).toContain("Sem contato com o servidor de licença desde 17/11/2026");
    expect(html).toContain("A instalação continua funcionando.");
    expect(html).toContain("Liberadas");
    expect(html).not.toContain("Bloqueada");
    expect(html).not.toContain("Bloqueio total");
    expect(html).not.toContain("tolerância");
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
