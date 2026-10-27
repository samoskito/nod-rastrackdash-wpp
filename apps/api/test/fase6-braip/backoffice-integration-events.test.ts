import { Test } from "@nestjs/testing";
import {
  backofficeIntegrationEventListSchema,
  backofficeIntegrationEventQuerySchema,
  integrationEventPayloadSchema,
} from "@wpptrack/shared";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { PlatformAdminService } from "../../src/auth/platform-admin.service";

const platformAdminForbiddenMessage =
  "Backoffice restrito aos administradores da plataforma";
import { BackofficeIntegrationEventsController } from "../../src/inbound-webhooks/backoffice-integration-events.controller";
import {
  BackofficeIntegrationEventsService,
  integrationEventPayloadNeverStoredMessage,
} from "../../src/inbound-webhooks/backoffice-integration-events.service";
import { InboundWebhookPayloadEncryptionService } from "../../src/inbound-webhooks/inbound-webhook-payload-encryption.service";

/**
 * Backoffice "Recebimentos das URLs únicas" (porte do SaaS #170, fase 6.5):
 * cross-workspace audit of every receipt of the integration URLs, read only
 * (no certification in the student edition: production direct). Real
 * payload encryption and parsers; storage is an in-memory fake. Every value
 * is synthetic.
 */

const env = {
  NODE_ENV: "test",
  API_PUBLIC_URL: "https://api.example.test",
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_CONVERSION_RULES_ENABLED: "true",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
};
const encryption = new InboundWebhookPayloadEncryptionService(env);
const day = 86_400_000;
// Recent receipts (payloads still kept), on a whole minute.
const base = Math.floor((Date.now() - 3_600_000) / 60_000) * 60_000;
const iso = (minutesAgo: number) => new Date(base - minutesAgo * 60_000).toISOString();
/** Day (YYYY-MM-DD) in Brasilia time, as the period filter reads it. */
const brDay = (minutesAgo: number) =>
  new Date(base - minutesAgo * 60_000 - 3 * 3_600_000).toISOString().slice(0, 10);


function braip(overrides: Record<string, unknown> = {}) {
  return {
    basic_authentication: "SYNTHETIC-BRAIP-KEY",
    type: "STATUS_ALTERADO",
    trans_key: "VEN-1",
    trans_status: "Pagamento Aprovado",
    trans_total_value: 547,
    trans_createdate: "2026-10-23 11:08:00",
    trans_updatedate: "2026-10-23 11:09:00",
    product_key: "PRO1",
    product_name: "Produto Exemplo",
    plan_key: "PLA1",
    plan_name: "Plano",
    client_name: "Comprador",
    client_email: "comprador@example.test",
    client_cel: "(11) 99123-1020",
    ...overrides,
  };
}

const releases: Record<string, { id: string; provider: string; version: string; status: string }> = {
  braip: { id: "parser_braip", provider: "braip", version: "automation-v1", status: "certified" },
  payt: { id: "parser_payt", provider: "payt", version: "automation-v1", status: "certified" },
};
const workspaces = [
  { id: "ws_braip", name: "Loja Exemplo" },
  { id: "ws_payt", name: "Mentoria Teste" },
];

