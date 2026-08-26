import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash as nodeCreateHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  backofficeWorkspaceCreateInputSchema,
  type BackofficeWorkspaceCreateInputDto,
} from "@wpptrack/shared";
import { Prisma, type PlatformRole } from "@prisma/client";
import { BackofficeWorkspacesController } from "../src/workspaces/backoffice-workspaces.controller";
import { PlatformWorkspaceAccessService } from "../src/workspaces/platform-workspace-access.service";

type UserState = {
  id: string;
  name: string | null;
  email: string;
  passwordHash: string | null;
  platformRole: PlatformRole | null;
};

type State = {
  users: UserState[];
  workspaces: Array<{
    id: string;
    name: string;
    slug: string;
    operationalStatus: "active" | "blocked";
    createdAt: Date;
  }>;
  members: Array<{
    id: string;
    workspaceId: string;
    userId: string;
    role: "owner" | "admin" | "member";
  }>;
  tokens: Array<{
    id: string;
    userId: string;
    workspaceId: string;
    type: "account_activation";
    tokenHash: string;
    usedAt?: Date;
  }>;
  audits: Array<{
    action: string;
    workspaceId: string | null;
    afterSummary?: unknown;
  }>;
};

function makeHarness(initialUsers: UserState[] = []) {
  const events: string[] = [];
  const state: State = {
    users: initialUsers,
    workspaces: [],
    members: [],
    tokens: [],
    audits: [],
  };
  let nextId = 1;
  const id = (prefix: string) => `${prefix}_${nextId++}`;

  const prisma: any = {
    user: {
      findUnique: vi.fn(
        async ({ where }: any) =>
          state.users.find((user) =>
            where.email ? user.email === where.email : user.id === where.id,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: any) => {
        const user = {
          id: id("user"),
          name: data.name ?? null,
          email: data.email,
          passwordHash: data.passwordHash ?? null,
          platformRole: data.platformRole ?? null,
        };
        state.users.push(user);
        return user;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const user = state.users.find(
          (candidate) => candidate.id === where.id,
        )!;
        Object.assign(user, data);
        return user;
      }),
    },
    workspace: {
      findUnique: vi.fn(
        async ({ where }: any) =>
          state.workspaces.find((workspace) =>
            where.slug
              ? workspace.slug === where.slug
              : workspace.id === where.id,
          ) ?? null,
      ),
      findMany: vi.fn(async () =>
        state.workspaces.map((workspace) => ({
          ...workspace,
          members: state.members
            .filter(
              (member) =>
                member.workspaceId === workspace.id && member.role === "owner",
            )
            .slice(0, 1)
            .map((member) => ({
              role: member.role,
              user: state.users.find((user) => user.id === member.userId),
            })),
        })),
      ),
      create: vi.fn(async ({ data }: any) => {
        const workspace = {
          id: id("workspace"),
          name: data.name,
          slug: data.slug,
          operationalStatus: "active" as const,
          createdAt: new Date("2026-08-26T10:00:00.000Z"),
        };
        state.workspaces.push(workspace);
        return workspace;
      }),
    },
    workspaceMember: {
      create: vi.fn(async ({ data }: any) => {
        if (prisma.workspaceMember.failCreate) {
          throw new Error("membership failed");
        }
        const member = { id: id("member"), ...data };
        state.members.push(member);
        return member;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        events.push("owner-read");
        const member = state.members.find(
          (candidate) =>
            candidate.workspaceId === where.workspaceId &&
            candidate.userId === where.userId &&
            candidate.role === where.role,
        );
        if (!member) return null;
        return {
          id: member.id,
          workspace: {
            id: member.workspaceId,
            name: state.workspaces.find(
              (workspace) => workspace.id === member.workspaceId,
            )?.name,
          },
          user: state.users.find((user) => user.id === member.userId),
        };
      }),
      failCreate: false,
    },
    authActionToken: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        events.push("token-update");
        let count = 0;
        for (const token of state.tokens) {
          if (
            token.userId === where.userId &&
            token.usedAt == null &&
            token.type === where.type
          ) {
            Object.assign(token, data);
            count += 1;
          }
        }
        return { count };
      }),
      create: vi.fn(async ({ data }: any) => {
        events.push("token-create");
        const token = { id: id("token"), ...data };
        state.tokens.push(token);
        return token;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        state.audits.push(data);
        return data;
      }),
    },
    $queryRaw: vi.fn(async () => {
      events.push("activation-lock");
      return [];
    }),
  };
  prisma.$transaction = vi.fn(async (callback: (tx: any) => unknown) => {
    const snapshot = structuredClone(state);
    try {
      return await callback(prisma);
    } catch (error) {
      state.users = snapshot.users;
      state.workspaces = snapshot.workspaces;
      state.members = snapshot.members;
      state.tokens = snapshot.tokens;
      state.audits = snapshot.audits;
      throw error;
    }
  });

  return { prisma, state, events };
}

