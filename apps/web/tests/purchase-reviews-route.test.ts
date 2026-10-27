import type {
  ProviderConversionRuleDto,
  PurchaseReviewDto,
} from "@wpptrack/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PurchaseReviewsPage from "../src/app/(app)/events/purchase-reviews/page";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const purchaseRule: ProviderConversionRuleDto = {
  id: "provider_rule_purchase",
  workspaceId: "workspace_1",
  conversionRule: {
    id: "conversion_rule_purchase",
    workspaceId: "workspace_1",
    name: "Compra com valor medio",
    triggerType: "message_phrase",
    triggerValue: "message_phrase",
    matchMode: "exact",
    eventName: "Purchase",
    pixelId: null,
    defaultValueCents: 29_990,
    defaultCurrency: "BRL",
    defaultContentName: "Pedido medio",
    defaultItems: null,
    active: true,
    createdAt: "2026-07-22T12:00:00.000Z",
    updatedAt: "2026-07-22T12:00:00.000Z",
  },
  connectionId: "connection_1",
  mode: "observation",
  parserReleaseId: "parser_1",
  productionActivatedAt: null,
  channelIds: ["channel_1"],
  triggerPhrases: ["Aviso de compra"],
  messageAuthorScope: "team",
  valueMode: "fixed",
  exampleMessage: null,
  endpoint: null,
  catalog: null,
  lastExecution: null,
  createdAt: "2026-07-22T12:00:00.000Z",
  updatedAt: "2026-07-22T12:00:00.000Z",
};

const leadRule: ProviderConversionRuleDto = {
  ...purchaseRule,
  id: "provider_rule_lead",
  conversionRule: {
    ...purchaseRule.conversionRule,
    id: "conversion_rule_lead",
    name: "Lead qualificado por frase",
    eventName: "QualifiedLead",
  },
};

const review: PurchaseReviewDto = {
  id: "review_1",
  workspaceId: "workspace_1",
  providerRuleId: purchaseRule.id,
  ruleName: purchaseRule.conversionRule.name,
  sourceDeliveryId: "delivery_1",
  channelId: "channel_1",
  channelName: "Comercial",
  occurredAt: "2026-07-22T13:00:00.000Z",
  sourceType: "provider_message",
  messageAuthorType: "team",
  matchedTriggerPhrase: "Aviso de compra",
  status: "recognized",
  classificationCode: "recognized",
  reasonCode: "matched",
  leadId: "lead_1",
  leadName: "Maria Cliente",
  phoneDisplay: "+55 11 99999-0000",
  items: [],
  calculatedValueCents: 29_990,
  effectiveValueCents: 29_990,
  observedPaymentValueCents: null,
  currency: "BRL",
  conversionEventLogId: null,
  decisionReason: null,
  decidedAt: null,
  createdAt: "2026-07-22T13:00:01.000Z",
  updatedAt: "2026-07-22T13:00:01.000Z",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockApi({
  reviews = [review],
  rules = [purchaseRule, leadRule],
  pagination = { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 },
  unavailable = false,
}: {
  reviews?: PurchaseReviewDto[];
  rules?: ProviderConversionRuleDto[];
  pagination?: Record<string, number>;
  unavailable?: boolean;
} = {}) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);

      if (unavailable) {
        return json({ message: "unavailable" }, 503);
      }

      if (url.includes("/purchase-reviews?")) {
        return json({ pendingCount: 1, pagination, reviews });
      }

      if (url.endsWith("/conversion-rules/providers")) {
        return json(rules);
      }

      if (url.endsWith("/workspaces/current")) {
        return json({ permissions: { canManageIntegrations: true } });
      }

      return json({ message: "not found" }, 404);
    });
}

async function renderPage(searchParams: Record<string, string>) {
  const element = await PurchaseReviewsPage({
    searchParams: Promise.resolve(searchParams),
  });

  return renderToStaticMarkup(createElement("div", null, element));
}

function ruleSelect(html: string): string {
  const start = html.indexOf('name="providerRuleId"');

  return html.slice(start, html.indexOf("</select>", start));
}