function row(input: {
  id: string;
  workspaceId: string;
  provider: "braip" | "payt";
  status: string;
  reasonCode?: string | null;
  eventName?: string | null;
  providerStatus?: string | null;
  payload?: unknown;
  rawText?: string;
  minutesAgo: number;
  attemptCount?: number;
  routedProviderRuleId?: string | null;
  expired?: boolean;
}) {
  const receivedAt = new Date(base - input.minutesAgo * 60_000);
  const body =
    input.rawText !== undefined
      ? Buffer.from(input.rawText, "utf8")
      : input.payload !== undefined
        ? Buffer.from(JSON.stringify(input.payload), "utf8")
        : null;
  const endpointId = `endpoint_${input.provider}_${input.workspaceId}`;
  const encrypted = body
    ? encryption.encrypt(body, {
        workspaceId: input.workspaceId,
        connectionId: `integration:${endpointId}`,
        deliveryId: input.id,
      })
    : { encryptedPayload: null, payloadIv: null, payloadTag: null, encryptionKeyVersion: null };
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    integrationEndpointId: endpointId,
    provider: input.provider,
    ingressKey: `ingress_${input.id}`,
    externalKey: null,
    eventName: input.eventName ?? null,
    providerStatus: input.providerStatus ?? null,
    status: input.status,
    reasonCode: input.reasonCode ?? null,
    productCode: input.eventName ? "PRO1" : null,
    productName: input.eventName ? "Produto Exemplo" : null,
    offerCode: null,
    offerName: null,
    valueCents: input.eventName ? 547 : null,
    currency: input.eventName ? "BRL" : null,
    contactIdentityHash: null,
    occurredAt: null,
    firstReceivedAt: receivedAt,
    lastReceivedAt: receivedAt,
    attemptCount: input.attemptCount ?? 1,
    routedProviderRuleId: input.routedProviderRuleId ?? null,
    routedDeliveryId: null,
    routedChannelId: null,
    routingOutcome: null,
    ...encrypted,
    // Same invariant as real rows: firstReceivedAt + 7 days.
    payloadExpiresAt: new Date(receivedAt.getTime() + 7 * day),
    createdAt: receivedAt,
    updatedAt: receivedAt,
  };
}

function fixtures() {
  return [
    row({ id: "r_paid", workspaceId: "ws_braip", provider: "braip", status: "unattributed", reasonCode: "buyer_not_whatsapp_lead", eventName: "Purchase", providerStatus: "pagamento aprovado", payload: braip(), minutesAgo: 1 }),
    row({ id: "r_waiting", workspaceId: "ws_braip", provider: "braip", status: "unattributed", reasonCode: "no_active_rule_for_event", eventName: "InitiateCheckout", providerStatus: "aguardando pagamento", payload: braip({ trans_key: "VEN-2", trans_status: "Aguardando Pagamento" }), minutesAgo: 2 }),
    row({ id: "r_abandon", workspaceId: "ws_braip", provider: "braip", status: "invalid", reasonCode: "braip_purchase_identity_missing", payload: { type: "ABANDONO_CHECKOUT", client_cel: "(11) 97777-3030" }, minutesAgo: 3 }),
    row({ id: "r_payt", workspaceId: "ws_payt", provider: "payt", status: "routed", eventName: "Purchase", routedProviderRuleId: "rule_payt", payload: { status: "paid" }, minutesAgo: 4, attemptCount: 3 }),
    row({ id: "r_cancel", workspaceId: "ws_braip", provider: "braip", status: "ignored", reasonCode: "status_not_supported", providerStatus: "cancelada", payload: braip({ trans_key: "VEN-3", trans_status: "Cancelada" }), minutesAgo: 5 }),
    row({ id: "r_token", workspaceId: "ws_payt", provider: "payt", status: "rejected", reasonCode: "token_invalid", minutesAgo: 6, attemptCount: 4 }),
    row({ id: "r_json", workspaceId: "ws_payt", provider: "payt", status: "rejected", reasonCode: "body_invalid_json", rawText: "integration_key=SYNTHETIC&x={", minutesAgo: 7 }),
    row({ id: "r_old", workspaceId: "ws_braip", provider: "braip", status: "unattributed", reasonCode: "buyer_not_whatsapp_lead", eventName: "Purchase", payload: braip({ trans_key: "VEN-OLD" }), minutesAgo: 9 * 24 * 60, expired: true }),
  ];
}

type Row = ReturnType<typeof row>;

function matches(r: Row, where: any): boolean {
  if (!where || Object.keys(where).length === 0) return true;
  if (where.AND) return where.AND.every((part: any) => matches(r, part));
  if (where.OR) return where.OR.some((part: any) => matches(r, part));
  return Object.entries(where).every(([key, condition]: [string, any]) => {
    const value = (r as any)[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      if ("in" in condition) return condition.in.includes(value);
      if ("gt" in condition && !(value > condition.gt)) return false;
      if ("gte" in condition && !(value >= condition.gte)) return false;
      if ("lt" in condition && !(value < condition.lt)) return false;
      return true;
    }
    if (condition instanceof Date) return value.getTime() === condition.getTime();
    return value === condition;
  });
}

