// Fase 6.3b: ported from the SaaS (#126); the summary is shown for the nod
// Uazapi BYO and WAHA connections (one number each).
import type { WhatsappInstanceActivityDto } from "@wpptrack/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WhatsappInstanceActivitySummary,
  instanceLeadsHref,
  webhookRecency,
  webhookRecencyLabel,
  whatsappInstanceActivityView,
  type WhatsappInstanceActivityView,
} from "../src/app/(app)/integrations/whatsapp-instance-activity";

const checkedAt = new Date("2026-07-18T12:00:00.000Z");
const activity: WhatsappInstanceActivityDto = {
  leads24h: 0,
  leads7d: 3,
  leadsTotal: 12,
  lastLeadAt: "2026-07-15T10:00:00.000Z",
  lastWebhookAt: "2026-07-18T11:00:00.000Z",
};

function viewWith(
  patch: Partial<WhatsappInstanceActivityDto>,
): WhatsappInstanceActivityView {
  return whatsappInstanceActivityView({ ...activity, ...patch }, checkedAt);
}

function renderSummary(view: WhatsappInstanceActivityView | undefined) {
  return renderToStaticMarkup(
    createElement(WhatsappInstanceActivitySummary, {
      view,
      whatsappInstanceId: "wpp_1",
    }),
  );
}

describe("whatsapp instance activity view", () => {
  it("keeps a valid payload with the read time", () => {
    expect(whatsappInstanceActivityView(activity, checkedAt)).toEqual({
      state: "real",
      activity,
      checkedAt: "2026-07-18T12:00:00.000Z",
    });
  });

  it("treats malformed payloads as unavailable, never as zero", () => {
    for (const payload of [
      null,
      undefined,
      "ok",
      {},
      { ...activity, leads24h: -1 },
      { ...activity, leads7d: 1.5 },
      { ...activity, leadsTotal: "12" },
      { ...activity, lastLeadAt: "ontem" },
      { leads24h: 0, leads7d: 0, leadsTotal: 0 },
    ]) {
      expect(whatsappInstanceActivityView(payload, checkedAt)).toEqual({
        state: "unavailable",
      });
    }
  });
});

describe("webhook recency", () => {
  it("is stale only when strictly older than 24h", () => {
    expect(
      webhookRecency(viewWith({ lastWebhookAt: "2026-07-17T12:00:00.000Z" })),
    ).toBe("recent");
    expect(
      webhookRecency(viewWith({ lastWebhookAt: "2026-07-17T11:59:59.999Z" })),
    ).toBe("stale");
    expect(
      webhookRecency(viewWith({ lastWebhookAt: "2026-07-18T11:59:00.000Z" })),
    ).toBe("recent");
  });

  it("separates no webhook from an unavailable read", () => {
    expect(webhookRecency(viewWith({ lastWebhookAt: null }))).toBe("none");
    expect(webhookRecency({ state: "unavailable" })).toBe("unavailable");
    expect(webhookRecency(undefined)).toBe("unavailable");
    expect(webhookRecencyLabel("stale")).toBe(
      "Sem webhook recente há mais de 24h",
    );
    expect(webhookRecencyLabel("none")).toBe("Nenhum webhook registrado");
    expect(webhookRecencyLabel("unavailable")).toBe("Atividade indisponível");
  });
});

describe("whatsapp instance activity summary", () => {
  it("renders real counts, including real zeros", () => {
    const html = renderSummary(viewWith({}));

    expect(html).toContain('data-activity-state="real"');
    expect(html).toContain("<dt>CTWA 24h</dt><dd>0</dd>");
    expect(html).toContain("<dt>CTWA 7 dias</dt><dd>3</dd>");
    expect(html).toContain("<dt>CTWA total</dt><dd>12</dd>");
    expect(html).toContain("Webhook recebido nas últimas 24h");
    expect(html).toContain("Último webhook:");
    expect(html).not.toContain("Nenhum lead registrado");
  });

  it("renders null dates honestly", () => {
    const html = renderSummary(
      viewWith({
        leads24h: 0,
        leads7d: 0,
        leadsTotal: 0,
        lastLeadAt: null,
        lastWebhookAt: null,
      }),
    );

    expect(html).toContain("Nenhum lead registrado");
    expect(html).toContain("Nenhum webhook registrado");
    expect(html).not.toContain("Último webhook:");
    expect(html).not.toContain("Invalid Date");
  });

  it("flags a webhook older than 24h apart from the provider status", () => {
    const html = renderSummary(
      viewWith({ lastWebhookAt: "2026-07-16T08:00:00.000Z" }),
    );

    expect(html).toContain("Sem webhook recente há mais de 24h");
    expect(html).toContain('class="event-chip warn"');
    expect(html).not.toMatch(/conectad|desconectad/i);
  });

  it("renders an unavailable read without counts or a no-webhook claim", () => {
    for (const view of [{ state: "unavailable" } as const, undefined]) {
      const html = renderSummary(view);

      expect(html).toContain('data-activity-state="unavailable"');
      expect(html).toContain("Atividade indisponível");
      expect(html).not.toContain("<dd>");
      expect(html).not.toContain("Nenhum webhook registrado");
      expect(html).not.toContain("Nenhum lead registrado");
      expect(html).toContain('href="/leads?whatsappInstanceId=wpp_1"');
    }
  });

  it("links to the instance leads with no implied period", () => {
    expect(instanceLeadsHref("wpp_1")).toBe("/leads?whatsappInstanceId=wpp_1");
    expect(instanceLeadsHref("wpp 1&x=2")).toBe(
      "/leads?whatsappInstanceId=wpp+1%26x%3D2",
    );

    const html = renderSummary(viewWith({}));

    expect(html).toContain(">Ver leads deste número</a>");
    expect(html).not.toMatch(/href="[^"]*(since|until)=/);
  });
});
