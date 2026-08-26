import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash as nodeCreateHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  platformUserInvitationReissueInputSchema,
  platformUserProvisionInputSchema,
  platformUserRoleUpdateInputSchema,
} from "@wpptrack/shared";
import { AuthService } from "../src/auth/auth.service";
import { extractAuthToken } from "../src/auth/auth-token";
import { BackofficePlatformUsersController } from "../src/auth/backoffice-platform-users.controller";
import {
  bootstrapPlatformAdminUser,
  type PlatformAdminBootstrapInput,
} from "../src/auth/platform-admin-bootstrap";
import { acquirePlatformAdminLock } from "../src/auth/platform-admin-lock";
import { PlatformAdminService } from "../src/auth/platform-admin.service";
import {
  BCRYPT_PASSWORD_INVALID_MESSAGE,
  PasswordService,
} from "../src/auth/password.service";

type UserState = {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
  platformRole: "platform_owner" | "platform_operator" | null;
  createdAt: Date;
};

const owner = (id = "owner_1"): UserState => ({
  id,
  email: `${id}@example.com`,
  name: "Owner",
  passwordHash: "existing-hash",
  platformRole: "platform_owner",
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
});

describe("platform advisory lock SQL", () => {
  it("submits a parameterized PostgreSQL transaction advisory lock query", async () => {
    let strings: TemplateStringsArray | undefined;
    let values: unknown[] = [];
    const queryRaw = vi.fn(
      async (queryStrings: TemplateStringsArray, ...queryValues: unknown[]) => {
        strings = queryStrings;
        values = queryValues;
        return [];
      },
    );

    await acquirePlatformAdminLock({ $queryRaw: queryRaw } as never);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(strings?.join("$")).toContain("SELECT pg_advisory_xact_lock(");
    expect(strings?.join("$")).not.toContain("AS text");
    expect(values).toEqual([147_203_911, 619_470_281]);
  });
});

describe("bcrypt password compatibility", () => {
  const overLimitMultibytePassword = "á".repeat(37);

  it("rejects passwords over 72 UTF-8 bytes before hash and verification", async () => {
    const passwords = new PasswordService();

    await expect(
      passwords.hash(overLimitMultibytePassword),
    ).rejects.toMatchObject({
      response: { message: BCRYPT_PASSWORD_INVALID_MESSAGE },
    });
    await expect(
      passwords.verify(overLimitMultibytePassword, "$2a$12$invalid"),
    ).rejects.toMatchObject({
      response: { message: BCRYPT_PASSWORD_INVALID_MESSAGE },
    });
  });
});

function concurrentBootstrapPrisma(initial: UserState[] = []) {
  const users = [...initial];
  const auditLog = { create: vi.fn(async () => ({})) };
  let lockTail = Promise.resolve();
  const lockCalls = vi.fn();

  const prisma: any = {
    user: {
      findUnique: vi.fn(
        async ({ where }: any) =>
          users.find((user) => user.email === where.email) ?? null,
      ),
      count: vi.fn(
        async () =>
          users.filter((user) => user.platformRole === "platform_owner").length,
      ),
      create: vi.fn(async ({ data }: any) => {
        const created: UserState = {
          id: `user_${users.length + 1}`,
          email: data.email,
          name: null,
          passwordHash: data.passwordHash,
          platformRole: data.platformRole,
          createdAt: new Date(),
        };
        users.push(created);
        return created;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const user = users.find((candidate) => candidate.id === where.id)!;
        Object.assign(user, data);
        return user;
      }),
    },
    auditLog,
  };
  prisma.$transaction = vi.fn(
    async (callback: (transaction: any) => unknown) => {
      const previous = lockTail;
      let unlock: () => void = () => undefined;
      lockTail = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const transaction = {
        ...prisma,
        $queryRaw: vi.fn(async () => {
          lockCalls();
          await previous;
          return [{ lockAcquired: "" }];
        }),
      };
      try {
        return await callback(transaction);
      } finally {
        unlock();
      }
    },
  );

  return { prisma, users, lockCalls };
}

