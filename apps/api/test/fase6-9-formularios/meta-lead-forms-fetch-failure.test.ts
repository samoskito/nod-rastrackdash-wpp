import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";
import {
  leadFetchFailureKind,
  MetaLeadFormGraphError,
  storedLeadFetchFailureKind,
} from "../../src/meta-lead-forms/meta-lead-form-graph.client";
import {
  MetaLeadFormsService,
  metaLeadFormFetchProblem,
} from "../../src/meta-lead-forms/meta-lead-forms.service";
import { routeLeadForm } from "../../src/meta-lead-forms/meta-leadgen";
import { WebhooksController } from "../../src/webhooks/webhooks.controller";

/**
 * Revisão do #121 (A4): só erro passageiro da Graph responde 503 (a Meta
 * reenvia). Erro permanente (token morto, falta de permissão) grava a
 * submissão como fetch_failed, responde 200 e a tela da conexão avisa.
 */

const graphError = (status: number, code?: number) =>
  new MetaLeadFormGraphError("erro sintético", status, code);

describe("leadFetchFailureKind", () => {
  it.each([
    ["rede (fetch falhou)", new TypeError("fetch failed"), "transient"],
    ["tempo esgotado", new DOMException("timeout", "TimeoutError"), "transient"],
    ["Graph 5xx sem código", graphError(500), "transient"],
    ["Graph 503 código 2", graphError(503, 2), "transient"],
    ["limite 4", graphError(400, 4), "transient"],
    ["limite 17", graphError(400, 17), "transient"],
    ["limite 32", graphError(400, 32), "transient"],
    ["limite 613", graphError(400, 613), "transient"],
    ["limite 80001", graphError(400, 80001), "transient"],
    ["limite 80014", graphError(400, 80014), "transient"],
    ["token morto 190", graphError(400, 190), "reconnect"],
    ["sessão 102", graphError(400, 102), "reconnect"],
    ["permissão 10", graphError(403, 10), "permission"],
    ["permissão 200", graphError(403, 200), "permission"],
    ["permissão 299", graphError(403, 299), "permission"],
    ["parâmetro 100", graphError(400, 100), "permanent"],
    ["4xx sem código", graphError(404), "permanent"],
  ] as const)("%s → %s", (_name, error, kind) => {
    expect(leadFetchFailureKind(error)).toBe(kind);
  });

  it("lê o tipo gravado no fetchError", () => {
    expect(storedLeadFetchFailureKind("[reconnect] x")).toBe("reconnect");
    expect(storedLeadFetchFailureKind("token expired")).toBeNull();
    expect(storedLeadFetchFailureKind(null)).toBeNull();
  });
});

const env = {
  META_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  API_PUBLIC_URL: "https://api.example.test/",
};

function service(fetchLead: () => Promise<unknown>) {
  const encryption = new MetaTokenEncryptionService(env);
  const token = encryption.encrypt("graph-token-1234");
  const connection = {
    id: "conn1",
    workspaceId: "ws1",
    pageId: "111",
    formIds: [] as string[],
    active: true,
    graphTokenEncrypted: token.encryptedAccessToken,
    graphTokenIv: token.tokenIv,
    graphTokenTag: token.tokenTag,
  };
  const submissions = new Map<string, Record<string, unknown>>();
  const prisma = {
    metaLeadFormConnection: { findMany: vi.fn(async () => [connection]) },
    metaLeadSubmission: {
      findUnique: vi.fn(async ({ where }) => submissions.get(where.metaLeadId) ?? null),
      upsert: vi.fn(async ({ where, create, update }) => {
        const row = submissions.has(where.metaLeadId) ? update : create;
        submissions.set(where.metaLeadId, row);
        return row;
      }),
    },
    lead: { findFirst: vi.fn(async () => null) },
  };
  const instance = new MetaLeadFormsService(
    prisma as never,
    encryption,
    { upsertFromWhatsappWebhook: vi.fn(async () => ({ id: "lead_1" })) } as never,
    env,
    { fetchLead: vi.fn(fetchLead), subscribePage: vi.fn() } as never,
  );
  return { instance, submissions };
}

const change = { leadgen_id: "900000000000010", page_id: "111", form_id: "55" };