function harness(rows: Row[] = fixtures()) {
  const audit: any[] = [];
  const prisma = {
    integrationEndpointEvent: {
      findMany: vi.fn(async ({ where, take }: any) =>
        rows
          .filter((r) => matches(r, where))
          .sort((a, b) =>
            b.payloadExpiresAt.getTime() - a.payloadExpiresAt.getTime() ||
            (a.id < b.id ? 1 : -1),
          )
          .slice(0, take)
          .map((r) => ({
            ...r,
            integrationEndpoint: {
              kind: "sales_platform",
              parserReleaseId: releases[r.provider]!.id,
              removedAt: null,
              provider: r.provider,
              parserRelease: releases[r.provider]!,
            },
            workspace: { name: workspaces.find((w) => w.id === r.workspaceId)!.name },
          })),
      ),
      findUnique: vi.fn(async ({ where }: any) => {
        const r = rows.find((candidate) => candidate.id === where.id);
        return r
          ? {
              ...r,
              integrationEndpoint: {
                kind: "sales_platform",
                parserReleaseId: releases[r.provider]!.id,
                removedAt: null,
                provider: r.provider,
                parserRelease: releases[r.provider]!,
              },
            }
          : null;
      }),
    },
    workspace: {
      findMany: vi.fn(async ({ where }: any) => {
        const [byId, byName] = where.OR;
        return workspaces.filter(
          (w) =>
            w.id === byId.id ||
            w.name.toLowerCase().includes(byName.name.contains.toLowerCase()),
        );
      }),
    },
    providerConversionRuleConfig: {
      findMany: vi.fn(async () => [
        { id: "rule_payt", conversionRule: { name: "Compra Payt" } },
      ]),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => audit.push(data)) },
  };
  const service = new BackofficeIntegrationEventsService(
    prisma as never,
    encryption,
  );
  return { prisma, service, audit };
}

const admin = { id: "admin_1", email: "admin@example.test", role: "platform_operator" as const };

function query(input: Record<string, unknown> = {}) {
  return backofficeIntegrationEventQuerySchema.parse(input);
}