function platformPrisma(
  initial: UserState[],
  options: { rateCount?: number } = {},
) {
  const users = [...initial];
  const tokens: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  let lockTail = Promise.resolve();
  const lockCalls = vi.fn();
  const auditLog = {
    count: vi.fn(async () => options.rateCount ?? 0),
    create: vi.fn(async ({ data }: any) => {
      audits.push(data);
      return data;
    }),
  };
  const user = {
    findMany: vi.fn(async () =>
      users.filter((candidate) => candidate.platformRole),
    ),
    findUnique: vi.fn(
      async ({ where }: any) =>
        users.find(
          (candidate) =>
            candidate.id === where.id || candidate.email === where.email,
        ) ?? null,
    ),
    count: vi.fn(
      async () =>
        users.filter((candidate) => candidate.platformRole === "platform_owner")
          .length,
    ),
    update: vi.fn(async ({ where, data }: any) => {
      const target = users.find((candidate) => candidate.id === where.id)!;
      Object.assign(target, data);
      return target;
    }),
    create: vi.fn(async ({ data }: any) => {
      const created: UserState = {
        id: `user_${users.length + 1}`,
        email: data.email,
        name: data.name,
        passwordHash: data.passwordHash ?? null,
        platformRole: data.platformRole,
        createdAt: new Date(),
      };
      users.push(created);
      return created;
    }),
  };
  const authActionToken = {
    updateMany: vi.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const token of tokens) {
        if (
          token.userId === where.userId &&
          token.type === where.type &&
          token.usedAt === null
        ) {
          token.usedAt = data.usedAt;
          count += 1;
        }
      }
      return { count };
    }),
    create: vi.fn(async ({ data }: any) => {
      const token = { id: `token_${tokens.length + 1}`, usedAt: null, ...data };
      tokens.push(token);
      return token;
    }),
  };
  const prisma: any = { user, authActionToken, auditLog };
  prisma.$transaction = vi.fn(
    async (callback: (transaction: any) => unknown) => {
      const previous = lockTail;
      let unlock: () => void = () => undefined;
      lockTail = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const transaction = {
        ...prisma,
        $queryRaw: vi.fn(async () => {
          lockCalls();
          await previous;
          return [{ lockAcquired: "" }];
        }),
      };
      try {
        return await callback(transaction);
      } finally {
        unlock();
      }
    },
  );

  return { prisma, users, tokens, audits, lockCalls, auditLog, user };
}

const ownerActor = {
  id: "owner_1",
  email: "owner_1@example.com",
  role: "platform_owner" as const,
};