const owner = {
  id: "platform-owner",
  email: "owner@example.com",
  role: "platform_owner" as const,
};
const operator = {
  id: "platform-operator",
  email: "operator@example.com",
  role: "platform_operator" as const,
};

function input(overrides: Partial<BackofficeWorkspaceCreateInputDto> = {}) {
  return {
    name: "Cliente Real",
    responsible: {
      name: "Responsavel Real",
      email: "responsavel@example.com",
    },
    reuseExistingUser: false,
    ...overrides,
  } satisfies BackofficeWorkspaceCreateInputDto;
}

describe("backoffice workspace contracts", () => {
  it("rejects extra fields and platformRole in the create payload", () => {
    expect(
      backofficeWorkspaceCreateInputSchema.safeParse({
        ...input(),
        platformRole: "platform_owner",
      }).success,
    ).toBe(false);
    expect(
      backofficeWorkspaceCreateInputSchema.safeParse({
        ...input(),
        responsible: { ...input().responsible, password: "secret" },
      }).success,
    ).toBe(false);
  });
});

describe("platform workspace access", () => {
  let emailQueue: {
    isEnabled: ReturnType<typeof vi.fn>;
    enqueue: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    emailQueue = {
      isEnabled: vi.fn(() => true),
      enqueue: vi.fn(async () => ({ status: "queued" })),
    };
  });

  it("creates a real workspace and pending owner in one transaction", async () => {
    const harness = makeHarness();
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    const result = await service.createWorkspace(input(), owner);

    expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result.responsible).toMatchObject({
      email: "responsavel@example.com",
      role: "owner",
      status: "pending_activation",
    });
    expect(result).not.toHaveProperty("passwordHash");
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("secret");
    expect(harness.state.workspaces).toHaveLength(1);
    expect(harness.state.members[0]?.role).toBe("owner");
    expect(harness.state.tokens).toHaveLength(1);
    expect(emailQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: result.id,
        envelope: expect.objectContaining({
          template: "client_owner_activation",
        }),
      }),
    );
    expect(harness.state.audits.map((audit) => audit.action)).toEqual([
      "backoffice.workspace_created",
      "backoffice.workspace_responsible_invited",
    ]);
  });

  it("does not reuse an existing user without explicit confirmation", async () => {
    const harness = makeHarness([
      {
        id: "existing-user",
        name: "Existing",
        email: "responsavel@example.com",
        passwordHash: "bcrypt-hash",
        platformRole: null,
      },
    ]);
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    await expect(
      service.createWorkspace(input(), owner),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(harness.state.workspaces).toHaveLength(0);
  });

  it("returns an explicit delivery failure without exposing the activation token", async () => {
    const harness = makeHarness();
    emailQueue.enqueue.mockRejectedValueOnce(new Error("queue failed"));
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    const result = await service.createWorkspace(input(), owner);

    expect(result.deliveryStatus).toBe("failed");
    expect(result).not.toHaveProperty("token");
    expect(harness.state.audits.at(-1)?.action).toBe(
      "backoffice.workspace_responsible_delivery_failed",
    );
  });

  it("retries a slug collision without returning the database error", async () => {
    const harness = makeHarness();
    harness.prisma.workspace.create.mockRejectedValueOnce(
      knownUniqueConstraint(["slug"]),
    );
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    const result = await service.createWorkspace(input(), owner);

    expect(result.slug).toBe("cliente-real");
    expect(harness.prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("maps a raced responsible email insert to a controlled conflict and rolls back", async () => {
    const harness = makeHarness();
    harness.prisma.user.create.mockRejectedValueOnce(
      knownUniqueConstraint(["email"]),
    );
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    await expect(service.createWorkspace(input(), owner)).rejects.toMatchObject(
      {
        constructor: ConflictException,
        message: "Email ja cadastrado",
      },
    );
    expect(harness.state.workspaces).toHaveLength(0);
    expect(harness.state.users).toHaveLength(0);
  });

  it("rotates a pending owner activation, queues it, and never returns its token", async () => {
    const harness = makeHarness();
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );
    const created = await service.createWorkspace(input(), owner);
    const ownerUserId = harness.state.users[0]!.id;
    const previousToken = harness.state.tokens[0]!;

    const result = await service.reissueClientOwnerActivation(
      created.id,
      ownerUserId,
      owner,
    );

    expect(result).toEqual({ accepted: true, deliveryStatus: "queued" });
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("activationUrl");
    expect(previousToken.usedAt).toBeInstanceOf(Date);
    expect(harness.state.tokens).toHaveLength(2);
    expect(harness.state.tokens[1]?.usedAt).toBeUndefined();
    expect(emailQueue.enqueue).toHaveBeenCalledTimes(2);
    expect(harness.state.audits.map((audit) => audit.action)).toContain(
      "backoffice.workspace_owner_activation_reissued",
    );
    expect(harness.state.audits.map((audit) => audit.action)).toContain(
      "backoffice.workspace_owner_activation_delivery_queued",
    );
    expect(JSON.stringify(harness.state.audits)).not.toContain(
      harness.state.tokens[1]?.tokenHash,
    );
  });

  it("returns a manual activation link without SMTP and persists only its hash", async () => {
    const harness = makeHarness();
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
      { WEB_ORIGIN: "https://console.example.com" },
    );
    const created = await service.createWorkspace(input(), owner);
    const previousToken = harness.state.tokens[0]!;
    emailQueue.isEnabled.mockReturnValue(false);
    emailQueue.enqueue.mockClear();

    const result = await service.createClientOwnerActivationLink(
      created.id,
      harness.state.users[0]!.id,
      owner,
    );
    const activationUrl = new URL(result.activationUrl);
    const rawToken = activationUrl.searchParams.get("token");

    expect(result).toMatchObject({
      ok: true,
      mode: "activation",
      delivery: "link_only",
      expiresAt: expect.any(String),
      emailAttempted: false,
    });
    expect(activationUrl.origin).toBe("https://console.example.com");
    expect(activationUrl.pathname).toBe("/login/activate");
    expect(rawToken).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.state.tokens).toHaveLength(2);
    expect(previousToken.usedAt).toBeInstanceOf(Date);
    expect(harness.state.tokens[1]?.tokenHash).toBe(createHash(rawToken!));
    expect(emailQueue.enqueue).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.state.audits)).not.toContain(rawToken);
    expect(JSON.stringify(harness.state.audits)).not.toContain(
      result.activationUrl,
    );
  });

  it("takes the canonical activation lock before reading and rotating the owner token", async () => {
    const harness = makeHarness();
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
      { WEB_ORIGIN: "https://console.example.com" },
    );
    const created = await service.createWorkspace(input(), owner);
    harness.events.length = 0;

    await service.createClientOwnerActivationLink(
      created.id,
      harness.state.users[0]!.id,
      owner,
    );

    expect(harness.events.indexOf("activation-lock")).toBe(0);
    expect(harness.events.indexOf("activation-lock")).toBeLessThan(
      harness.events.indexOf("owner-read"),
    );
    expect(harness.events.indexOf("activation-lock")).toBeLessThan(
      harness.events.indexOf("token-update"),
    );
  });

  it("fails closed instead of falling back to localhost when WEB_ORIGIN is absent", async () => {
    const harness = makeHarness();
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
      { NODE_ENV: "production" },
    );
    const created = await service.createWorkspace(input(), owner);
    const tokenStateBeforeRequest = structuredClone(harness.state.tokens);

    await expect(
      service.createClientOwnerActivationLink(
        created.id,
        harness.state.users[0]!.id,
        owner,
      ),
    ).rejects.toThrow("Invalid WEB_ORIGIN");

    expect(harness.state.tokens).toEqual(tokenStateBeforeRequest);
    expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(harness.prisma.authActionToken.updateMany).toHaveBeenCalledTimes(1);
    expect(harness.prisma.authActionToken.create).toHaveBeenCalledTimes(1);
  });

  it("keeps manual activation scoped to the exact pending client owner", async () => {
    const harness = makeHarness([
      {
        id: "platform-user",
        name: "Platform",
        email: "platform@example.com",
        passwordHash: null,
        platformRole: "platform_owner",
      },
    ]);
    harness.state.workspaces.push({
      id: "workspace-1",
      name: "Cliente Real",
      slug: "cliente-real",
      operationalStatus: "active",
      createdAt: new Date("2026-08-26T10:00:00.000Z"),
    });
    harness.state.members.push({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "platform-user",
      role: "owner",
    });
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
      { WEB_ORIGIN: "https://console.example.com" },
    );

    await expect(
      service.createClientOwnerActivationLink(
        "other-workspace",
        "platform-user",
        owner,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.createClientOwnerActivationLink(
        "workspace-1",
        "platform-user",
        owner,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.state.tokens).toHaveLength(0);
  });

  it("does not issue a manual link for an already activated owner", async () => {
    const harness = makeHarness([
      {
        id: "active-user",
        name: "Active",
        email: "active@example.com",
        passwordHash: "bcrypt-hash",
        platformRole: null,
      },
    ]);
    harness.state.workspaces.push({
      id: "workspace-1",
      name: "Cliente Real",
      slug: "cliente-real",
      operationalStatus: "active",
      createdAt: new Date("2026-08-26T10:00:00.000Z"),
    });
    harness.state.members.push({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "active-user",
      role: "owner",
    });
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
      { WEB_ORIGIN: "https://console.example.com" },
    );

    await expect(
      service.createClientOwnerActivationLink(
        "workspace-1",
        "active-user",
        owner,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(harness.state.tokens).toHaveLength(0);
  });

  it("rejects an IDOR and platform-admin owner before issuing a token", async () => {
    const harness = makeHarness([
      {
        id: "platform-user",
        name: "Platform",
        email: "platform@example.com",
        passwordHash: null,
        platformRole: "platform_owner",
      },
    ]);
    harness.state.workspaces.push({
      id: "workspace-1",
      name: "Cliente Real",
      slug: "cliente-real",
      operationalStatus: "active",
      createdAt: new Date("2026-08-26T10:00:00.000Z"),
    });
    harness.state.members.push({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "platform-user",
      role: "owner",
    });
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    await expect(
      service.reissueClientOwnerActivation(
        "other-workspace",
        "platform-user",
        owner,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.reissueClientOwnerActivation(
        "workspace-1",
        "platform-user",
        owner,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.state.tokens).toHaveLength(0);
  });

  it("makes enqueue failure explicit and audits the failure while keeping reissue durable", async () => {
    const harness = makeHarness();
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );
    const created = await service.createWorkspace(input(), owner);
    emailQueue.enqueue.mockRejectedValueOnce(new Error("queue failed"));

    await expect(
      service.reissueClientOwnerActivation(
        created.id,
        harness.state.users[0]!.id,
        owner,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(harness.state.tokens.at(-1)?.usedAt).toBeUndefined();
    expect(harness.state.audits.at(-1)?.action).toBe(
      "backoffice.workspace_owner_activation_delivery_failed",
    );
  });

  it("reuses an existing client user only with confirmation and never promotes it", async () => {
    const harness = makeHarness([
      {
        id: "existing-user",
        name: "Existing",
        email: "responsavel@example.com",
        passwordHash: "bcrypt-hash",
        platformRole: null,
      },
    ]);
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    const result = await service.createWorkspace(
      input({ reuseExistingUser: true }),
      owner,
    );

    expect(result.reusedExistingUser).toBe(true);
    expect(result.deliveryStatus).toBe("not_required");
    expect(result.responsible?.status).toBe("active");
    expect(harness.state.users[0]?.platformRole).toBeNull();
    expect(harness.state.tokens).toHaveLength(0);
    expect(harness.state.audits.at(-1)?.action).toBe(
      "backoffice.workspace_responsible_reused",
    );
  });

  it("rolls back workspace and user state when membership creation fails", async () => {
    const harness = makeHarness();
    harness.prisma.workspaceMember.failCreate = true;
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    await expect(service.createWorkspace(input(), owner)).rejects.toThrow(
      "membership failed",
    );
    expect(harness.state.workspaces).toHaveLength(0);
    expect(harness.state.users).toHaveLength(0);
    expect(harness.state.members).toHaveLength(0);
    expect(harness.state.audits).toHaveLength(0);
  });

  it("lists only persisted workspace data without credentials", async () => {
    const harness = makeHarness([
      {
        id: "existing-user",
        name: "Existing",
        email: "responsavel@example.com",
        passwordHash: "bcrypt-hash",
        platformRole: null,
      },
    ]);
    harness.state.workspaces.push({
      id: "workspace-1",
      name: "Cliente Real",
      slug: "cliente-real",
      operationalStatus: "active",
      createdAt: new Date("2026-08-26T10:00:00.000Z"),
    });
    harness.state.members.push({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "existing-user",
      role: "owner",
    });
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    const result = await service.listWorkspaces();

    expect(result).toEqual([
      expect.objectContaining({
        id: "workspace-1",
        responsible: expect.objectContaining({ status: "active" }),
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("bcrypt-hash");
    expect(JSON.stringify(result)).not.toContain("token");
  });
});

function knownUniqueConstraint(target: readonly string[]) {
  return new Prisma.PrismaClientKnownRequestError("unique constraint", {
    code: "P2002",
    clientVersion: "test",
    meta: { target },
  });
}

describe("backoffice workspace controller authorization", () => {
  it("lets owner/operator list, blocks common users, and blocks operator creation", async () => {
    const access = {
      listWorkspaces: vi.fn(async () => []),
      createWorkspace: vi.fn(),
      createClientOwnerActivationLink: vi.fn(async () => ({
        ok: true,
        mode: "activation",
        delivery: "link_only",
        activationUrl: "https://console.example.com/login/activate?token=token",
        expiresAt: "2026-08-26T10:00:00.000Z",
        emailAttempted: false,
      })),
      reissueClientOwnerActivation: vi.fn(async () => ({
        accepted: true,
        deliveryStatus: "queued",
      })),
    };
    const admin = {
      assertPlatformAdmin: vi.fn(async (token: string) => {
        if (token === "common") throw new ForbiddenException();
        return token === "operator" ? operator : owner;
      }),
      assertPlatformOwner: vi.fn(async (token: string) => {
        if (token !== "owner") throw new ForbiddenException();
        return owner;
      }),
    };
    const controller = new BackofficeWorkspacesController(
      admin as never,
      access as never,
    );

    await controller.list("owner");
    await controller.list("operator");
    await expect(controller.list("common")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(controller.create("operator", input())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      controller.create("owner", { ...input(), extra: true } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await controller.createActivationLink("owner", "workspace-1", "user-1");
    expect(access.createClientOwnerActivationLink).toHaveBeenCalledWith(
      "workspace-1",
      "user-1",
      owner,
    );
    await controller.resendActivationEmail("owner", "workspace-1", "user-1");
    expect(access.reissueClientOwnerActivation).toHaveBeenCalledWith(
      "workspace-1",
      "user-1",
      owner,
    );
    await expect(
      controller.createActivationLink("operator", "workspace-1", "user-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.resendActivationEmail("operator", "workspace-1", "user-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

function createHash(value: string): string {
  return nodeCreateHash("sha256").update(value).digest("hex");
}
