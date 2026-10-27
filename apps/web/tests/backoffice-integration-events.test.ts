// @vitest-environment jsdom

import type {
  BackofficeIntegrationEventDto,
  IntegrationEventPayloadDto,
} from "@wpptrack/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { setupUser } from "./user-shim";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { isApiRequestError, revalidatePath, serverApiFetch } = vi.hoisted(() => ({
  isApiRequestError: vi.fn(
    (error: unknown) =>
      typeof error === "object" && error !== null && "status" in error && "message" in error,
  ),
  revalidatePath: vi.fn(),
  serverApiFetch: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../src/lib/server-api", () => ({ isApiRequestError, serverApiFetch }));

import { loadBackofficeIntegrationEventPayloadAction } from "../src/app/(backoffice)/backoffice/inbound-webhooks/integration-events/actions";
import {
  pageHref,
  providerOptions,
  providerStatusLabel,
  readFilters,
  statusChip,
  statusFilterOptions,
} from "../src/app/(backoffice)/backoffice/inbound-webhooks/integration-events/integration-events-copy";
import {
  IntegrationEventsTable,
  ReceiptPayloadView,
} from "../src/app/(backoffice)/backoffice/inbound-webhooks/integration-events/integration-events-table";
import IntegrationEventsPage from "../src/app/(backoffice)/backoffice/inbound-webhooks/integration-events/page";
import { loadIntegrationEventPayloadAction } from "../src/app/(app)/integrations/single-url/single-url-actions";

/**
 * Fase 6.5 — Backoffice "Recebimentos das URLs únicas" (porte do SaaS #170)
 * and "Ver dados recebidos" (#169), read only in the student edition: no
 * release/certification button anywhere.
 */

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function item(
  overrides: Partial<BackofficeIntegrationEventDto> = {},
): BackofficeIntegrationEventDto {
  return {
    id: "r_paid",
    workspaceId: "ws_braip",
    workspaceName: "Loja Exemplo",
    provider: "braip",
    kind: "sales_platform",
    status: "unattributed",
    reasonCode: "buyer_not_whatsapp_lead",
    resultLabel: "Sem atribuição: Comprador não é lead do WhatsApp",
    providerStatus: "pagamento aprovado",
    eventName: "Purchase",
    valueCents: 54700,
    currency: "BRL",
    orderRef: "VEN-1",
    phoneMasked: "••••1020",
    productName: "Produto Exemplo",
    productCode: "PRO1",
    routedRuleId: null,
    routedRuleName: null,
    attemptCount: 1,
    firstReceivedAt: "2026-10-23T14:09:05.000Z",
    lastReceivedAt: "2026-10-23T14:09:05.000Z",
    payloadAvailable: true,
    payloadExpiresAt: "2026-10-30T14:09:05.000Z",
    ...overrides,
  };
}

const payload: IntegrationEventPayloadDto = {
  eventId: "r_paid",
  provider: "braip",
  status: "unattributed",
  reasonLabel: "Comprador não é lead do WhatsApp",
  receivedAt: "2026-10-23T14:09:05.000Z",
  payloadExpiresAt: "2026-10-30T14:09:05.000Z",
  payloadAvailable: true,
  payloadMessage: null,
  payload: { trans_key: "VEN-1", basic_authentication: "[oculto]" },
  parsed: {
    eventName: "Purchase",
    valueCents: 54700,
    currency: "BRL",
    valueSent: true,
    productCode: "PRO1",
    productName: "Produto Exemplo",
    offerCode: null,
    offerName: null,
    orderRef: "VEN-1",
    occurredAt: "2026-10-23T14:09:00.000Z",
    phoneMasked: "••••1020",
    providerStatus: "pagamento aprovado",
    test: false,
  },
  parseError: null,
};

describe("filters and labels", () => {
  it("passes only known values to the API and keeps the page links", () => {
    expect(
      readFilters({
        provider: "braip",
        status: "rejected",
        eventName: "Purchase",
        from: "2026-10-01",
        to: "ontem",
        cursor: "$$",
        workspace: "loja",
      }),
    ).toEqual({
      workspace: "loja",
      provider: "braip",
      status: "rejected",
      eventName: "Purchase",
      from: "2026-10-01",
      to: undefined,
      cursor: undefined,
    });
    expect(readFilters({ provider: "gupshup", status: "all" })).toMatchObject({
      provider: undefined,
      status: undefined,
    });
    expect(pageHref({ provider: "braip" }, "abc")).toBe(
      "/backoffice/inbound-webhooks/integration-events?provider=braip&cursor=abc",
    );
    expect(providerStatusLabel("pagamento aprovado")).toBe("Pagamento Aprovado");
    expect(statusChip({ status: "rejected" })).toEqual({ label: "Recusado", tone: "bad" });
    expect(providerOptions.map((option) => option.value)).toContain("braip");
    expect(statusFilterOptions.map((option) => option.label)).toContain(
      "Recusado (erro HTTP)",
    );
  });
});

