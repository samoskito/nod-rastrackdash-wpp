import { BadRequestException, ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { FunnelStageConfigurationDto } from "@wpptrack/shared";
import { CRM_BACKWARD_MOVE_MESSAGE } from "@wpptrack/shared";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AuthService } from "../../src/auth/auth.service";
import {
  CrmBoardService,
  crmLayoutFromJourney,
  resolveCrmRange,
} from "../../src/crm/crm-board.service";
import { CrmController } from "../../src/crm/crm.controller";
import { WorkspacesService } from "../../src/workspaces/workspaces.service";
import {
  CRM_TEST_NOW as NOW,
  CRM_TEST_WS as WS,
  CrmTestDb,
  daysAgo,
} from "../helpers/crm-pglite";

const journey = (
  overrides: Partial<Record<string, Partial<FunnelStageConfigurationDto>>> = {},
): FunnelStageConfigurationDto[] =>
  [
    { eventName: "LeadSubmitted", label: "Leads novos", position: 1, visible: true },
    { eventName: "QualifiedLead", label: "Lead qualificado", position: 2, visible: true },
    {
      eventName: "Purchase",
      label: "Compra",
      position: 3,
      visible: true,
      defaultValueCents: 49_700,
      defaultCurrency: "BRL",
    },
  ].map((stage) => ({ ...stage, ...overrides[stage.eventName] })) as FunnelStageConfigurationDto[];

let testDb: CrmTestDb;

beforeAll(async () => {
  testDb = await new CrmTestDb().init();
}, 60_000);
afterAll(async () => {
  await testDb?.close();
});
beforeEach(async () => {
  await testDb.reset();
});

function harness(options: {
  stages?: FunnelStageConfigurationDto[];
  deferredReceipt?: boolean;
  instances?: Array<{ id: string; name: string; status: string }>;
  /** Fase 6.4: persisted creative thumbnails (MetaCreativeThumbnail). */
  thumbnails?: Array<{ creativeId: string; version: string | null }>;
} = {}) {
  const queries: string[] = [];
  const leadFindMany = vi.fn(async (args: any) => {
    if (args.where?.id?.in) return testDb.leadsByIds(args.where.id.in);
    // firstContactScopeCorrections: rows of the campaign.
    if (args.where?.campaignId) {
      const result = await testDb.db.query(
        `SELECT id, "campaignId", "adSetId", "adId" FROM "Lead" WHERE "workspaceId" = $1 AND "campaignId" = $2`,
        [args.where.workspaceId, args.where.campaignId],
      );
      return result.rows;
    }
    throw new Error("unbounded lead query");
  });
  const prisma = {
    $queryRaw: vi.fn(async (sql: any) => {
      queries.push(sql.text);
      return testDb.run(sql);
    }),
    lead: { findMany: leadFindMany },
    conversionEventLog: {
      // Override detection (resolveRuleOverrideReportMode).
      findFirst: vi.fn(async () => (options.deferredReceipt ? { id: "receipt" } : null)),
      // First-contact attribution events: none (the row stands).
      findMany: vi.fn(async () => []),
    },
    whatsappInstance: {
      findMany: vi.fn(async () =>
        options.instances ?? [{ id: "inst_1", name: "Comercial", status: "active" }],
      ),
    },
    metaAd: {
      findMany: vi.fn(async () => [
        {
          adId: "ad_1",
          campaignId: "camp_1",
          name: "Criativo carrossel",
          creativeId: "cr_1",
          thumbnailUrl: "https://cdn.example.test/ad_1.jpg",
        },
      ]),
    },
    metaCampaign: {
      findMany: vi.fn(async () => [{ campaignId: "camp_1", name: "Black Friday" }]),
    },
    ...(options.thumbnails
      ? {
          metaCreativeThumbnail: {
            findMany: vi.fn(async () => options.thumbnails),
          },
        }
      : {}),
  };
  const funnel = {
    getConfiguration: vi.fn(async () => ({ stages: options.stages ?? journey() })),
  };
  const env = options.deferredReceipt
    ? { LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED: "true" }
    : {};
  const service = new CrmBoardService(prisma as any, funnel as any, env);
  return { service, prisma, queries, leadFindMany };
}

