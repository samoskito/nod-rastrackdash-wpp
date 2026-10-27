import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";
import { MetaLeadFormGraphError } from "../../src/meta-lead-forms/meta-lead-form-graph.client";
import {
  LEAD_REFETCH_BATCH,
  MetaLeadFormsService,
} from "../../src/meta-lead-forms/meta-lead-forms.service";

/**
 * 1.3.1 (revisão do #121): um lead de formulário que falhou por token morto
 * ficava fetch_failed para sempre (o webhook respondeu 200, a Meta não
 * reenvia). Salvar um token novo, assinar a Página de novo ou "Ler de novo"
 * relê pelo leadgen_id os fetch_failed dos últimos 7 dias, sem duplicar o
 * lead nem o recebimento. Dados fictícios.
 */

const env = {
  META_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  API_PUBLIC_URL: "https://api.exemplo.test/",
};
const DAY = 24 * 60 * 60_000;

type Row = Record<string, any>;

function harness(options: { active?: boolean } = {}) {
  const encryption = new MetaTokenEncryptionService(env);
  const token = encryption.encrypt("graph-token-antigo-1234");
  const connection: Row = {
    id: "conn1",
    workspaceId: "ws1",
    pageId: "111",
    formIds: [],
    active: options.active ?? true,
    graphTokenEncrypted: token.encryptedAccessToken,
    graphTokenIv: token.tokenIv,
    graphTokenTag: token.tokenTag,
    graphTokenLast4: "1234",
    graphTokenUpdatedAt: new Date(Date.now() - 3 * DAY),
    label: "Página Exemplo",
    qualifiedEventName: "LeadQualificado",
    crmDatasetId: null,
    capiTokenLast4: null,
    pageSubscribedAt: null,
    createdAt: new Date(Date.now() - 10 * DAY),
    updatedAt: new Date(Date.now() - 3 * DAY),
  };
  const submissions = new Map<string, Row>();
  const failed = (id: string, ageDays: number) =>
    submissions.set(id, {
      id: `sub_${id}`,
      metaLeadId: id,
      workspaceId: "ws1",
      connectionId: "conn1",
      pageId: "111",
      formId: "55",
      adId: null,
      adSetId: null,
      leadId: null,
      metaCreatedAt: null,
      fetchStatus: "fetch_failed",
      fetchError: "[reconnect] token",
      createdAt: new Date(Date.now() - ageDays * DAY),
      updatedAt: new Date(Date.now() - ageDays * DAY),
    });
  const match = (row: Row, where: Row) =>
    row.workspaceId === where.workspaceId &&
    row.connectionId === where.connectionId &&
    row.fetchStatus === where.fetchStatus &&
    row.createdAt >= where.createdAt.gte;
  const prisma = {
    metaLeadFormConnection: {
      findFirst: vi.fn(async () => connection),
      findMany: vi.fn(async () => [connection]),
      update: vi.fn(async ({ data }: { data: Row }) =>
        Object.assign(connection, data, { updatedAt: new Date() }),
      ),
    },
    metaLeadSubmission: {
      findMany: vi.fn(async ({ where, take }: { where: Row; take: number }) =>
        [...submissions.values()]
          .filter((row) => match(row, where))
          .sort((a, b) => a.updatedAt - b.updatedAt)
          .slice(0, take),
      ),
      count: vi.fn(
        async ({ where }: { where: Row }) =>
          [...submissions.values()].filter((row) => match(row, where)).length,
      ),
      findUnique: vi.fn(
        async ({ where }: { where: Row }) => submissions.get(where.metaLeadId) ?? null,
      ),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const current = submissions.get(where.metaLeadId);
        if (!current || current.fetchStatus !== where.fetchStatus) return { count: 0 };
        submissions.set(where.metaLeadId, { ...current, ...data, updatedAt: new Date() });
        return { count: 1 };
      }),
      upsert: vi.fn(async ({ where, update, create }: Row) => {
        const current = submissions.get(where.metaLeadId);
        const row = current
          ? { ...current, ...update, updatedAt: new Date() }
          : { ...create, createdAt: new Date(), updatedAt: new Date() };
        submissions.set(where.metaLeadId, row);
        return row;
      }),
    },
    lead: { findFirst: vi.fn(async () => null) },
  };
  const leads = {
    upsertFromWhatsappWebhook: vi.fn(async () => ({ id: "lead_1" })),
  };
  const fetchLead = vi.fn(async (id: string) => ({
    id,
    created_time: "2026-10-26T12:00:00+0000",
    form_id: "55",
    field_data: [
      { name: "full_name", values: ["Lead Exemplo"] },
      { name: "phone_number", values: ["+5511999990301"] },
    ],
  }));
  const service = new MetaLeadFormsService(
    prisma as never,
    encryption,
    leads as never,
    env,
    { fetchLead, subscribePage: vi.fn(async () => undefined) } as never,
  );
  return { service, prisma, submissions, failed, fetchLead, leads, connection };
}

