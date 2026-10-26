import type { ManualConversionPreviewDto } from "@wpptrack/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import LeadDetailPage from "../src/app/(app)/leads/[leadId]/page";
import {
  ManualConversionConfirm,
  ManualConversionForm,
  ManualConversionOutcome,
  blockedDuplicateDetail,
  manualConversionOutcomeTitle,
} from "../src/app/(app)/leads/[leadId]/manual-conversion-dialog";
import {
  buildManualConversionInput,
  isOutsideMetaWindow,
  manualConversionEventOptions,
  parseMoneyToCents,
  toDatetimeLocal,
  type ManualConversionFields,
} from "../src/app/(app)/leads/[leadId]/manual-conversion-form";

const KEY = "4b0c5a3e-8f43-4a8f-9c55-0d3a9f1d2e11";
const DAY = 24 * 60 * 60_000;

function fields(
  overrides: Partial<ManualConversionFields> = {},
): ManualConversionFields {
  return {
    eventName: "QualifiedLead",
    occurredAtLocal: toDatetimeLocal(new Date(Date.now() - 60 * 60_000)),
    value: "",
    currency: "BRL",
    orderRef: "",
    contentName: "",
    note: "",
    localOnly: false,
    ...overrides,
  };
}

const noop = () => undefined;

describe("manual conversion form validation", () => {
  it("lists the catalog events in Portuguese, without Schedule", () => {
    const labels = manualConversionEventOptions.map((option) => option.label);
    expect(labels).toContain("Compra realizada");
    expect(labels).toContain("Lead qualificado");
    expect(
      manualConversionEventOptions.map((option) => option.value),
    ).not.toContain("Schedule");
  });

  it("Purchase requires value, currency and order number", () => {
    const built = buildManualConversionInput(
      fields({ eventName: "Purchase" }),
      KEY,
    );
    expect(built).toEqual({
      ok: false,
      errors: {
        value: "Informe o valor da conversão.",
        orderRef: "Informe o número do pedido ou da venda.",
      },
    });
    const ok = buildManualConversionInput(
      fields({
        eventName: "Purchase",
        value: "1.299,90",
        currency: "USD",
        orderRef: " PED-1 ",
      }),
      KEY,
    );
    expect(ok).toMatchObject({
      ok: true,
      input: {
        valueCents: 129_990,
        currency: "USD",
        orderRef: "PED-1",
        sendToMeta: true,
        idempotencyKey: KEY,
      },
    });
  });

  it("an event without value ignores the value fields; local only flips sendToMeta", () => {
    const built = buildManualConversionInput(
      fields({ value: "10", orderRef: "x", localOnly: true }),
      KEY,
    );
    expect(built).toMatchObject({
      ok: true,
      input: {
        valueCents: null,
        currency: null,
        orderRef: null,
        sendToMeta: false,
      },
    });
  });

  it("rejects invalid money, future dates and dates older than 90 days", () => {
    expect(parseMoneyToCents("199,90")).toBe(19_990);
    expect(parseMoneyToCents("199.9")).toBe(19_990);
    expect(parseMoneyToCents("")).toBeNull();
    expect(
      buildManualConversionInput(
        fields({ eventName: "Purchase", value: "abc", orderRef: "1" }),
        KEY,
      ),
    ).toMatchObject({ ok: false, errors: { value: expect.any(String) } });
    expect(
      buildManualConversionInput(
        fields({ occurredAtLocal: toDatetimeLocal(new Date(Date.now() + DAY)) }),
        KEY,
      ),
    ).toMatchObject({
      ok: false,
      errors: { occurredAtLocal: "A data da conversão não pode estar no futuro." },
    });
    expect(
      buildManualConversionInput(
        fields({
          occurredAtLocal: toDatetimeLocal(new Date(Date.now() - 91 * DAY)),
        }),
        KEY,
      ),
    ).toMatchObject({ ok: false, errors: { occurredAtLocal: expect.any(String) } });
    expect(
      isOutsideMetaWindow(toDatetimeLocal(new Date(Date.now() - 8 * DAY))),
    ).toBe(true);
    expect(isOutsideMetaWindow(toDatetimeLocal(new Date()))).toBe(false);
  });
});