describe("CRM board layout and period", () => {
  it("columns follow the visible Jornada with Leads novos first; hidden stages are out", () => {
    const layout = crmLayoutFromJourney(
      journey({
        LeadSubmitted: { position: 2 },
        QualifiedLead: { position: 1 },
        Purchase: { visible: false },
      }),
      false,
    );
    expect(layout.columns.map((c) => [c.key, c.rank, c.label])).toEqual([
      ["LeadSubmitted", 1, "Leads novos"],
      ["QualifiedLead", 2, "Lead qualificado"],
    ]);
  });

  it("override mode prepends the read-only Conversas iniciadas; Purchase requires value", () => {
    const layout = crmLayoutFromJourney(journey(), true);
    expect(layout.columns[0]).toMatchObject({
      key: "conversations",
      kind: "conversations",
      label: "Conversas iniciadas",
      rank: 0,
      readOnly: true,
    });
    expect(layout.columns.at(-1)).toMatchObject({
      key: "Purchase",
      requiresValue: true,
      defaultValueCents: 49_700,
      defaultCurrency: "BRL",
    });
    expect(layout.stages.map((s) => s.eventName)).not.toContain("conversations");
  });

  it("a Jornada without visible stages is not configured", () => {
    const hidden = journey({
      LeadSubmitted: { visible: false },
      QualifiedLead: { visible: false },
      Purchase: { visible: false },
    });
    expect(crmLayoutFromJourney(hidden, false)).toEqual({
      journeyConfigured: false,
      columns: [],
      stages: [],
    });
  });

  it("defaults to the last 30 days (Sao Paulo) and bounds the period", () => {
    expect(resolveCrmRange({}, NOW)).toMatchObject({
      since: "2026-09-25",
      until: "2026-10-24",
      gte: new Date("2026-09-25T03:00:00.000Z"),
    });
    expect(() => resolveCrmRange({ since: "2026-10-10", until: "2026-10-01" })).toThrow(
      BadRequestException,
    );
    expect(() => resolveCrmRange({ since: "2025-01-01", until: "2026-10-01" })).toThrow(
      BadRequestException,
    );
  });
});