describe("Formulários Meta: releitura dos leads que falharam (1.3.1)", () => {
  it("salvar um token novo relê os fetch_failed dos últimos 7 dias, sem duplicar", async () => {
    const h = harness();
    h.failed("900000000000101", 1);
    h.failed("900000000000102", 2);
    h.failed("900000000000103", 9); // fora da janela de 7 dias

    await h.service.updateConnection("ws1", "conn1", {
      graphToken: "graph-token-novo-abcdefghijkl",
    });

    expect(h.fetchLead.mock.calls.map(([id]) => id).sort()).toEqual([
      "900000000000101",
      "900000000000102",
    ]);
    // Usa o token novo, não o antigo.
    expect((h.fetchLead.mock.calls[0] as unknown[])[1]).toBe("graph-token-novo-abcdefghijkl");
    expect(h.submissions.get("900000000000101")).toMatchObject({
      fetchStatus: "fetched",
      fetchError: null,
      leadId: "lead_1",
    });
    expect(h.submissions.get("900000000000103")!.fetchStatus).toBe("fetch_failed");
    // Mesmo recebimento (metaLeadId), nunca um novo.
    expect(h.submissions.size).toBe(3);
    // A data do token foi gravada (o aviso compara com ela).
    expect(h.connection.graphTokenUpdatedAt.getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );

    // Idempotente: rodar de novo não lê nada.
    h.fetchLead.mockClear();
    const again = await h.service.refetchFailedSubmissions("ws1", "conn1");
    expect(again).toEqual({ attempted: 0, recovered: 0, failed: 0, remaining: 0 });
    expect(h.fetchLead).not.toHaveBeenCalled();
  });

  it("editar só o rótulo não relê nada nem mexe na data do token", async () => {
    const h = harness();
    h.failed("900000000000111", 1);
    const before = h.connection.graphTokenUpdatedAt;
    await h.service.updateConnection("ws1", "conn1", { label: "Outro nome" });
    expect(h.fetchLead).not.toHaveBeenCalled();
    expect(h.connection.graphTokenUpdatedAt).toBe(before);
  });

  it("assinar a Página de novo relê", async () => {
    const h = harness();
    h.failed("900000000000121", 1);
    await h.service.subscribePage("ws1", "conn1");
    expect(h.fetchLead).toHaveBeenCalledTimes(1);
    expect(h.submissions.get("900000000000121")!.fetchStatus).toBe("fetched");
  });

  it("para no primeiro erro de token (vale para todos) e continua em erro do próprio lead", async () => {
    const h = harness();
    h.failed("900000000000131", 3);
    h.failed("900000000000132", 2);
    h.failed("900000000000133", 1);
    h.fetchLead.mockRejectedValueOnce(
      new MetaLeadFormGraphError("lead apagado", 400, 100),
    );
    h.fetchLead.mockRejectedValueOnce(
      new MetaLeadFormGraphError("token vencido", 400, 190),
    );
    const result = await h.service.refetchFailedSubmissions("ws1", "conn1");
    expect(result).toEqual({ attempted: 2, recovered: 0, failed: 2, remaining: 3 });
    expect(h.fetchLead).toHaveBeenCalledTimes(2);
  });

  it("uma falha não apaga uma leitura que deu certo em paralelo", async () => {
    const h = harness();
    h.failed("900000000000161", 1);
    h.fetchLead.mockImplementationOnce(async (id: string) => {
      // Outro clique leu o mesmo lead enquanto esta leitura esperava a Meta.
      h.submissions.set(id, {
        ...h.submissions.get(id)!,
        fetchStatus: "fetched",
        fetchError: null,
        leadId: "lead_1",
      });
      throw new MetaLeadFormGraphError("limite", 400, 613);
    });
    await h.service.refetchFailedSubmissions("ws1", "conn1");
    expect(h.submissions.get("900000000000161")).toMatchObject({
      fetchStatus: "fetched",
      leadId: "lead_1",
    });
  });

  it("lê no máximo um lote por clique", async () => {
    const h = harness();
    for (let index = 0; index < LEAD_REFETCH_BATCH + 5; index++)
      h.failed(String(900000000001000 + index), 1);
    const result = await h.service.refetchFailedSubmissions("ws1", "conn1");
    expect(result.attempted).toBe(LEAD_REFETCH_BATCH);
    expect(result.remaining).toBe(5);
  });

  it("conexão desativada: Ler de novo recusa e o token novo não relê", async () => {
    const h = harness({ active: false });
    h.failed("900000000000141", 1);
    await expect(
      h.service.refetchFailedSubmissions("ws1", "conn1"),
    ).rejects.toBeInstanceOf(ConflictException);
    await h.service.updateConnection("ws1", "conn1", {
      graphToken: "graph-token-novo-abcdefghijkl",
    });
    expect(h.fetchLead).not.toHaveBeenCalled();
  });

  it("uma falha da releitura nunca derruba o salvamento do token", async () => {
    const h = harness();
    h.failed("900000000000151", 1);
    h.prisma.metaLeadSubmission.findMany.mockRejectedValueOnce(new Error("db"));
    await expect(
      h.service.updateConnection("ws1", "conn1", {
        graphToken: "graph-token-novo-abcdefghijkl",
      }),
    ).resolves.toMatchObject({ id: "conn1" });
  });
});