describe("manual conversion dialog states", () => {
  it("form: Purchase shows required value/order fields, the note hint and the local-only checkbox", () => {
    const html = renderToStaticMarkup(
      createElement(ManualConversionForm, {
        fields: fields({ eventName: "Purchase" }),
        errors: {},
        policy: "required",
        old: true,
        maxLocal: toDatetimeLocal(new Date()),
        pending: false,
        message: null,
        onChange: noop,
        onCancel: noop,
        onSubmit: noop,
      }),
    );
    expect(html).toContain("Número do pedido/venda");
    expect(html).not.toContain("Número do pedido/venda (opcional)");
    expect(html).toContain("Será registrado só no painel, não enviado à Meta");
    expect(html).toContain("feedback-banner warn");
    expect(html).toContain("Não inclua dados pessoais");
    expect(html).toContain("Registrar só no painel (não enviar à Meta)");
  });

  it("form: an event without value has no value fields", () => {
    const html = renderToStaticMarkup(
      createElement(ManualConversionForm, {
        fields: fields(),
        errors: {},
        policy: "none",
        old: false,
        maxLocal: toDatetimeLocal(new Date()),
        pending: false,
        message: null,
        onChange: noop,
        onCancel: noop,
        onSubmit: noop,
      }),
    );
    expect(html).not.toContain('name="value"');
    expect(html).not.toContain("Será registrado só no painel");
  });

  const preview: ManualConversionPreviewDto = {
    eventName: "QualifiedLead",
    eventLabel: "Lead qualificado",
    willSendToMeta: false,
    notSentReason: "outside_meta_window",
    notSentReasonLabel:
      "Será registrado só no painel, não enviado à Meta: a Meta só aceita eventos dos últimos 7 dias.",
    destination: {
      kind: "ad",
      pixelId: "pixel_1",
      destinationName: "Pixel Loja",
    },
    attribution: {
      campaignId: "cmp_1",
      campaignName: "Black Friday",
      adId: "ad_1",
      adName: "Criativo 1",
    },
    duplicate: null,
    recentDuplicate: null,
    mayExpireBeforeSend: false,
  };

  it("confirmation: destination, attribution and why it will not be sent", () => {
    const html = renderToStaticMarkup(
      createElement(ManualConversionConfirm, {
        preview,
        pending: false,
        message: null,
        onBack: noop,
        onConfirm: noop,
      }),
    );
    expect(html).toContain("Pixel Loja");
    expect(html).toContain("pixel pixel_1");
    expect(html).toContain("Black Friday / Criativo 1");
    expect(html).toContain("a Meta só aceita eventos dos últimos 7 dias");
  });

  it("confirmation: a duplicate warning disables Confirmar", () => {
    const html = renderToStaticMarkup(
      createElement(ManualConversionConfirm, {
        preview: {
          ...preview,
          willSendToMeta: false,
          duplicate: {
            kind: "lead_already_converted",
            message: "Lead já convertido em 01/10/2026, 12:00 por regra de conversão.",
            conversionEventLogId: "log_1",
            occurredAt: "2026-10-01T15:00:00.000Z",
          },
        },
        pending: false,
        message: null,
        onBack: noop,
        onConfirm: noop,
      }),
    );
    expect(html).toContain("Lead já convertido em 01/10/2026");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Confirmar<\/button>/u);
    expect(html).toContain("feedback-banner warn");
    expect(html).toContain("Lead já convertido");
  });

  const recent = {
    ...preview,
    willSendToMeta: true,
    notSentReason: null,
    notSentReasonLabel: null,
    recentDuplicate: {
      kind: "recent_same_event" as const,
      message:
        "Já existe Compra realizada deste lead em 21/10/2026, 10:00 por Payt. Registrar mesmo assim?",
      conversionEventLogId: "payt_log",
      occurredAt: "2026-10-21T13:00:00.000Z",
    },
  };

  it("confirmation: ±24h repeat shows the warning and a labeled confirm-anyway checkbox; button disabled until checked", () => {
    const unchecked = renderToStaticMarkup(
      createElement(ManualConversionConfirm, {
        preview: recent,
        pending: false,
        message: null,
        onBack: noop,
        onConfirm: noop,
      }),
    );
    expect(unchecked).toContain("Evento repetido nas últimas 24 horas");
    expect(unchecked).toContain("por Payt. Registrar mesmo assim?");
    expect(unchecked).toContain(
      "Sim, registrar mesmo assim (é outra conversão, não a mesma)",
    );
    expect(unchecked).toMatch(
      /<button[^>]*disabled=""[^>]*>Registrar mesmo assim<\/button>/u,
    );
    const checked = renderToStaticMarkup(
      createElement(ManualConversionConfirm, {
        preview: recent,
        pending: false,
        message: null,
        onBack: noop,
        onConfirm: noop,
        initialConfirmDuplicate: true,
      }),
    );
    expect(checked).not.toMatch(
      /<button[^>]*disabled=""[^>]*>Registrar mesmo assim<\/button>/u,
    );
  });

  it("confirmation: near the 7-day limit warns that it may expire", () => {
    const html = renderToStaticMarkup(
      createElement(ManualConversionConfirm, {
        preview: { ...recent, recentDuplicate: null, mayExpireBeforeSend: true },
        pending: false,
        message: null,
        onBack: noop,
        onConfirm: noop,
      }),
    );
    expect(html).toContain("Pode expirar antes do envio");
    expect(html).toContain("manual-conversion-summary");
    expect(html).not.toContain("lead-facts");
  });

  it("blocked callout body adds only when and by whom", () => {
    expect(
      blockedDuplicateDetail({
        kind: "lead_already_converted",
        message: "Lead já convertido em 14/10/2026, 12:00 por automação Unnichat.",
        conversionEventLogId: "log",
        occurredAt: "2026-10-14T15:00:00.000Z",
        originLabel: "automação Unnichat",
      }),
    ).toBe(
      "Em 14/10/2026 por automação Unnichat. Não é possível registrar de novo.",
    );
    expect(
      blockedDuplicateDetail({
        kind: "order_already_registered",
        message: "Pedido X já registrado.",
        conversionEventLogId: "log",
        occurredAt: "2026-10-14T15:00:00.000Z",
        originLabel: "Payt",
      }),
    ).toBe(
      "Em 14/10/2026 por Payt. Não é possível registrar o mesmo pedido de novo.",
    );
  });

  it("result title: expired outcome says 'Expirou antes do envio'", () => {
    expect(
      manualConversionOutcomeTitle({
        outcome: "expired",
        conversionEventLogId: "log",
        status: "not_eligible",
        message: "m",
        replayed: false,
      }),
    ).toBe("Expirou antes do envio");
    expect(
      manualConversionOutcomeTitle({
        outcome: "queued",
        conversionEventLogId: "log",
        status: "ready_to_send",
        message: "m",
        replayed: false,
      }),
    ).toBe("Enfileirado");
  });

  it("result: Enfileirado / Registrado só no painel / Já convertido link to Eventos Meta", () => {
    for (const title of [
      "Enfileirado",
      "Registrado só no painel",
      "Já convertido",
    ]) {
      const html = renderToStaticMarkup(
        createElement(ManualConversionOutcome, {
          tone: "ok",
          title,
          detail: "detalhe",
          onClose: noop,
        }),
      );
      expect(html).toContain(title);
      expect(html).toContain('href="/events"');
      expect(html).toContain("Ver em Eventos Meta");
    }
  });
});