describe("CRM board service", () => {
  it("returns every column with totals, the first 20 cards and a cursor", async () => {
    for (let index = 0; index < 23; index += 1)
      await testDb.lead({
        id: `novo_${String(index).padStart(2, "0")}`,
        name: `Lead ${index}`,
        phoneDisplay: "+55 11 98765-4321",
        firstMessageAt: daysAgo(5 - index * 0.1),
      });
    await testDb.lead({ id: "buyer", name: "Mariana Costa", phoneDisplay: "+55 21 99876-1234" });
    await testDb.log({
      leadId: "buyer",
      eventName: "Purchase",
      status: "sent",
      at: daysAgo(1),
      valueCents: 49_700,
      currency: "BRL",
    });
    const { service, queries } = harness({
      instances: [
        { id: "inst_1", name: "Comercial", status: "active" },
        { id: "inst_2", name: "Suporte", status: "active" },
      ],
    });
    const board = await service.getBoard(WS, {}, { canMoveCards: true }, NOW);

    expect(board).toMatchObject({
      mode: "default",
      journeyConfigured: true,
      canMoveCards: true,
      showWhatsappNumber: true,
      range: { since: "2026-09-25", until: "2026-10-24" },
    });
    const [novos, qualified, purchase] = board.columns;
    expect(novos).toMatchObject({ key: "LeadSubmitted", total: 23 });
    expect(novos!.cards).toHaveLength(20);
    expect(novos!.cards[0]!.leadId).toBe("novo_22");
    expect(novos!.nextCursor).toEqual(expect.any(String));
    expect(qualified).toMatchObject({ total: 0, cards: [], nextCursor: null });
    expect(purchase).toMatchObject({ total: 1, nextCursor: null });
    expect(purchase!.cards[0]).toMatchObject({
      leadId: "buyer",
      name: "Mariana Costa",
      phoneDisplay: "+55 21 99876-1234",
      origin: "ctwa",
      campaignName: "Black Friday",
      adName: "Criativo carrossel",
      // Without a stored thumbnail (Fase 6.4): the ad thumbnail URL.
      creative: {
        thumbnailUrl: "https://cdn.example.test/ad_1.jpg",
        thumbnailVersion: null,
      },
      valueCents: 49_700,
      currency: "BRL",
    });
    // Value only on value columns.
    expect(novos!.cards[0]!.valueCents).toBeNull();
    // One aggregated query for the whole board.
    expect(queries).toHaveLength(1);

    const next = await service.getColumnPage(
      WS,
      "LeadSubmitted",
      { cursor: novos!.nextCursor! },
      NOW,
    );
    expect(next.cards.map((card) => card.leadId)).toEqual(["novo_02", "novo_01", "novo_00"]);
    expect(next).toMatchObject({ remaining: 0, nextCursor: null });
  });

  it("cards carry the stored creative thumbnail version (Fase 6.4)", async () => {
    await testDb.lead({ id: "buyer", adId: "ad_1", campaignId: "camp_1" });
    await testDb.log({
      leadId: "buyer",
      eventName: "Purchase",
      status: "sent",
      at: daysAgo(1),
    });
    const { service, prisma } = harness({
      thumbnails: [{ creativeId: "cr_1", version: "abcdef0123456789" }],
    });
    const board = await service.getBoard(WS, {}, { canMoveCards: true }, NOW);
    const card = board.columns.flatMap((column) => column.cards)[0];

    expect(card?.creative).toEqual({
      thumbnailUrl: "https://cdn.example.test/ad_1.jpg",
      thumbnailVersion: "abcdef0123456789",
    });
    expect(
      (prisma as { metaCreativeThumbnail: { findMany: unknown } })
        .metaCreativeThumbnail.findMany,
    ).toHaveBeenCalledWith({
      where: { workspaceId: WS, creativeId: { in: ["cr_1"] }, status: "ready" },
      select: { creativeId: true, version: true },
    });
  });

  it("override mode adds Conversas iniciadas with the deferred leads", async () => {
    await testDb.lead({ id: "deferred" });
    await testDb.log({
      leadId: "deferred",
      eventName: "LeadSubmitted",
      status: "not_eligible",
      errorCode: "lead_submitted_deferred_to_rule",
      at: daysAgo(2),
    });
    const { service } = harness({ deferredReceipt: true });
    const board = await service.getBoard(WS, {}, { canMoveCards: false }, NOW);
    expect(board.mode).toBe("rule_override");
    expect(board.columns[0]).toMatchObject({ key: "conversations", total: 1 });
    expect(board.columns[1]).toMatchObject({ key: "LeadSubmitted", total: 0 });
    expect(board.showWhatsappNumber).toBe(false);
  });

  it("filters by number and first-contact campaign without loading the period's leads", async () => {
    await testDb.lead({ id: "a", whatsappInstanceId: "inst_1", campaignId: "camp_1" });
    await testDb.lead({ id: "b", whatsappInstanceId: "inst_2", campaignId: "camp_2" });
    const { service, leadFindMany } = harness();
    const byNumber = await service.getBoard(
      WS,
      { whatsappInstanceId: "inst_2" },
      { canMoveCards: false },
      NOW,
    );
    expect(byNumber.columns[0]!.cards.map((c) => c.leadId)).toEqual(["b"]);
    const byCampaign = await service.getBoard(
      WS,
      { campaignId: "camp_1" },
      { canMoveCards: false },
      NOW,
    );
    expect(byCampaign.columns[0]!.cards.map((c) => c.leadId)).toEqual(["a"]);
    // Lead lookups are by card ids or by the campaign rows, never the period.
    for (const [args] of leadFindMany.mock.calls)
      expect(args.where.id?.in ?? args.where.campaignId).toBeTruthy();
  });

  it("Jornada without visible stages: no query, Configure a Jornada", async () => {
    const { service, queries } = harness({
      stages: journey({
        LeadSubmitted: { visible: false },
        QualifiedLead: { visible: false },
        Purchase: { visible: false },
      }),
    });
    const board = await service.getBoard(WS, {}, { canMoveCards: true }, NOW);
    expect(board).toMatchObject({ journeyConfigured: false, columns: [] });
    expect(queries).toHaveLength(0);
  });

  it("rejects an unknown column and an invalid cursor", async () => {
    const { service } = harness();
    await expect(service.getColumnPage(WS, "Nope", {}, NOW)).rejects.toThrow("Coluna");
    await expect(
      service.getColumnPage(WS, "LeadSubmitted", { cursor: "lixo" }, NOW),
    ).rejects.toThrow(BadRequestException);
  });
});