describe("MetaLeadFormsService: falha de leitura passageira x permanente", () => {
  it("token morto (190): grava fetch_failed como permanente, sem pedir reenvio", async () => {
    const h = service(async () => {
      throw graphError(400, 190);
    });
    const result = await h.instance.ingestLeadgen([change]);
    expect(result).toMatchObject({ fetchFailed: 0, fetchFailedPermanent: 1 });
    expect(h.submissions.get(change.leadgen_id)).toMatchObject({
      fetchStatus: "fetch_failed",
      fetchError: "[reconnect] erro sintético",
    });
  });

  it("falta de permissão (10): permanente", async () => {
    const h = service(async () => {
      throw graphError(403, 10);
    });
    const result = await h.instance.ingestLeadgen([change]);
    expect(result).toMatchObject({ fetchFailed: 0, fetchFailedPermanent: 1 });
    expect(String(h.submissions.get(change.leadgen_id)?.fetchError)).toMatch(
      /^\[permission\]/u,
    );
  });

  it("rede e limite de uso: passageiros (o webhook pede reenvio)", async () => {
    for (const error of [new TypeError("fetch failed"), graphError(400, 613)]) {
      const h = service(async () => {
        throw error;
      });
      const result = await h.instance.ingestLeadgen([change]);
      expect(result).toMatchObject({ fetchFailed: 1, fetchFailedPermanent: 0 });
    }
  });

  it("token salvo ilegível (chave trocada): permanente, pede reconexão", async () => {
    const h = service(async () => ({ id: change.leadgen_id }));
    const broken = new MetaLeadFormsService(
      {
        metaLeadFormConnection: {
          findMany: vi.fn(async () => [
            {
              id: "conn1",
              workspaceId: "ws1",
              pageId: "111",
              formIds: [],
              active: true,
              graphTokenEncrypted: "AAAA",
              graphTokenIv: "AAAA",
              graphTokenTag: "AAAA",
            },
          ]),
        },
        metaLeadSubmission: {
          findUnique: vi.fn(async () => null),
          upsert: vi.fn(async ({ create }) => {
            h.submissions.set("x", create);
            return create;
          }),
        },
        lead: { findFirst: vi.fn(async () => null) },
      } as never,
      new MetaTokenEncryptionService(env),
      {} as never,
      env,
      { fetchLead: vi.fn(), subscribePage: vi.fn() } as never,
    );
    const result = await broken.ingestLeadgen([change]);
    expect(result).toMatchObject({ fetchFailed: 0, fetchFailedPermanent: 1 });
    expect(String(h.submissions.get("x")?.fetchError)).toMatch(/^\[reconnect\]/u);
  });
});

describe("aviso na tela da conexão (fetchProblem)", () => {
  const connection = { updatedAt: new Date("2026-10-27T10:00:00Z") };
  const at = (iso: string) => new Date(iso);

  it("último lead falhou de vez depois da última gravação da conexão: avisa", () => {
    expect(
      metaLeadFormFetchProblem(connection, {
        fetchStatus: "fetch_failed",
        fetchError: "[reconnect] token",
        updatedAt: at("2026-10-27T11:00:00Z"),
      }),
    ).toBe("reconnect");
    expect(
      metaLeadFormFetchProblem(connection, {
        fetchStatus: "fetch_failed",
        fetchError: "[permission] x",
        updatedAt: at("2026-10-27T11:00:00Z"),
      }),
    ).toBe("permission");
  });

  it("some depois de salvar um token novo, de um lead lido ou em falha passageira", () => {
    expect(
      metaLeadFormFetchProblem(connection, {
        fetchStatus: "fetch_failed",
        fetchError: "[reconnect] token",
        updatedAt: at("2026-10-27T09:00:00Z"),
      }),
    ).toBeNull();
    expect(
      metaLeadFormFetchProblem(connection, {
        fetchStatus: "fetched",
        fetchError: null,
        updatedAt: at("2026-10-27T11:00:00Z"),
      }),
    ).toBeNull();
    expect(
      metaLeadFormFetchProblem(connection, {
        fetchStatus: "fetch_failed",
        fetchError: "[transient] rede",
        updatedAt: at("2026-10-27T11:00:00Z"),
      }),
    ).toBeNull();
    expect(metaLeadFormFetchProblem(connection, undefined)).toBeNull();
  });
});

describe("POST /webhooks/meta: falha permanente responde 200", () => {
  const APP_SECRET = "app-secret-de-teste";
  const body = {
    object: "page",
    entry: [
      {
        id: "page_exemplo",
        changes: [{ field: "leadgen", value: change }],
      },
    ],
  };
  const raw = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.META_APP_SECRET;
    process.env.META_APP_SECRET = APP_SECRET;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = previous;
  });

  function controller(result: Record<string, number>) {
    const metaLeadForms = {
      inactiveConnectionPages: vi.fn(async () => new Set<string>()),
      activeConnectionPages: vi.fn(async () => new Set(["111"])),
      ingestLeadgen: vi.fn(async () => ({
        received: 1,
        saved: 0,
        duplicates: 0,
        unrouted: 0,
        ...result,
      })),
    };
    return new WebhooksController(
      { recordWebhookLog: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      {},
      metaLeadForms as never,
    );
  }

  it("permanente: resolve (2xx), a Meta não reenvia", async () => {
    await expect(
      controller({ fetchFailed: 0, fetchFailedPermanent: 1 }).recordMeta(
        body as never,
        raw,
        signature,
      ),
    ).resolves.toMatchObject({ fetchFailedPermanent: 1 });
  });

  it("passageira: 503, a Meta reenvia", async () => {
    await expect(
      controller({ fetchFailed: 1, fetchFailedPermanent: 0 }).recordMeta(
        body as never,
        raw,
        signature,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe("routeLeadForm com uma conexão só", () => {
  const listed = { id: "c1", pageId: "111", formIds: ["55"] };
  const all = { id: "c2", pageId: "111", formIds: [] as string[] };

  it("respeita os formulários escolhidos", () => {
    expect(routeLeadForm([listed], "111", "55").connection?.id).toBe("c1");
    expect(routeLeadForm([listed], "111", "66")).toEqual({
      connection: null,
      reason: "form_not_listed",
    });
  });

  it("sem formulários escolhidos, ou sem id de formulário, recebe tudo da Página", () => {
    expect(routeLeadForm([all], "111", "66").connection?.id).toBe("c2");
    expect(routeLeadForm([listed], "111", null).connection?.id).toBe("c1");
  });
});