describe("purchase reviews route", () => {
  it("auto-applies filters without a visible Aplicar button", async () => {
    mockApi();

    const html = await renderPage({
      since: "2026-07-16",
      until: "2026-07-22",
      view: "all",
      status: "recognized",
      providerRuleId: purchaseRule.id,
      page: "2",
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/purchase-reviews?since=2026-07-16&until=2026-07-22&page=2&pageSize=25&view=all&status=recognized&providerRuleId=provider_rule_purchase",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).not.toContain("Aplicar");
    expect(html).toContain(
      '<button class="sr-only" type="submit" tabindex="-1">Atualizar revisão</button>',
    );
    expect(html).toContain(
      'class="purchase-review-filter-form" action="/events/purchase-reviews">',
    );
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain('type="date" name="since" value="2026-07-16"');
    expect(html).toContain('type="date" name="until" value="2026-07-22"');
    expect(html).toContain('<option value="all" selected="">Todas</option>');
    expect(html).toContain(
      '<option value="recognized" selected="">Reconhecidas</option>',
    );
    expect(html).toContain(
      '<option value="provider_rule_purchase" selected="">Compra com valor medio</option>',
    );
    expect(html).toContain("Fila operacional");
    expect(html).toContain("1 compra(s) no período");
    // The review panel and its actions render as before.
    expect(html).toContain("Maria Cliente");
    expect(html).toContain("Aprovar e enviar");
  });

  it("fills the default seven-day actionable period when the URL has none", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-22T15:00:00.000Z"));
    mockApi();

    try {
      const html = await renderPage({});

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:3333/purchase-reviews?since=2026-07-16&until=2026-07-22&page=1&pageSize=25&view=actionable",
        expect.objectContaining({ credentials: "include" }),
      );
      expect(html).toContain('type="date" name="since" value="2026-07-16"');
      expect(html).toContain('type="date" name="until" value="2026-07-22"');
      expect(html).toContain(
        '<option value="actionable" selected="">Pendências</option>',
      );
      expect(html).toContain(
        '<option value="" selected="">Todas as regras</option>',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps every filter and 25 items per page on pagination links", async () => {
    mockApi({
      pagination: { page: 2, pageSize: 25, totalItems: 70, totalPages: 3 },
    });

    const html = await renderPage({
      since: "2026-07-16",
      until: "2026-07-22",
      view: "history",
      status: "sent",
      providerRuleId: purchaseRule.id,
      page: "2",
    });

    expect(html).toContain(
      'href="/events/purchase-reviews?since=2026-07-16&amp;until=2026-07-22&amp;page=1&amp;pageSize=25&amp;view=history&amp;status=sent&amp;providerRuleId=provider_rule_purchase"',
    );
    expect(html).toContain(
      'href="/events/purchase-reviews?since=2026-07-16&amp;until=2026-07-22&amp;page=3&amp;pageSize=25&amp;view=history&amp;status=sent&amp;providerRuleId=provider_rule_purchase"',
    );
    expect(html).toContain("Página 2 de 3 / 70 compras");
  });

  it("offers only purchase rules", async () => {
    mockApi();

    const html = await renderPage({
      since: "2026-07-16",
      until: "2026-07-22",
    });

    expect(ruleSelect(html)).toContain('value="provider_rule_purchase"');
    expect(ruleSelect(html)).not.toContain('value="provider_rule_lead"');
  });

  it("keeps a selected rule missing from the options, named by its reviews", async () => {
    mockApi({
      rules: [leadRule],
      reviews: [
        {
          ...review,
          providerRuleId: "provider_rule_archived",
          ruleName: "Compra arquivada",
        },
      ],
    });

    const html = await renderPage({
      since: "2026-07-16",
      until: "2026-07-22",
      providerRuleId: "provider_rule_archived",
    });

    expect(ruleSelect(html)).toContain(
      '<option value="provider_rule_archived" selected="">Compra arquivada</option>',
    );
  });

  it("keeps a selected non-purchase rule under its real name", async () => {
    mockApi({ reviews: [] });

    const html = await renderPage({
      since: "2026-07-16",
      until: "2026-07-22",
      providerRuleId: leadRule.id,
    });

    expect(ruleSelect(html)).toContain(
      '<option value="provider_rule_lead" selected="">Lead qualificado por frase</option>',
    );
  });

  it("keeps an unknown selected rule with a neutral label and no invented data", async () => {
    mockApi({ unavailable: true });

    const html = await renderPage({
      since: "2026-07-16",
      until: "2026-07-22",
      providerRuleId: "provider_rule_unknown",
    });

    expect(html).toContain("API indisponível");
    expect(html).toContain("Não foi possível carregar a revisão");
    expect(ruleSelect(html)).toContain(
      '<option value="provider_rule_unknown" selected="">Regra indisponível</option>',
    );
    expect(ruleSelect(html).match(/<option/g)).toHaveLength(2);
    expect(html).not.toContain("Maria Cliente");
  });
});
