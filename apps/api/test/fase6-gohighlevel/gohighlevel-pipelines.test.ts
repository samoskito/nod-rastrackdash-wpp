import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BadGatewayException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { GoHighLevelPipelinesService } from "../../src/inbound-webhooks/gohighlevel-pipelines.service";
import { InboundWebhookPayloadEncryptionService } from "../../src/inbound-webhooks/inbound-webhook-payload-encryption.service";
import {
  GHL_API_VERSION,
  GhlPipelinesAdapter,
} from "../../src/inbound-webhooks/providers/gohighlevel/gohighlevel-pipelines.adapter";

/** No real call: fetch is a mock; the token below is a fictitious string. */
const TOKEN = "pit-FICTICIO-0000000000000000000000";
const pipelinesBody = {
  pipelines: [
    {
      id: "PIPELINE_ID_FICTICIO",
      name: "Funil Exemplo",
      stages: [
        { id: "STAGE_ID_1", name: "Novo", position: 0 },
        { id: "STAGE_ID_2", name: "Proposta enviada", position: 1 },
      ],
    },
  ],
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("GoHighLevel pipelines adapter (mock HTTP)", () => {
  it("calls the confirmed endpoint with Bearer + Version and maps the answer", async () => {
    const fetchMock = vi.fn(async () => json(pipelinesBody));
    const adapter = new GhlPipelinesAdapter(fetchMock as unknown as typeof fetch);
    const result = await adapter.listPipelines("LOCATION_ID_FICTICIO", TOKEN);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin).toBe("https://services.leadconnectorhq.com");
    expect(url.pathname).toBe("/opportunities/pipelines");
    expect(url.searchParams.get("locationId")).toBe("LOCATION_ID_FICTICIO");
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      Version: GHL_API_VERSION,
    });
    expect(result).toEqual([
      {
        id: "PIPELINE_ID_FICTICIO",
        name: "Funil Exemplo",
        stages: [
          { id: "STAGE_ID_1", name: "Novo" },
          { id: "STAGE_ID_2", name: "Proposta enviada" },
        ],
      },
    ]);
  });

  it.each([
    [401, "ghl_unauthorized"],
    [403, "ghl_forbidden"],
    [429, "ghl_rate_limited"],
    [500, "ghl_transport"],
  ])("maps HTTP %s to %s without echoing the token", async (status, code) => {
    const adapter = new GhlPipelinesAdapter((async () =>
      json({ message: `bad ${TOKEN}` }, status)) as unknown as typeof fetch);
    await expect(adapter.listPipelines("L", TOKEN)).rejects.toMatchObject({
      code,
      message: code,
    });
  });

  it("rejects a malformed answer and a transport failure", async () => {
    await expect(
      new GhlPipelinesAdapter((async () =>
        json({ pipelines: [{ id: "x" }] })) as unknown as typeof fetch).listPipelines("L", TOKEN),
    ).rejects.toMatchObject({ code: "ghl_invalid_response" });
    await expect(
      new GhlPipelinesAdapter((async () => {
        throw new Error(`boom ${TOKEN}`);
      }) as unknown as typeof fetch).listPipelines("L", TOKEN),
    ).rejects.toMatchObject({ code: "ghl_transport", message: "ghl_transport" });
  });
});