describe("Recebimentos table", () => {
  it("shows the masked receipt and opens the payload, with no release action", async () => {
    const loadPayload = vi.fn(async () => ({
      ok: true,
      message: "Dados recebidos abertos.",
      eventPayload: payload,
    }));
    render(
      createElement(IntegrationEventsTable, {
        items: [item(), item({ id: "r_token", status: "rejected", reasonCode: "token_invalid", resultLabel: "Recusado: Token da URL não confere", payloadAvailable: false, eventName: null, orderRef: null, phoneMasked: null })],
        loadPayload,
      }),
    );
    expect(screen.getAllByText("Braip")).toHaveLength(2);
    expect(screen.getByText("••••1020")).toBeTruthy();
    expect(screen.queryByText(/Liberar/u)).toBeNull();
    const [open] = screen.getAllByRole("button", { name: /Ver dados recebidos/u });
    await setupUser().click(open!);
    await waitFor(() => expect(screen.getByText("O que lemos")).toBeTruthy());
    expect(loadPayload).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("[oculto]");
  });

  it("explains an empty result instead of a blank table", () => {
    const html = renderToStaticMarkup(
      createElement(IntegrationEventsTable, { items: [], loadPayload: vi.fn() }),
    );
    expect(html).toContain("Nenhum recebimento com estes filtros");
  });
});

describe("refused receipt view", () => {
  it("never shows a reading for a refused call (nothing was read)", () => {
    const html = renderToStaticMarkup(
      createElement(ReceiptPayloadView, {
        item: item({ status: "rejected", resultLabel: "Recusado: Token da URL não confere" }),
        data: {
          ...payload,
          status: "rejected",
          payloadAvailable: false,
          payload: null,
          parsed: null,
          payloadMessage: "Recebimento recusado antes da leitura",
        },
      }),
    );
    expect(html).toContain("O que ficou guardado");
    expect(html).not.toContain("O que lemos");
    expect(html).not.toContain("O leitor não reconheceu");
  });
});

describe("Recebimentos page", () => {
  it("loads the receipts with the filters and links the other webhook views", async () => {
    serverApiFetch.mockResolvedValueOnce({ items: [item()], nextCursor: "next" });
    const element = await IntegrationEventsPage({
      searchParams: Promise.resolve({ provider: "braip" }),
    });
    const html = renderToStaticMarkup(element);
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/backoffice/integration-events?provider=braip",
    );
    expect(html).toContain("Recebimentos das URLs únicas");
    expect(html).toContain("/backoffice/inbound-webhooks/parsers");
    expect(html).toContain("Mais antigos");
    expect(html).not.toMatch(/Liberar|certifica/iu);
  });

  it("says when the area is restricted", async () => {
    serverApiFetch.mockRejectedValueOnce({ status: 403, message: "x" });
    const html = renderToStaticMarkup(await IntegrationEventsPage({}));
    expect(html).toContain("Área restrita aos administradores da plataforma");
  });
});

describe("payload actions", () => {
  it("opens a Backoffice payload and maps the API refusals", async () => {
    const form = new FormData();
    form.set("eventId", "r_paid");
    serverApiFetch.mockResolvedValueOnce(payload);
    await expect(loadBackofficeIntegrationEventPayloadAction(form)).resolves.toMatchObject({
      ok: true,
      eventPayload: { eventId: "r_paid" },
    });
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/backoffice/integration-events/r_paid/payload",
    );
    serverApiFetch.mockRejectedValueOnce({ status: 403, message: "x" });
    await expect(loadBackofficeIntegrationEventPayloadAction(form)).resolves.toMatchObject({
      ok: false,
      message: "Só administradores da plataforma podem ver estes dados.",
    });
    const bad = new FormData();
    bad.set("eventId", "bad id");
    await expect(loadBackofficeIntegrationEventPayloadAction(bad)).resolves.toMatchObject({ ok: false });
  });

  it("opens the payload of a workspace sale ('Ver dados recebidos') without any write", async () => {
    const form = new FormData();
    form.set("eventId", "r_paid");
    serverApiFetch.mockResolvedValueOnce(payload);
    await expect(loadIntegrationEventPayloadAction(form)).resolves.toMatchObject({
      ok: true,
      eventPayload: { parsed: { orderRef: "VEN-1" } },
    });
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/endpoints/events/r_paid/payload",
    );
    expect(revalidatePath).not.toHaveBeenCalled();
    serverApiFetch.mockRejectedValueOnce({ status: 403, message: "x" });
    await expect(loadIntegrationEventPayloadAction(form)).resolves.toMatchObject({
      ok: false,
      message: "Você não tem permissão para ver os dados recebidos.",
    });
  });
});