describe("platform admin bootstrap", () => {
  const input: PlatformAdminBootstrapInput = {
    email: "Owner@Example.com",
    password: "new-password-never-printed",
  };

  it("is idempotent and preserves an existing owner password", async () => {
    const harness = concurrentBootstrapPrisma([
      { ...owner(), email: "owner@example.com" },
    ]);
    const passwordService = { hash: vi.fn(async () => "new-hash") };

    const result = await bootstrapPlatformAdminUser(
      harness.prisma as never,
      input,
      passwordService as never,
    );

    expect(result.createdUser).toBe(false);
    expect(result.changedRole).toBe(false);
    expect(result.passwordPreserved).toBe(true);
    expect(harness.users[0]?.passwordHash).toBe("existing-hash");
    expect(passwordService.hash).not.toHaveBeenCalled();
    expect(harness.lockCalls).toHaveBeenCalledTimes(1);
  });

  it("does not promote an existing account without explicit confirmation", async () => {
    const existing = {
      ...owner(),
      email: "owner@example.com",
      platformRole: null,
    };
    const harness = concurrentBootstrapPrisma([existing]);

    await expect(
      bootstrapPlatformAdminUser(harness.prisma as never, input),
    ).rejects.toThrow("Usuario existente nao alterado");
    expect(harness.users[0]?.platformRole).toBeNull();
    expect(harness.users[0]?.passwordHash).toBe("existing-hash");
  });

  it("rejects an over-limit multibyte bootstrap password before hashing", async () => {
    const harness = concurrentBootstrapPrisma();
    const passwordService = { hash: vi.fn(async () => "must-not-hash") };

    await expect(
      bootstrapPlatformAdminUser(
        harness.prisma as never,
        { ...input, password: "á".repeat(37) },
        passwordService as never,
      ),
    ).rejects.toMatchObject({
      response: { message: BCRYPT_PASSWORD_INVALID_MESSAGE },
    });
    expect(passwordService.hash).not.toHaveBeenCalled();
  });

  it("creates only the persistent owner and no workspace", async () => {
    const harness = concurrentBootstrapPrisma();
    const result = await bootstrapPlatformAdminUser(
      harness.prisma as never,
      input,
      { hash: vi.fn(async () => "new-hash") } as never,
    );

    expect(result.platformRole).toBe("platform_owner");
    expect(result.createdUser).toBe(true);
    expect(harness.users).toHaveLength(1);
    expect(harness.users[0]?.email).toBe("owner@example.com");
  });

  it("serializes concurrent calls for the same email", async () => {
    const harness = concurrentBootstrapPrisma();
    const passwordService = { hash: vi.fn(async () => "new-hash") };

    const results = await Promise.all([
      bootstrapPlatformAdminUser(
        harness.prisma as never,
        input,
        passwordService as never,
      ),
      bootstrapPlatformAdminUser(
        harness.prisma as never,
        input,
        passwordService as never,
      ),
    ]);

    expect(results.map((result) => result.createdUser)).toEqual([true, false]);
    expect(
      harness.users.filter((user) => user.platformRole === "platform_owner"),
    ).toHaveLength(1);
    expect(harness.lockCalls).toHaveBeenCalledTimes(2);
  });

  it("closes bootstrap after the first owner and rejects a concurrent different email", async () => {
    const harness = concurrentBootstrapPrisma();
    const passwordService = { hash: vi.fn(async () => "new-hash") };

    const settled = await Promise.allSettled([
      bootstrapPlatformAdminUser(
        harness.prisma as never,
        input,
        passwordService as never,
      ),
      bootstrapPlatformAdminUser(
        harness.prisma as never,
        {
          email: "second@example.com",
          password: "another-password",
          confirmExisting: true,
        },
        passwordService as never,
      ),
    ]);

    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      settled.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      harness.users.filter((user) => user.platformRole === "platform_owner"),
    ).toHaveLength(1);
  });

  it("does not permit a second owner even with explicit confirmation", async () => {
    const harness = concurrentBootstrapPrisma([
      owner(),
      { ...owner("member_1"), platformRole: null },
    ]);

    await expect(
      bootstrapPlatformAdminUser(harness.prisma as never, {
        email: "member_1@example.com",
        password: "another-password",
        confirmExisting: true,
      }),
    ).rejects.toThrow("Bootstrap fechado");
    expect(
      harness.users.filter((user) => user.platformRole === "platform_owner"),
    ).toHaveLength(1);
  });
});