describe("CRM forward-only rule (API)", () => {
  it("accepts a later stage (skipping is allowed) and refuses backward/same/read-only", async () => {
    await testDb.lead({ id: "qualified" });
    await testDb.log({ leadId: "qualified", eventName: "QualifiedLead", status: "sent", at: daysAgo(1) });
    const { service } = harness();
    await expect(service.assertKanbanMove(WS, "qualified", "Purchase")).resolves.toEqual({
      fromRank: 2,
      toRank: 3,
      skipped: 0,
    });
    await testDb.lead({ id: "novo" });
    await expect(service.assertKanbanMove(WS, "novo", "Purchase")).resolves.toMatchObject({
      skipped: 1,
    });
    const backward = service.assertKanbanMove(WS, "qualified", "LeadSubmitted");
    await expect(backward).rejects.toBeInstanceOf(ConflictException);
    await expect(backward).rejects.toMatchObject({
      response: { code: "crm_backward_move", message: CRM_BACKWARD_MOVE_MESSAGE },
    });
    await expect(service.assertKanbanMove(WS, "qualified", "QualifiedLead")).rejects.toMatchObject({
      response: { code: "crm_same_stage" },
    });
    // A stage that is not on the board.
    await expect(service.assertKanbanMove(WS, "qualified", "AddToCart")).rejects.toMatchObject({
      response: { code: "crm_invalid_target" },
    });
  });

  it("override mode: a deferred lead may be moved to Leads novos (fires LeadSubmitted)", async () => {
    await testDb.lead({ id: "deferred" });
    await testDb.log({
      leadId: "deferred",
      eventName: "LeadSubmitted",
      status: "not_eligible",
      errorCode: "lead_submitted_deferred_to_rule",
      at: daysAgo(2),
    });
    const { service } = harness({ deferredReceipt: true });
    await expect(service.assertKanbanMove(WS, "deferred", "LeadSubmitted")).resolves.toEqual({
      fromRank: 0,
      toRank: 1,
      skipped: 0,
    });
  });
});