describe("GoHighLevel pipelines service (token is encrypted, never returned)", () => {
  const encryption = new InboundWebhookPayloadEncryptionService({
    NODE_ENV: "test",
    API_PUBLIC_URL: "https://api.example.test",
    INBOUND_WEBHOOKS_ENABLED: "true",
    INBOUND_CONVERSION_RULES_ENABLED: "true",
    INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  });

  function build(fetchImpl: typeof fetch) {
    let stored: Record<string, unknown> = {};
    const connection = () => ({
      id: "conn_1",
      workspaceId: "ws_1",
      ghlTokenCiphertext: null,
      ghlTokenIv: null,
      ghlTokenTag: null,
      ghlTokenKeyVersion: null,
      ...stored,
    });
    const prisma = {
      inboundWebhookConnection: {
        findFirst: vi.fn(async (args: { where: { id: string } }) =>
          args.where.id === "conn_1" ? connection() : null,
        ),
        update: vi.fn(async (args: { data: Record<string, unknown> }) => {
          stored = { ...stored, ...args.data };
        }),
      },
      inboundWebhookChannel: {
        findFirst: vi.fn(async () => ({ providerChannelId: "LOCATION_ID_FICTICIO" })),
      },
    };
    const service = new GoHighLevelPipelinesService(
      prisma as never,
      encryption,
      new GhlPipelinesAdapter(fetchImpl),
    );
    return { service, prisma, stored: () => stored };
  }

  it("without a token the list is empty and says so", async () => {
    const fetchMock = vi.fn();
    const { service } = build(fetchMock as unknown as typeof fetch);
    await expect(service.listPipelines("ws_1", "conn_1")).resolves.toEqual({
      tokenConfigured: false,
      pipelines: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores the token encrypted, answers only configured yes/no, and lists with it", async () => {
    const fetchMock = vi.fn(async () => json(pipelinesBody));
    const { service, stored } = build(fetchMock as unknown as typeof fetch);
    const saved = await service.saveToken("ws_1", "conn_1", TOKEN);

    expect(saved).toEqual({ tokenConfigured: true });
    expect(JSON.stringify(stored())).not.toContain(TOKEN);
    const listed = await service.listPipelines("ws_1", "conn_1");
    expect(listed.tokenConfigured).toBe(true);
    expect(listed.pipelines[0]?.stages).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain(TOKEN);
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });

    await expect(service.saveToken("ws_1", "conn_1", null)).resolves.toEqual({
      tokenConfigured: false,
    });
    expect(stored()).toMatchObject({ ghlTokenCiphertext: null });
  });

  it("turns a GHL failure into a clear error that never carries the token", async () => {
    const { service } = build((async () =>
      json({ message: TOKEN }, 401)) as unknown as typeof fetch);
    await service.saveToken("ws_1", "conn_1", TOKEN);
    const failure = await service.listPipelines("ws_1", "conn_1").catch((e) => e);
    expect(failure).toBeInstanceOf(BadGatewayException);
    expect(JSON.stringify(failure.getResponse())).not.toContain(TOKEN);
    expect(failure.getResponse()).toMatchObject({ code: "ghl_unauthorized" });
  });

  it("is not found for another workspace's or a missing connection", async () => {
    const { service } = build(fetch);
    await expect(service.listPipelines("ws_1", "other")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("GoHighLevel stage rename: current name by stage id (cached)", () => {
  const encryption = new InboundWebhookPayloadEncryptionService({
    NODE_ENV: "test",
    API_PUBLIC_URL: "https://api.example.test",
    INBOUND_WEBHOOKS_ENABLED: "true",
    INBOUND_CONVERSION_RULES_ENABLED: "true",
    INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  });

  function build(fetchImpl: typeof fetch) {
    let stored: Record<string, unknown> = {};
    const prisma = {
      inboundWebhookConnection: {
        findFirst: vi.fn(async () => ({
          id: "conn_1",
          workspaceId: "ws_1",
          ghlTokenCiphertext: null,
          ghlTokenIv: null,
          ghlTokenTag: null,
          ghlTokenKeyVersion: null,
          ...stored,
        })),
        update: vi.fn(async (args: { data: Record<string, unknown> }) => {
          stored = { ...stored, ...args.data };
        }),
      },
      inboundWebhookChannel: {
        findFirst: vi.fn(async () => ({ providerChannelId: "LOCATION_ID_FICTICIO" })),
      },
    };
    const service = new GoHighLevelPipelinesService(
      prisma as never,
      encryption,
      new GhlPipelinesAdapter(fetchImpl),
    );
    let clock = 1_000;
    service.now = () => clock;
    return { service, advance: (ms: number) => (clock += ms) };
  }
  const renamed = {
    pipelines: [
      {
        id: "PIPELINE_ID_FICTICIO",
        name: "Funil Exemplo",
        stages: [{ id: "STAGE_ID_2", name: "Proposta aceita" }],
      },
    ],
  };

  it("resolves the stage id to its CURRENT name and caches it for 10 minutes", async () => {
    const fetchMock = vi.fn(async () => json(renamed));
    const { service, advance } = build(fetchMock as unknown as typeof fetch);
    await service.saveToken("ws_1", "conn_1", TOKEN);

    await service.warmStageNames("ws_1", "conn_1");
    expect(service.peekStageName("conn_1", "PIPELINE_ID_FICTICIO", "STAGE_ID_2")).toBe(
      "Proposta aceita",
    );
    await service.warmStageNames("ws_1", "conn_1");
    advance(9 * 60_000);
    await service.warmStageNames("ws_1", "conn_1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(2 * 60_000);
    await service.warmStageNames("ws_1", "conn_1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A stage that no longer exists has no current name (saved name is used).
    expect(service.peekStageName("conn_1", "PIPELINE_ID_FICTICIO", "GONE")).toBeNull();
  });

  it("falls back to the saved name without a token or when the API fails (never throws)", async () => {
    const noToken = build(vi.fn() as unknown as typeof fetch);
    await expect(noToken.service.warmStageNames("ws_1", "conn_1")).resolves.toBeUndefined();
    expect(noToken.service.peekStageName("conn_1", "P", "S")).toBeNull();

    const failing = build((async () => json({}, 500)) as unknown as typeof fetch);
    await failing.service.saveToken("ws_1", "conn_1", TOKEN);
    await expect(failing.service.warmStageNames("ws_1", "conn_1")).resolves.toBeUndefined();
    expect(failing.service.peekStageName("conn_1", "PIPELINE_ID_FICTICIO", "STAGE_ID_2")).toBeNull();
  });
});

describe("GoHighLevel pipeline stage migration (nod, produção direta)", () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      "../../prisma/migrations/20261123120000_gohighlevel_pipeline_stage/migration.sql",
    ),
    "utf8",
  )
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  it("is additive only and seeds automation-v2 already certified", () => {
    expect(sql).not.toMatch(/\b(DROP|DELETE|UPDATE|SET NOT NULL|RENAME)\b/i);
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "ghlPipelineId" VARCHAR(255)');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "ghlTokenCiphertext" TEXT');
    expect(sql).toContain("'automation-v2'");
    expect(sql).toContain("'certified'");
    expect(sql).not.toContain("'observation_only'");
    expect(sql).toContain('ON CONFLICT ("provider", "version") DO NOTHING');
    // Only the new release: v1 and automation-v1 rows are never touched.
    expect(sql).not.toMatch(/'automation-v1'|'v1'/);
  });
});
