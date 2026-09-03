import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { BackofficeExternalDataController } from "../../src/external-data/backoffice-external-data.controller";
import { ExternalConnectorEgressPolicyService } from "../../src/external-data/external-connector-egress-policy.service";
import { ExternalDataService } from "../../src/external-data/external-data.service";
import { ExternalMysqlAdapter } from "../../src/external-data/external-mysql.adapter";

const credentials = {
  host: "mysql.example.test",
  port: 3306,
  database: "kinbox",
  username: "readonly",
  password: "never-expose-this-password",
};

describe("ExternalConnectorEgressPolicyService", () => {
  it.each([
    ["localhost", [{ address: "8.8.8.8", family: 4 }]],
    ["127.0.0.1", [{ address: "127.0.0.1", family: 4 }]],
    ["169.254.169.254", [{ address: "169.254.169.254", family: 4 }]],
    ["db.internal", [{ address: "10.0.0.5", family: 4 }]],
    ["db.internal", [{ address: "::1", family: 6 }]],
    ["db.internal", [{ address: "fd00:0:0:0:0:0:0:1", family: 6 }]],
    ["db.internal", [{ address: "fe80:0:0:0:0:0:0:1", family: 6 }]],
    ["db.internal", [{ address: "0:0:0:0:0:ffff:c0a8:1", family: 6 }]],
    ["metadata.google.internal", [{ address: "8.8.8.8", family: 4 }]],
  ])("fails closed for forbidden destination %s", async (host, resolved) => {
    const dnsLookup = vi.fn(async () => resolved);
    const policy = new ExternalConnectorEgressPolicyService(dnsLookup as never);

    await expect(
      policy.assertAllowed({ ...credentials, host }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("requires the MySQL port and rejects unresolved DNS", async () => {
    const policy = new ExternalConnectorEgressPolicyService(
      vi.fn(async () => {
        throw new Error("dns unavailable");
      }) as never,
    );

    await expect(
      policy.assertAllowed({ ...credentials, port: 3307 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(policy.assertAllowed(credentials)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("allows a hostname only when every resolved address is public", async () => {
    const dnsLookup = vi.fn(async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ]);
    const policy = new ExternalConnectorEgressPolicyService(dnsLookup as never);

    await expect(policy.assertAllowed(credentials)).resolves.toBeUndefined();
  });

  it("pins MySQL to the validated address instead of resolving a hostname again", async () => {
    const dnsLookup = vi
      .fn()
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const policy = new ExternalConnectorEgressPolicyService(dnsLookup as never);
    const factory = vi.fn(async () => ({
      query: vi.fn(async () => [[{ ok: 1 }]]),
      end: vi.fn(async () => undefined),
    }));
    const adapter = new ExternalMysqlAdapter(factory as never);

    const resolvedCredentials = await policy.resolveAllowed(credentials);
    await adapter.testConnection(resolvedCredentials, "disabled");

    expect(dnsLookup).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ host: "8.8.8.8" }),
    );
  });

  it("fails closed when DNS does not resolve before its independent deadline", async () => {
    const policy = new ExternalConnectorEgressPolicyService(
      vi.fn(() => new Promise(() => undefined)) as never,
      { WPPTRACK_EXTERNAL_MYSQL_DNS_TIMEOUT_MS: "10" },
    );

    await expect(policy.resolveAllowed(credentials)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("ExternalMysqlAdapter", () => {
  it("uses time limits, disables multiple statements, and establishes a read-only session", async () => {
    const query = vi.fn(async ({ sql }: { sql: string; timeout: number }) => {
      if (sql.includes("information_schema.VIEWS")) {
        return [
          [
            { TABLE_NAME: "vw_wpptrack_leads" },
            { TABLE_NAME: "vw_wpptrack_events" },
          ],
        ];
      }
      return [[{ ok: 1 }]];
    });
    const connection = { query, end: vi.fn(async () => undefined) };
    const factory = vi.fn(async () => connection);
    const adapter = new ExternalMysqlAdapter(factory as never, {
      WPPTRACK_EXTERNAL_MYSQL_CONNECT_TIMEOUT_MS: "1234",
      WPPTRACK_EXTERNAL_MYSQL_QUERY_TIMEOUT_MS: "5678",
    });

    await expect(
      adapter.testConnection(credentials, "required"),
    ).resolves.toMatchObject({
      ok: true,
      status: "connected",
    });
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        connectTimeout: 1234,
        multipleStatements: false,
      }),
    );
    expect(query.mock.calls[0]?.[0]).toMatchObject({
      sql: "SET SESSION TRANSACTION READ ONLY",
    });
    expect(query.mock.calls.every(([input]) => input.timeout === 5678)).toBe(
      true,
    );
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  it("caps configured connection and query timeouts", async () => {
    const query = vi.fn(async (_input: { sql: string; timeout: number }) => [
      [{ ok: 1 }],
    ]);
    const factory = vi.fn(async () => ({
      query,
      end: vi.fn(async () => undefined),
    }));
    const adapter = new ExternalMysqlAdapter(factory as never, {
      WPPTRACK_EXTERNAL_MYSQL_CONNECT_TIMEOUT_MS: "999999",
      WPPTRACK_EXTERNAL_MYSQL_QUERY_TIMEOUT_MS: "999999",
    });

    await adapter.testConnection(credentials, "required");
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ connectTimeout: 30_000 }),
    );
    expect(query.mock.calls.every(([input]) => input.timeout === 30_000)).toBe(
      true,
    );
  });

  it("normalizes driver failures without exposing credentials or driver messages", async () => {
    const adapter = new ExternalMysqlAdapter(
      vi.fn(async () => {
        throw Object.assign(new Error("password never-expose-this-password"), {
          code: "ER_ACCESS_DENIED_ERROR",
        });
      }) as never,
    );

    const result = await adapter.testConnection(credentials, "required");
    expect(result).toMatchObject({
      ok: false,
      errorCode: "ER_ACCESS_DENIED_ERROR",
    });
    expect(JSON.stringify(result)).not.toContain(credentials.password);
    expect(JSON.stringify(result)).not.toContain("password never-expose");
  });

  it("returns a bounded safe timeout result", async () => {
    const adapter = new ExternalMysqlAdapter(
      vi.fn(async () => ({
        query: vi.fn(async () => {
          throw { code: "ETIMEDOUT" };
        }),
        end: vi.fn(async () => undefined),
      })) as never,
    );

    await expect(
      adapter.testConnection(credentials, "required"),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "ETIMEDOUT",
      message: "A conexao MySQL excedeu o tempo limite",
    });
  });
});

describe("BackofficeExternalDataController", () => {
  function controller() {
    const platformAdmin = {
      assertPlatformOwner: vi.fn(async () => ({
        id: "owner_1",
        role: "platform_owner",
      })),
    };
    const externalData = {
      listWorkspaceConnectors: vi.fn(async () => []),
      createWorkspaceConnector: vi.fn(async () => ({ id: "connector_1" })),
      testWorkspaceConnection: vi.fn(async () => ({ ok: true })),
      getWorkspaceConnectorStatus: vi.fn(async () => ({ id: "connector_1" })),
    };
    return {
      controller: new BackofficeExternalDataController(
        platformAdmin as never,
        externalData as never,
      ),
      platformAdmin,
      externalData,
    };
  }

  it("requires a platform owner and passes explicit workspace scope to every connector lookup", async () => {
    const harness = controller();

    await harness.controller.list("token", "workspace_a");
    await harness.controller.test("token", "workspace_a", "connector_a");
    await harness.controller.status("token", "workspace_a", "connector_a");
    expect(harness.externalData.listWorkspaceConnectors).toHaveBeenCalledWith(
      "workspace_a",
      "owner_1",
    );
    expect(harness.externalData.testWorkspaceConnection).toHaveBeenCalledWith(
      "workspace_a",
      "connector_a",
      "owner_1",
    );
    expect(
      harness.externalData.getWorkspaceConnectorStatus,
    ).toHaveBeenCalledWith("workspace_a", "connector_a", "owner_1");

    harness.platformAdmin.assertPlatformOwner.mockRejectedValueOnce(
      new ForbiddenException(),
    );
    await expect(
      harness.controller.list("non-owner", "workspace_a"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects cross-workspace input and any attempt to enable sync or CAPI", async () => {
    const harness = controller();
    const body = {
      workspaceId: "workspace_b",
      name: "Banco externo",
      credentials,
    };
    await expect(
      harness.controller.create("token", "workspace_a", body),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      harness.controller.create("token", "workspace_a", {
        ...body,
        workspaceId: "workspace_a",
        syncEnabled: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(
      harness.externalData.createWorkspaceConnector,
    ).not.toHaveBeenCalled();
  });
});

describe("ExternalDataService workspace scoping", () => {
  it("uses a workspace-bound lookup for status and never serializes encrypted credentials", async () => {
    const prisma = {
      externalDataConnector: {
        findFirst: vi.fn(async () => ({
          id: "connector_a",
          workspaceId: "workspace_a",
          name: "Banco externo",
          provider: "kinbox_mysql",
          status: "draft",
          timezone: "America/Sao_Paulo",
          sslMode: "required",
          credentialsEncrypted: "ciphertext",
          credentialsIv: "iv",
          credentialsTag: "tag",
          syncEnabled: false,
          shadowMode: true,
          capiSendEnabled: false,
          purchaseAverageValueCents: null,
          defaultCurrency: "BRL",
          lastConnectionTestAt: null,
          lastConnectionStatus: null,
          lastSyncStartedAt: null,
          lastSyncCompletedAt: null,
          lastSyncStatus: null,
          lastSyncErrorCode: null,
          createdAt: new Date("2026-09-03T10:00:00.000Z"),
          updatedAt: new Date("2026-09-03T10:00:00.000Z"),
          cursors: [],
          capiCutovers: [],
        })),
      },
    };
    const service = new ExternalDataService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await service.getWorkspaceConnectorStatus(
      "workspace_a",
      "connector_a",
      "owner_1",
    );
    expect(prisma.externalDataConnector.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "connector_a", workspaceId: "workspace_a" },
      }),
    );
    expect(JSON.stringify(result)).not.toContain("ciphertext");
    expect(JSON.stringify(result)).not.toContain("credentialsIv");
  });
});