describe("GET /backoffice/integration-events (permission)", () => {
  async function createApp() {
    const roles: Record<string, string | null> = {
      "owner-token": "platform_owner",
      "operator-token": "platform_operator",
      // Owner of a workspace, not a platform admin.
      "client-token": null,
    };
    const authService = {
      getSession: vi.fn(async (token: string) => ({
        user: { id: `user_${token}`, email: `${token}@example.com`, platformRole: roles[token] ?? null },
        workspaces: [{ id: "ws_braip", role: "owner" }],
      })),
    };
    const { service, prisma } = harness();
    const moduleRef = await Test.createTestingModule({
      controllers: [BackofficeIntegrationEventsController],
      providers: [
        { provide: PlatformAdminService, useValue: new PlatformAdminService(authService as never, {} as never) },
        { provide: BackofficeIntegrationEventsService, useValue: service },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return { app, prisma };
  }

  it("refuses every non-admin (even the workspace owner): no cross-workspace leak", async () => {
    const { app, prisma } = await createApp();
    for (const url of [
      "/backoffice/integration-events",
      "/backoffice/integration-events?workspace=ws_braip",
      "/backoffice/integration-events/r_paid/payload",
    ]) {
      const denied = await request(app.getHttpServer())
        .get(url)
        .set("Authorization", "Bearer client-token")
        .expect(403);
      expect(denied.body.message).toBe(platformAdminForbiddenMessage);
    }
    expect(prisma.integrationEndpointEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.integrationEndpointEvent.findUnique).not.toHaveBeenCalled();
    await app.close();
  });

  it("lets platform admins list every workspace and open a payload; rejects bad filters", async () => {
    const { app } = await createApp();
    for (const token of ["owner-token", "operator-token"]) {
      const list = await request(app.getHttpServer())
        .get("/backoffice/integration-events?status=all")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(backofficeIntegrationEventListSchema.safeParse(list.body).success).toBe(true);
      expect(new Set(list.body.items.map((item: any) => item.workspaceId))).toEqual(
        new Set(["ws_braip", "ws_payt"]),
      );
    }
    const payload = await request(app.getHttpServer())
      .get("/backoffice/integration-events/r_paid/payload")
      .set("Authorization", "Bearer operator-token")
      .expect(200);
    expect(integrationEventPayloadSchema.safeParse(payload.body).success).toBe(true);
    for (const bad of ["status=nope", "limit=1000", "provider=gupshup", "from=ontem", "cursor=%24%24"]) {
      await request(app.getHttpServer())
        .get(`/backoffice/integration-events?${bad}`)
        .set("Authorization", "Bearer operator-token")
        .expect(400);
    }
    await request(app.getHttpServer())
      .get("/backoffice/integration-events/bad%20id/payload")
      .set("Authorization", "Bearer operator-token")
      .expect(400);
    await app.close();
  });
});

describe("Recebimentos das URLs únicas (listing)", () => {
  it("lists every outcome newest first, ignored/invalid/rejected included, with a plain result", async () => {
    const { service, audit } = harness();
    const result = await service.list(query(), admin);
    expect(result.items.map((item) => [item.id, item.status])).toEqual([
      ["r_paid", "unattributed"],
      ["r_waiting", "unattributed"],
      ["r_abandon", "invalid"],
      ["r_payt", "routed"],
      ["r_cancel", "ignored"],
      ["r_token", "rejected"],
      ["r_json", "rejected"],
      ["r_old", "unattributed"],
    ]);
    const byId = Object.fromEntries(result.items.map((item) => [item.id, item]));
    expect(byId.r_paid).toMatchObject({
      workspaceName: "Loja Exemplo",
      providerStatus: "pagamento aprovado",
      eventName: "Purchase",
      orderRef: "VEN-1",
      phoneMasked: "••••1020",
      resultLabel: "Sem atribuição: Comprador não é lead do WhatsApp",
      payloadAvailable: true,
    });
    // Read only: no release/certification field ever reaches the screen.
    expect(byId.r_paid).not.toHaveProperty("certificationEligible");
    expect(byId.r_paid).not.toHaveProperty("parserCertified");
    expect(byId.r_waiting).toMatchObject({ eventName: "InitiateCheckout" });
    expect(byId.r_abandon!.resultLabel).toBe("Inválido: Sem identificação do pedido (ex.: trans_key)");
    expect(byId.r_payt).toMatchObject({ resultLabel: "Com regra: Compra Payt", routedRuleName: "Compra Payt", attemptCount: 3 });
    expect(byId.r_cancel!.resultLabel).toBe("Ignorado: Status da plataforma não usado (ex.: cancelada)");
    expect(byId.r_token).toMatchObject({ resultLabel: "Recusado: Token da URL não confere", payloadAvailable: false });
    expect(byId.r_old).toMatchObject({ payloadAvailable: false, orderRef: null });
    // Masking: never the full phone, the e-mail or the account key.
    const text = JSON.stringify(result);
    expect(text).not.toContain("99123-1020");
    expect(text).not.toContain("comprador@");
    expect(text).not.toContain("SYNTHETIC");
    // Each listing is audited (who looked at which filters).
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "backoffice.integration_events.list", actorUserId: admin.id });
  });

  it.each([
    [{ status: "invalid" }, ["r_abandon"]],
    [{ status: "ignored" }, ["r_cancel"]],
    [{ status: "rejected" }, ["r_token", "r_json"]],
    [{ status: "routed" }, ["r_payt"]],
    [{ status: "duplicate" }, ["r_payt", "r_token"]],
    [{ provider: "payt" }, ["r_payt", "r_token", "r_json"]],
    [{ eventName: "InitiateCheckout" }, ["r_waiting"]],
    [{ workspace: "loja" }, ["r_paid", "r_waiting", "r_abandon", "r_cancel", "r_old"]],
    [{ workspace: "ws_payt", status: "unattributed" }, []],
    [{ from: iso(3.5), to: iso(1.5) }, ["r_waiting", "r_abandon"]],
    [{ from: brDay(9 * 24 * 60), to: brDay(9 * 24 * 60) }, ["r_old"]],
  ])("filters %o", async (filters, expected) => {
    const { service } = harness();
    const result = await service.list(query(filters), admin);
    expect(result.items.map((item) => item.id)).toEqual(expected);
  });

  it("returns no rows (and does not query receipts) for a client search that matches nobody", async () => {
    const { service, prisma } = harness();
    await expect(service.list(query({ workspace: "ninguém" }), admin)).resolves.toEqual({
      items: [],
      nextCursor: null,
      matchedWorkspaces: [],
    });
    expect(prisma.integrationEndpointEvent.findMany).not.toHaveBeenCalled();
  });

  it("pages with a cursor (bounded page, no overlap, newest first)", async () => {
    const { service, prisma } = harness();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await service.list(query({ limit: 3, ...(cursor ? { cursor } : {}) }), admin);
      expect(result.items.length).toBeLessThanOrEqual(3);
      seen.push(...result.items.map((item) => item.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(["r_paid", "r_waiting", "r_abandon", "r_payt", "r_cancel", "r_token", "r_json", "r_old"]);
    // Ordered by the indexed column, never more than one extra row.
    expect(prisma.integrationEndpointEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ payloadExpiresAt: "desc" }, { id: "desc" }], take: 4 }),
    );
    expect(query({}).limit).toBe(50);
  });
});