describe("platform admin RBAC and invitations", () => {
  it("fails closed for users without a persistent platform role, even when allowlisted", async () => {
    const auth = {
      getSession: vi.fn(async () => ({
        user: {
          id: "user_1",
          email: "allowlisted@example.com",
          platformRole: null,
        },
      })),
    };
    const service = new PlatformAdminService(auth as never, {} as never);

    await expect(service.assertPlatformAdmin("session")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("returns 401 without a session token and 403 for a common user", async () => {
    expect(() => extractAuthToken({ headers: {} })).toThrow(
      UnauthorizedException,
    );
    const controller = new BackofficePlatformUsersController({
      assertPlatformAdmin: vi.fn(async () => {
        throw new ForbiddenException();
      }),
    } as never);

    await expect(controller.list("common-session")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("lets an operator list but never mutate roles", async () => {
    const auth = {
      getSession: vi.fn(async () => ({
        user: {
          id: "operator_1",
          email: "operator@example.com",
          platformRole: "platform_operator",
        },
      })),
    };
    const harness = platformPrisma([owner()]);
    const service = new PlatformAdminService(
      auth as never,
      harness.prisma as never,
    );
    const operator = await service.assertPlatformAdmin("session");

    await expect(
      service.updatePlatformUserRole("owner_1", { role: null }, operator),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("enforces strict administrative schemas and rejects extra fields", () => {
    expect(
      platformUserProvisionInputSchema.safeParse({
        name: "Operator",
        email: "operator@example.com",
        role: "platform_operator",
        password: "forbidden",
      }).success,
    ).toBe(false);
    expect(
      platformUserRoleUpdateInputSchema.safeParse({ role: null, extra: true })
        .success,
    ).toBe(false);
    expect(
      platformUserInvitationReissueInputSchema.safeParse({ extra: true })
        .success,
    ).toBe(false);
  });

  it("normalizes email in the service and returns a uniform accepted response", async () => {
    const harness = platformPrisma([]);
    const emailQueue = {
      isEnabled: vi.fn(() => true),
      enqueue: vi.fn(async () => ({})),
    };
    const service = new PlatformAdminService(
      {} as never,
      harness.prisma as never,
      emailQueue as never,
    );

    const created = await service.invitePlatformOperator(
      {
        name: "Operator",
        email: " Operator@Example.Com ",
        role: "platform_operator",
      },
      ownerActor,
    );
    const existing = await service.invitePlatformOperator(
      {
        name: "Other",
        email: "OPERATOR@example.com",
        role: "platform_operator",
      },
      ownerActor,
    );

    expect(harness.users[0]?.email).toBe("operator@example.com");
    expect(created).toEqual({ accepted: true });
    expect(existing).toEqual({ accepted: true });
    expect(created).not.toHaveProperty("user");
    expect(created).not.toHaveProperty("token");
  });

  it("fails before mutation when invite delivery is unavailable", async () => {
    const harness = platformPrisma([]);
    const service = new PlatformAdminService(
      {} as never,
      harness.prisma as never,
      { isEnabled: () => false } as never,
    );

    await expect(
      service.invitePlatformOperator(
        {
          name: "Operator",
          email: "operator@example.com",
          role: "platform_operator",
        },
        ownerActor,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(harness.user.create).not.toHaveBeenCalled();
  });

  it("keeps a failed delivery reissuable without exposing its token", async () => {
    const harness = platformPrisma([]);
    const emailQueue = {
      isEnabled: vi.fn(() => true),
      enqueue: vi
        .fn()
        .mockRejectedValueOnce(new Error("queue unavailable"))
        .mockResolvedValueOnce({}),
    };
    const service = new PlatformAdminService(
      {} as never,
      harness.prisma as never,
      emailQueue as never,
    );

    await expect(
      service.invitePlatformOperator(
        {
          name: "Operator",
          email: "operator@example.com",
          role: "platform_operator",
        },
        ownerActor,
      ),
    ).rejects.toMatchObject({ status: 503 });
    const operatorId = harness.users[0]!.id;
    const reissued = await service.reissuePlatformOperatorInvitation(
      operatorId,
      ownerActor,
    );

    expect(reissued).toEqual({ accepted: true });
    expect(harness.tokens).toHaveLength(2);
    expect(harness.tokens[0]?.usedAt).toBeInstanceOf(Date);
    expect(harness.tokens[1]?.usedAt).toBeNull();
    expect(emailQueue.enqueue).toHaveBeenCalledTimes(2);
    expect(
      harness.audits.some(
        (audit) => audit.action === "platform_user.invitation_delivery_failed",
      ),
    ).toBe(true);
  });

  it("rate limits invite and role mutations under the same database lock", async () => {
    const inviteHarness = platformPrisma([], { rateCount: 5 });
    const inviteService = new PlatformAdminService(
      {} as never,
      inviteHarness.prisma as never,
      { isEnabled: () => true, enqueue: vi.fn() } as never,
    );
    await expect(
      inviteService.invitePlatformOperator(
        {
          name: "Operator",
          email: "operator@example.com",
          role: "platform_operator",
        },
        ownerActor,
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(inviteHarness.user.create).not.toHaveBeenCalled();
    expect(inviteHarness.lockCalls).toHaveBeenCalledTimes(1);

    const roleHarness = platformPrisma([owner()], { rateCount: 20 });
    const roleService = new PlatformAdminService(
      {} as never,
      roleHarness.prisma as never,
    );
    await expect(
      roleService.updatePlatformUserRole(
        "owner_1",
        { role: "platform_owner" },
        ownerActor,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(roleHarness.user.update).not.toHaveBeenCalled();
  });

  it("serializes concurrent owner demotions and retains one owner", async () => {
    const first = owner("owner_1");
    const second = owner("owner_2");
    const harness = platformPrisma([first, second]);
    const service = new PlatformAdminService(
      {} as never,
      harness.prisma as never,
    );

    const settled = await Promise.allSettled([
      service.updatePlatformUserRole(
        "owner_2",
        { role: null },
        {
          id: "owner_1",
          email: first.email,
          role: "platform_owner",
        },
      ),
      service.updatePlatformUserRole(
        "owner_1",
        { role: null },
        {
          id: "owner_2",
          email: second.email,
          role: "platform_owner",
        },
      ),
    ]);

    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      settled.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      harness.users.filter((user) => user.platformRole === "platform_owner"),
    ).toHaveLength(1);
    expect(harness.lockCalls).toHaveBeenCalledTimes(2);
  });
});

type ActivationState = {
  token: {
    id: string;
    userId: string;
    workspaceId: string | null;
    type: "account_activation";
    tokenHash: string;
    expiresAt: Date;
    usedAt: Date | null;
  };
  user: UserState & { emailVerifiedAt: Date | null };
};

function activationAuth(
  token: string,
  expiresAt = new Date(Date.now() + 60_000),
  options: {
    workspaceId?: string | null;
    platformRole?: "platform_operator" | null;
  } = {},
) {
  const events: string[] = [];
  const state: ActivationState = {
    token: {
      id: "token_1",
      userId: "operator_1",
      workspaceId: options.workspaceId ?? null,
      type: "account_activation",
      tokenHash: "",
      expiresAt,
      usedAt: null,
    },
    user: {
      ...owner("operator_1"),
      email: "operator@example.com",
      passwordHash: null,
      platformRole: options.platformRole ?? "platform_operator",
      emailVerifiedAt: null,
    },
  };
  state.token.tokenHash = createHash(token);
  const prisma: any = {
    authActionToken: {
      findFirst: vi.fn(async ({ select }: any) => {
        events.push("activation-token-read");
        if (state.token.usedAt || state.token.expiresAt <= new Date()) {
          return null;
        }
        if (select?.user) {
          return {
            userId: state.token.userId,
            workspaceId: state.token.workspaceId,
            user: {
              passwordHash: state.user.passwordHash,
              platformRole: state.user.platformRole,
            },
          };
        }
        return state.token;
      }),
      updateMany: vi.fn(async ({ data }: any) => {
        events.push("activation-token-consume");
        if (data.usedAt) state.token.usedAt = data.usedAt;
        return { count: 1 };
      }),
    },
    user: {
      findUnique: vi.fn(async ({ include }: any) =>
        include
          ? {
              ...state.user,
              authProvider: "email",
              memberships: state.token.workspaceId
                ? [
                    {
                      role: "owner",
                      canManageMembers: false,
                      workspace: {
                        id: state.token.workspaceId,
                        name: "Client workspace",
                        slug: "client-workspace",
                        operationalStatus: "active",
                      },
                    },
                  ]
                : [],
            }
          : state.user,
      ),
      updateMany: vi.fn(async ({ data }: any) => {
        state.user.passwordHash = data.passwordHash;
        state.user.emailVerifiedAt = data.emailVerifiedAt;
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: any) => {
        Object.assign(state.user, data);
        return state.user;
      }),
    },
    workspaceMember: {
      findUnique: vi.fn(async ({ where }: any) =>
        state.token.workspaceId === where.workspaceId_userId?.workspaceId &&
        state.token.userId === where.workspaceId_userId?.userId
          ? { id: "member_1", role: "owner" }
          : null,
      ),
    },
    authSession: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    $queryRaw: vi.fn(async () => {
      events.push("activation-lock");
      return [];
    }),
  };
  prisma.$transaction = vi.fn(async (callback: (value: any) => unknown) =>
    callback(prisma),
  );
  const passwordService = { hash: vi.fn(async () => "activated-hash") };
  const auth = new AuthService(
    prisma as never,
    passwordService as never,
    { NODE_ENV: "test" } as never,
  );
  return { auth, state, passwordService, events };
}

function createHash(value: string): string {
  return nodeCreateHash("sha256").update(value).digest("hex");
}

describe("platform operator activation", () => {
  it("consumes a valid invitation once and rejects reuse and expiry", async () => {
    const first = activationAuth("activation-token");
    const result = await first.auth.activateProvisionedAccount({
      token: "activation-token",
      password: "operator-password",
    });

    expect(result.ok).toBe(true);
    expect(first.state.token.usedAt).toBeInstanceOf(Date);
    expect(first.state.user.passwordHash).toBe("activated-hash");

    await expect(
      first.auth.activateProvisionedAccount({
        token: "activation-token",
        password: "operator-password",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const expired = activationAuth("expired-token", new Date(Date.now() - 1));
    await expect(
      expired.auth.activateProvisionedAccount({
        token: "expired-token",
        password: "operator-password",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("takes the canonical activation lock before consuming the token", async () => {
    const invitation = activationAuth("activation-token");

    await invitation.auth.activateProvisionedAccount({
      token: "activation-token",
      password: "operator-password",
    });

    const lockIndex = invitation.events.indexOf("activation-lock");
    const consumeIndex = invitation.events.indexOf("activation-token-consume");
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(consumeIndex).toBeGreaterThan(lockIndex);
  });

  it("consumes a client-owner activation once and rejects an expired token", async () => {
    const first = activationAuth("client-activation-token", undefined, {
      workspaceId: "workspace_1",
      platformRole: null,
    });
    const result = await first.auth.activateProvisionedAccount({
      token: "client-activation-token",
      password: "client-password",
    });

    expect(result.ok).toBe(true);
    expect(first.state.token.usedAt).toBeInstanceOf(Date);
    expect(first.state.user.passwordHash).toBe("activated-hash");

    await expect(
      first.auth.activateProvisionedAccount({
        token: "client-activation-token",
        password: "client-password",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const expired = activationAuth(
      "expired-client-token",
      new Date(Date.now() - 1),
      { workspaceId: "workspace_1", platformRole: null },
    );
    await expect(
      expired.auth.activateProvisionedAccount({
        token: "expired-client-token",
        password: "client-password",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects an over-limit multibyte password before consuming an activation token", async () => {
    const invitation = activationAuth("activation-token");

    await expect(
      invitation.auth.activateProvisionedAccount({
        token: "activation-token",
        password: "á".repeat(37),
      }),
    ).rejects.toMatchObject({
      response: { message: BCRYPT_PASSWORD_INVALID_MESSAGE },
    });
    expect(invitation.passwordService.hash).not.toHaveBeenCalled();
    expect(invitation.state.token.usedAt).toBeNull();
  });
});