describe("CRM performance mitigation: 180-day cap, 15 s cache, query log", () => {
  it("caps the period at 180 days with a clear message", () => {
    expect(resolveCrmRange({ since: "2026-04-28", until: "2026-10-24" })).toMatchObject({
      since: "2026-04-28",
    });
    expect(() => resolveCrmRange({ since: "2026-04-27", until: "2026-10-24" })).toThrow(
      "Escolha um período de até 180 dias.",
    );
  });

  it("serves the auto-refresh from a 15 s cache per workspace + filters, user-independent", async () => {
    await testDb.lead({ id: "a" });
    const { service, queries } = harness();
    const first = await service.getBoard(WS, {}, { canMoveCards: true }, NOW);
    const second = await service.getBoard(
      WS,
      {},
      { canMoveCards: false },
      new Date(NOW.getTime() + 10_000),
    );
    expect(queries).toHaveLength(1);
    expect(second.columns).toEqual(first.columns);
    // The permission is applied per request, never cached.
    expect(second.canMoveCards).toBe(false);
    // Other filters are another entry; expiry after 15 s.
    await service.getBoard(WS, { whatsappInstanceId: "inst_1" }, { canMoveCards: true }, NOW);
    expect(queries).toHaveLength(2);
    await service.getBoard(WS, {}, { canMoveCards: true }, new Date(NOW.getTime() + 15_001));
    expect(queries).toHaveLength(3);
  });

  it("Atualizar (fresh) bypasses the cache; a manual conversion invalidates the workspace", async () => {
    await testDb.lead({ id: "a" });
    const { service, queries } = harness();
    await service.getBoard(WS, {}, { canMoveCards: true }, NOW);
    await service.getBoard(WS, { fresh: "1" }, { canMoveCards: true }, NOW);
    expect(queries).toHaveLength(2);
    await service.getBoard(WS, {}, { canMoveCards: true }, NOW);
    expect(queries).toHaveLength(2);
    service.invalidateWorkspace("ws_other");
    await service.getBoard(WS, {}, { canMoveCards: true }, NOW);
    expect(queries).toHaveLength(2);
    service.invalidateWorkspace(WS);
    await service.getBoard(WS, {}, { canMoveCards: true }, NOW);
    expect(queries).toHaveLength(3);
  });

  it("logs duration and lead count without PII; warns past 2 s", async () => {
    await testDb.lead({ id: "a", name: "Mariana Alves", phoneDisplay: "+55 11 99876-1020" });
    const { service } = harness();
    const logger = (service as any).logger;
    const log = vi.spyOn(logger, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await service.getBoard(WS, {}, { canMoveCards: true }, NOW);
    expect(log).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(log.mock.calls[0]![0]));
    expect(entry).toMatchObject({ event: "crm_board_query", workspaceId: WS, leadCount: 1 });
    expect(typeof entry.durationMs).toBe("number");
    expect(String(log.mock.calls[0]![0])).not.toMatch(/Mariana|99876/u);
    expect(warn).not.toHaveBeenCalled();
    const clock = vi.spyOn(Date, "now");
    // Every clock read advances 2.5 s: the measured query takes > 2 s.
    let tick = 0;
    clock.mockImplementation(() => (tick += 2_500));
    await service.getBoard(WS, { fresh: "1" }, { canMoveCards: true }, NOW);
    clock.mockRestore();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]![0])).durationMs).toBeGreaterThan(2_000);
  });
});

describe("CRM controller permissions", () => {
  async function app(role: "owner" | "member") {
    const board = {
      getBoard: vi.fn(async () => ({ columns: [] })),
      getColumnPage: vi.fn(async () => ({ cards: [] })),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [CrmController],
      providers: [
        {
          provide: AuthService,
          useValue: { getSession: vi.fn(async () => ({ user: { id: "u1" } })) },
        },
        {
          provide: WorkspacesService,
          useValue: {
            getCurrentWorkspace: vi.fn(() => ({
              id: WS,
              role,
              permissions: { canManageIntegrations: role === "owner" },
            })),
          },
        },
        { provide: CrmBoardService, useValue: board },
      ],
    }).compile();
    const nest = moduleRef.createNestApplication();
    await nest.init();
    return { nest, board };
  }

  it("members read the board (no move permission); owners may move", async () => {
    const member = await app("member");
    await request(member.nest.getHttpServer())
      .get("/crm/board?since=2026-10-01&until=2026-10-24&whatsappInstanceId=inst_1")
      .set("Authorization", "Bearer token")
      .expect(200);
    expect(member.board.getBoard).toHaveBeenCalledWith(
      WS,
      { since: "2026-10-01", until: "2026-10-24", whatsappInstanceId: "inst_1" },
      { canMoveCards: false },
    );
    await request(member.nest.getHttpServer())
      .get("/crm/board/columns/QualifiedLead?cursor=abc")
      .set("Authorization", "Bearer token")
      .expect(200);
    expect(member.board.getColumnPage).toHaveBeenCalledWith(WS, "QualifiedLead", {
      cursor: "abc",
    });
    await request(member.nest.getHttpServer())
      .get("/crm/board?since=ontem")
      .set("Authorization", "Bearer token")
      .expect(400);
    await member.nest.close();

    const owner = await app("owner");
    await request(owner.nest.getHttpServer())
      .get("/crm/board")
      .set("Authorization", "Bearer token")
      .expect(200);
    expect(owner.board.getBoard).toHaveBeenCalledWith(WS, {}, { canMoveCards: true });
    await owner.nest.close();
  });
});