describe("Ver dados recebidos (Backoffice)", () => {
  it("hides account keys, shows what was read, and audits the view on the receipt's workspace", async () => {
    const { service, audit } = harness();
    const result = await service.readPayload("r_paid", admin);
    expect(integrationEventPayloadSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result.payload)).not.toContain("SYNTHETIC-BRAIP-KEY");
    expect((result.payload as any).basic_authentication).toBe("[oculto]");
    expect(result.parsed).toMatchObject({ eventName: "Purchase", orderRef: "VEN-1", phoneMasked: "••••1020" });
    expect(result).not.toHaveProperty("certification");
    expect(audit).toEqual([
      expect.objectContaining({
        workspaceId: "ws_braip",
        actorUserId: admin.id,
        action: "integration_endpoint.event.payload.read",
        targetId: "r_paid",
        afterSummary: { provider: "braip", status: "unattributed", via: "backoffice" },
      }),
    ]);
  });

  it("opens ignored and invalid receipts too", async () => {
    const { service } = harness();
    const ignored = await service.readPayload("r_cancel", admin);
    expect(ignored).toMatchObject({ status: "ignored", payloadAvailable: true, parsed: null, parseError: "braip_sale_v1_status_not_supported" });
    expect((ignored.payload as any).trans_status).toBe("Cancelada");
    const invalid = await service.readPayload("r_abandon", admin);
    expect(invalid).toMatchObject({ status: "invalid", payloadAvailable: true, parsed: null });
  });

  it("shows a refused non-JSON body as text with credentials hidden", async () => {
    const { service } = harness();
    const result = await service.readPayload("r_json", admin);
    expect(result).toMatchObject({ status: "rejected", payloadAvailable: true, reasonLabel: "Corpo não é um JSON válido" });
    expect(result.payload).toBe("integration_key=[oculto]&x={");
  });

  it("explains a metadata-only refusal and an expired payload (no audit: nothing shown)", async () => {
    const { service, audit } = harness();
    const token = await service.readPayload("r_token", admin);
    expect(token).toMatchObject({ payloadAvailable: false, payload: null, payloadMessage: integrationEventPayloadNeverStoredMessage });
    const old = await service.readPayload("r_old", admin);
    expect(old.payloadAvailable).toBe(false);
    expect(old.payloadMessage).toMatch(/apagados/u);
    expect(audit).toHaveLength(0);
    await expect(service.readPayload("missing", admin)).rejects.toMatchObject({ status: 404 });
  });
});
