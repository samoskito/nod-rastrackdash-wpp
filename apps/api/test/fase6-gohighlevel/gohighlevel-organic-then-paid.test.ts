import { describe, expect, it, vi } from "vitest";
import { routeGoHighLevelEvent } from "../../src/inbound-webhooks/integration-endpoint-routing";
import { parseGoHighLevelAutomationV1 } from "../../src/inbound-webhooks/providers/gohighlevel/gohighlevel-automation-v1.parser";
import { createHarness, input } from "../fase4-payt/payt-ingestion-harness";

/**
 * Só lead pago (mesma correção do Webhook / n8n, SaaS fef16785 + 67bc1e5,
 * aplicada ao GoHighLevel): a etapa do Workflow chamada para um contato SEM
 * clique em anúncio (sem ctwa_clid) nunca vira lead nem envia nada, e não
 * pode ocupar a chave de dedupe. A chave do GHL (localização, Workflow,
 * contato, gatilho) não tem horário: a mesma etapa chamada depois do clique
 * no anúncio tem a MESMA chave. Sem a correção, essa chamada paga vira
 * "duplicada" da orgânica e a conversão se perde. Dados fictícios.
 */

function ghlCall(ctwaClid: string | null) {
  return {
    contact_id: "contact_synthetic_ghl",
    full_name: "Contato Exemplo",
    phone: "+5511987650909",
    date_created: "2026-10-26T11:00:00.000Z",
    location: { id: "location_synthetic_a", name: "Clínica Exemplo" },
    workflow: { id: "workflow_synthetic_qualified", name: "Qualificado" },
    triggerData: {},
    contact: {
      attributionSource: ctwaClid
        ? { sessionSource: "Paid Social", medium: "whatsapp", ctwa_clid: ctwaClid }
        : { sessionSource: "Direct traffic" },
      lastAttributionSource: {},
    },
    attributionSource: {},
    customData: {},
  };
}

function ghlHarness() {
  const harness = createHarness({ eventName: "QualifiedLead" });
  const providerRule = harness.endpoint.providerRule as any;
  providerRule.connection.provider = "gohighlevel";
  providerRule.connection.parserRelease.provider = "gohighlevel";
  providerRule.parserRelease.provider = "gohighlevel";
  providerRule.parserRelease.id = "inbound_parser_gohighlevel_automation_v1";
  providerRule.parserReleaseId = "inbound_parser_gohighlevel_automation_v1";
  providerRule.conversionRule.name = "Etapa no GoHighLevel: Qualificado";
  return harness;
}

const send = (harness: ReturnType<typeof ghlHarness>, body: unknown) =>
  harness.service.ingest(input(Buffer.from(JSON.stringify(body))));

describe("GoHighLevel Workflow step: only a paid lead counts", () => {
  it("organic → paid → resend: the paid call is a first call and is sent once", async () => {
    const harness = ghlHarness();
    // 1st call: the contact has no ad click yet (no ctwa_clid). The
    // observation blocks it as "ctwa_missing" (never a lead, never sent).
    harness.conversionObservation.observeAutomation.mockResolvedValueOnce({
      decisionId: null,
      decisionCode: null,
      reasonCode: "ctwa_missing",
      disposition: "blocked",
      executionId: "execution_organic",
      eligibleExecutionId: null,
      reviewId: null,
      channelId: null,
      leadResolved: false,
    });
    const organic = await send(harness, ghlCall(null));
    expect(organic).toMatchObject({ duplicate: false });
    const calls = harness.conversionObservation.observeAutomation.mock.calls;
    expect(calls[0]![0].automation).toMatchObject({
      provider: "gohighlevel",
      hasCtwa: false,
    });

    // 2nd call: same contact, same Workflow step, after the ad click.
    const paid = await send(harness, ghlCall("synthetic-ghl-click"));
    expect(paid.duplicate).toBe(false);
    expect(paid.deliveryId).not.toBe(organic.deliveryId);
    expect(calls).toHaveLength(2);
    // Same occurrence key as the organic call (no time in it)...
    expect(calls[1]![0].automation.externalExecutionKey).toBe(
      calls[0]![0].automation.externalExecutionKey,
    );
    // ...but evaluated as its own delivery, with the click.
    expect(calls[1]![0].deliveryId).toBe(paid.deliveryId);
    expect(calls[1]![0].automation).toMatchObject({
      hasCtwa: true,
      ctwaClid: "synthetic-ghl-click",
    });
    const eligible = calls.filter((call) => call[0].automation.hasCtwa);
    expect(eligible).toHaveLength(1);

    // A real resend of the paid call is the duplicate, never a second send.
    const resend = await send(harness, ghlCall("synthetic-ghl-click"));
    expect(resend).toMatchObject({
      deliveryId: paid.deliveryId,
      duplicate: true,
    });
    expect(
      calls.slice(1).every((call) => call[0].deliveryId === paid.deliveryId),
    ).toBe(true);

    // The organic call stays listed, with nothing that dedupes.
    const organicDelivery = [...harness.deliveries.values()].find(
      (delivery) => delivery.id === organic.deliveryId,
    )!;
    expect(organicDelivery.ingressKey).toBe(
      `gohighlevel-organic:${organic.deliveryId}`,
    );
  });

  it("a paid call keeps its occurrence key: a resend is a duplicate", async () => {
    const harness = ghlHarness();
    const first = await send(harness, ghlCall("synthetic-ghl-click"));
    const again = await send(harness, ghlCall("synthetic-ghl-click"));
    expect(again).toMatchObject({ deliveryId: first.deliveryId, duplicate: true });
    expect(harness.deliveries.size).toBe(1);
  });
});

describe("GoHighLevel on the workspace URL (one per event)", () => {
  it("an organic contact (no ctwa_clid) is never routed nor looked up", async () => {
    const parsed = parseGoHighLevelAutomationV1(ghlCall(null), new Date());
    if (!parsed.ok) throw new Error("parse");
    const prisma = {
      providerConversionRuleConfig: { findMany: vi.fn(async () => []) },
      inboundWebhookChannel: { findMany: vi.fn(async () => []) },
      inboundWebhookEvent: { findMany: vi.fn(async () => []) },
      conversionEventLog: { findMany: vi.fn(async () => []) },
    } as any;
    const paidLeads = { resolve: vi.fn() } as any;
    expect(
      await routeGoHighLevelEvent(prisma, paidLeads, {
        workspaceId: "w",
        eventName: "QualifiedLead",
        automation: parsed.value,
        receivedAt: new Date(),
      }),
    ).toEqual({
      status: "unattributed",
      reasonCode: "conversation_without_ad",
      channelId: null,
    });
    expect(prisma.providerConversionRuleConfig.findMany).not.toHaveBeenCalled();
    expect(paidLeads.resolve).not.toHaveBeenCalled();
  });
});
