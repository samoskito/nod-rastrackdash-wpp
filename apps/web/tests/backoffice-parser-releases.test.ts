import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { isApiRequestError, serverApiFetch } = vi.hoisted(() => ({
  isApiRequestError: vi.fn(
    (error: unknown) =>
      typeof error === "object" && error !== null && "status" in error,
  ),
  serverApiFetch: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({ isApiRequestError, serverApiFetch }));

import ParserReleasesPage from "../src/app/(backoffice)/backoffice/inbound-webhooks/parsers/page";
import {
  parserProviderLabels,
  parserStatusLabel,
} from "../src/app/(backoffice)/backoffice/inbound-webhooks/parsers/parsers-copy";

/**
 * Fase 6.5 — "Leitores de webhook" (porte só de leitura do SaaS b4d71afc):
 * a support diagnostic. Readers arrive with the updates (production direct);
 * there is nothing to certify or release on this screen.
 */

afterEach(() => vi.clearAllMocks());

const at = "2026-10-27T14:01:00.000Z";

describe("Leitores de webhook (read only)", () => {
  it("lists the readers with a plain state, Braip in use", async () => {
    serverApiFetch.mockResolvedValueOnce({
      releases: [
        { id: "inbound_parser_braip_automation_v1", provider: "braip", version: "automation-v1", status: "certified", certifiedAt: at, createdAt: at, updatedAt: at },
        { id: "old", provider: "umbler", version: "v0", status: "retired", certifiedAt: null, createdAt: at, updatedAt: at },
      ],
    });
    const html = renderToStaticMarkup(await ParserReleasesPage());
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/backoffice/inbound-webhooks/parser-releases",
    );
    expect(html).toContain("Leitores de webhook");
    expect(html).toContain("Braip");
    expect(html).toContain("Em uso");
    expect(html).toContain("Retirado");
    expect(html).not.toContain("<button");
    expect(html).not.toMatch(/certifica|liberar|observa[cç]/iu);
  });

  it("shows the restricted-area notice for non admins", async () => {
    serverApiFetch.mockRejectedValueOnce({ status: 403 });
    const html = renderToStaticMarkup(await ParserReleasesPage());
    expect(html).toContain("Área restrita aos administradores da plataforma");
  });

  it("labels every provider of the edition, without certification jargon", () => {
    expect(parserProviderLabels.braip).toBe("Braip");
    expect(parserStatusLabel("certified").label).toBe("Em uso");
    expect(parserStatusLabel("observation_only").label).toBe("Não usado para envio");
    for (const status of ["certified", "observation_only", "retired"] as const) {
      expect(parserStatusLabel(status).label).not.toMatch(/certifica|observa/iu);
    }
  });
});