describe("lead detail with manual conversions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const detail = {
    lead: {
      id: "lead_1",
      workspaceId: "workspace_1",
      name: "Mariana Alves",
      phoneDisplay: "+55 11 99999-1020",
      phoneHash: "phone_hash_1",
      status: "qualified",
      source: "uazapi",
      campaignId: "cmp_1",
      campaignName: "Black Friday",
      adSetId: "adset_1",
      adId: null,
      lastEventName: "Purchase",
      firstMessageAt: "2026-07-02T03:00:00.000Z",
      lastMessageAt: "2026-07-02T03:10:00.000Z",
      createdAt: "2026-07-02T03:00:00.000Z",
      updatedAt: "2026-07-02T03:10:00.000Z",
    },
    attribution: {
      campaignName: "Black Friday",
      adSetName: null,
      adName: null,
      creative: { thumbnailUrl: null, destinationUrl: null },
    },
    conversionEvents: [
      {
        id: "manual_1",
        eventName: "Purchase",
        status: "ready_to_send",
        sourceTrigger: "manual_conversion",
        pixelId: null,
        campaignId: null,
        adSetId: null,
        adId: null,
        errorCode: null,
        errorMessage: null,
        occurredAt: "2026-07-02T03:11:00.000Z",
        sentAt: null,
        createdAt: "2026-07-02T03:12:00.000Z",
        manual: {
          createdByName: "Ana Dona",
          note: "Fechou por telefone",
          orderRef: "PED-1",
          canCancel: true,
        },
      },
      {
        id: "manual_2",
        eventName: "QualifiedLead",
        status: "sent",
        sourceTrigger: "manual_conversion",
        pixelId: "pixel_1",
        campaignId: null,
        adSetId: null,
        adId: null,
        errorCode: null,
        errorMessage: null,
        occurredAt: "2026-07-02T03:11:00.000Z",
        sentAt: "2026-07-02T03:13:00.000Z",
        createdAt: "2026-07-02T03:12:00.000Z",
        manual: {
          createdByName: "Ana Dona",
          note: null,
          orderRef: null,
          canCancel: false,
        },
      },
    ],
    webhookEvents: [],
  };

  function mockApi(canManageIntegrations: boolean, licenseLocked = false) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const path = String(url);
      const body = path.endsWith("/leads/lead_1")
        ? detail
        : path.endsWith("/license-client/status")
          ? { status: licenseLocked ? "blocked" : "active", locked: licenseLocked }
        : path.endsWith("/workspaces/current")
          ? {
              id: "workspace_1",
              permissions: { canManageIntegrations },
            }
          : path.endsWith("/workspaces/current/currency")
            ? { conversionCurrency: "USD", adAccounts: [] }
            : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  it("owner/admin: button, Manual badge with author, cancel only while not sent, catalog labels", async () => {
    mockApi(true);
    const element = await LeadDetailPage({
      params: Promise.resolve({ leadId: "lead_1" }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Registrar conversão manual");
    expect(html).toContain("Manual");
    expect(html).toContain("Ana Dona");
    expect(html).toContain("Fechou por telefone");
    expect(html).toContain("Registro manual");
    expect(html).toContain("Cancelar");
    expect(html).toContain("Enviado — não pode ser desfeito");
    // Raw statuses are translated, with consistent dot colors.
    expect(html).toContain("Na fila de envio");
    expect(html).not.toContain(">ready_to_send<");
    expect(html).toMatch(/class="event-chip info">Na fila de envio</u);
    expect(html).toMatch(/class="event-chip">Enviado</u);
    expect(html).toContain('class="manual-conversion-author-name"');
    // eventNameLabel now follows the shared catalog.
    expect(html).toContain("Compra realizada");
  });

  it("nod: license blocked keeps the button visible but disabled (the API answers 423)", async () => {
    mockApi(true, true);
    const element = await LeadDetailPage({
      params: Promise.resolve({ leadId: "lead_1" }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Licença bloqueada[^"]*"[^>]*>.*Registrar conversão manual/su);

    vi.restoreAllMocks();
    mockApi(true, false);
    const unlocked = renderToStaticMarkup(
      createElement(
        "div",
        null,
        await LeadDetailPage({ params: Promise.resolve({ leadId: "lead_1" }) }),
      ),
    );
    expect(unlocked).not.toMatch(/disabled=""[^>]*title="Licença bloqueada/u);
  });

  it("member: no button and no cancel", async () => {
    mockApi(false);
    const element = await LeadDetailPage({
      params: Promise.resolve({ leadId: "lead_1" }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).not.toContain("Registrar conversão manual");
    expect(html).not.toContain(">Cancelar<");
    expect(html).toContain("Ana Dona");
  });
});
