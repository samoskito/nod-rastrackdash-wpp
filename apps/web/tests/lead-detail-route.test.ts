import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LeadDetailPage from "../src/app/(app)/leads/[leadId]/page";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("lead detail route", () => {
  it("renders lead detail with attribution, conversions and webhook timeline", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          lead: {
            id: "lead_1",
            workspaceId: "workspace_1",
            name: "Mariana Alves",
            phoneDisplay: "+55 11 99999-1020",
            phoneHash: "phone_hash_1",
            status: "qualified",
            source: "uazapi",
            campaignId: "cmp_1",
            campaignName: "Black Friday WhatsApp",
            adSetId: "adset_1",
            adId: "ad_1",
            lastEventName: "QualifiedLead",
            firstMessageAt: "2026-07-02T03:00:00.000Z",
            lastMessageAt: "2026-07-02T03:10:00.000Z",
            createdAt: "2026-07-02T03:00:00.000Z",
            updatedAt: "2026-07-02T03:10:00.000Z",
          },
          attribution: {
            campaignName: "Black Friday WhatsApp",
            adSetName: "Publico quente",
            adName: "Criativo WhatsApp",
            creative: {
              thumbnailUrl: "https://cdn.example.test/creative.jpg",
              destinationUrl: "https://www.instagram.com/p/creative/",
              thumbnailVersion: "abcdef0123456789",
            },
          },
          conversionEvents: [
            {
              id: "conversion_1",
              eventName: "QualifiedLead",
              status: "sent",
              sourceTrigger: "keyword",
              pixelId: "pixel_1",
              campaignId: "cmp_1",
              adSetId: "adset_1",
              adId: "ad_1",
              errorCode: null,
              errorMessage: null,
              occurredAt: "2026-07-02T03:11:00.000Z",
              sentAt: "2026-07-02T03:13:00.000Z",
              createdAt: "2026-07-02T03:12:00.000Z",
            },
          ],
          webhookEvents: [
            {
              id: "webhook_1",
              source: "uazapi",
              eventType: "message",
              status: "processed",
              errorCode: null,
              errorMessage: null,
              receivedAt: "2026-07-02T03:01:00.000Z",
              processedAt: "2026-07-02T03:01:01.000Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await LeadDetailPage({
      params: Promise.resolve({ leadId: "lead_1" }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/leads/lead_1",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).toContain("Mariana Alves");
    expect(html).toContain("+55 11 99999-1020");
    expect(html).toContain("02/07, 00:00");
    expect(html).toContain("Black Friday WhatsApp");
    expect(html).toContain("Publico quente");
    expect(html).toContain("Criativo WhatsApp");
    expect(html).toContain("Atribuição");
    // The persisted thumbnail (same-origin, versioned) is rendered first.
    expect(html).toContain(
      "/reports/creative-thumbnails/ads/ad_1?v=abcdef0123456789",
    );
    expect(html).not.toContain("Miniatura indisponível");
    expect(html).toContain("Ver no Instagram");
    expect(html).toContain("https://www.instagram.com/p/creative/");
    expect(html).toContain("QualifiedLead");
    expect(html).toContain("Lead qualificado");
    expect(html).toContain("Palavra-chave");
    expect(html).toContain("Enviado");
    expect(html).toContain("Ocorrido em");
    expect(html).toContain("Webhooks e diagnósticos vinculados");
    expect(html).toContain("Webhook NOD API");
    expect(html).toContain('class="lead-detail-mobile-list"');
    expect(html).toContain("webhook_1");
  });

  it("renders an unavailable state without fake lead data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const element = await LeadDetailPage({
      params: Promise.resolve({ leadId: "lead_missing" }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Não foi possível carregar o lead");
    expect(html).toContain("API indisponível");
    expect(html).not.toContain("Mariana Alves");
    expect(html).not.toContain("Rafael Costa");
  });
});
