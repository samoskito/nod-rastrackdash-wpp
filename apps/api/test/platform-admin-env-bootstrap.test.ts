import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformAdminEnvBootstrapService } from "../src/auth/platform-admin-env-bootstrap.service";
import { PasswordService } from "../src/auth/password.service";
import {
  parseArgs,
  resolveEmail,
  resolvePassword,
} from "../src/scripts/create-platform-admin";

type UserState = {
  id: string;
  email: string;
  passwordHash: string | null;
  platformRole: "platform_owner" | "platform_operator" | null;
};

const envKeys = [
  "SETUP_PLATFORM_ADMIN_EMAIL",
  "SETUP_PLATFORM_ADMIN_PASSWORD",
  "SETUP_PLATFORM_ADMIN_CONFIRM_EXISTING",
] as const;

const originalEnv = new Map(
  envKeys.map((key) => [key, process.env[key]] as const),
);

function restoreEnv(): void {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function bootstrapPrisma(initial: UserState[] = []) {
  const users = initial.map((user) => ({ ...user }));
  const auditLog = { create: vi.fn(async () => ({})) };
  const user = {
    findUnique: vi.fn(async ({ where }: any) => {
      return users.find((candidate) => candidate.email === where.email) ?? null;
    }),
    count: vi.fn(async () => {
      return users.filter(
        (candidate) => candidate.platformRole === "platform_owner",
      ).length;
    }),
    create: vi.fn(async ({ data }: any) => {
      const created: UserState = {
        id: `user_${users.length + 1}`,
        email: data.email,
        passwordHash: data.passwordHash,
        platformRole: data.platformRole,
      };
      users.push(created);
      return created;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const existing = users.find((candidate) => candidate.id === where.id)!;
      Object.assign(existing, data);
      return existing;
    }),
  };
  const prisma: any = { user, auditLog };
  prisma.$transaction = vi.fn(async (callback: (tx: any) => unknown) => {
    return callback({ ...prisma, $executeRaw: vi.fn(async () => 1) });
  });

  return { prisma, user, users };
}

function recordedLogs(spies: Array<ReturnType<typeof vi.spyOn>>): string {
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
}

describe("platform admin env bootstrap", () => {
  const password = "env-password-never-logged";
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    restoreEnv();
    log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    error = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    vi.spyOn(PasswordService.prototype, "hash").mockResolvedValue("new-hash");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv();
  });

  it("is inert when either required env var is absent", async () => {
    delete process.env.SETUP_PLATFORM_ADMIN_EMAIL;
    process.env.SETUP_PLATFORM_ADMIN_PASSWORD = password;
    const harness = bootstrapPrisma();

    await new PlatformAdminEnvBootstrapService(harness.prisma).bootstrap();

    expect(harness.user.findUnique).not.toHaveBeenCalled();
    expect(recordedLogs([log, warn, error])).not.toContain(password);
  });

  it("creates a normalized platform owner from complete env vars", async () => {
    process.env.SETUP_PLATFORM_ADMIN_EMAIL = " Owner@Example.com ";
    process.env.SETUP_PLATFORM_ADMIN_PASSWORD = password;
    const harness = bootstrapPrisma();

    await new PlatformAdminEnvBootstrapService(harness.prisma).bootstrap();

    expect(harness.users).toEqual([
      expect.objectContaining({
        email: "owner@example.com",
        platformRole: "platform_owner",
      }),
    ]);
    expect(recordedLogs([log, warn, error])).not.toContain(password);
  });

  it("skips an existing platform owner without rewriting its password", async () => {
    process.env.SETUP_PLATFORM_ADMIN_EMAIL = "owner@example.com";
    process.env.SETUP_PLATFORM_ADMIN_PASSWORD = password;
    const harness = bootstrapPrisma([
      {
        id: "owner_1",
        email: "owner@example.com",
        passwordHash: "existing-hash",
        platformRole: "platform_owner",
      },
    ]);

    await new PlatformAdminEnvBootstrapService(harness.prisma).bootstrap();
    await new PlatformAdminEnvBootstrapService(harness.prisma).bootstrap();

    expect(harness.user.update).not.toHaveBeenCalled();
    expect(harness.users[0]?.passwordHash).toBe("existing-hash");
    expect(recordedLogs([log, warn, error])).not.toContain(password);
  });

  it("requires confirmation before promoting an existing non-platform account", async () => {
    process.env.SETUP_PLATFORM_ADMIN_EMAIL = "member@example.com";
    process.env.SETUP_PLATFORM_ADMIN_PASSWORD = password;
    const harness = bootstrapPrisma([
      {
        id: "member_1",
        email: "member@example.com",
        passwordHash: "existing-hash",
        platformRole: null,
      },
    ]);

    await new PlatformAdminEnvBootstrapService(harness.prisma).bootstrap();
    expect(harness.users[0]?.platformRole).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    process.env.SETUP_PLATFORM_ADMIN_CONFIRM_EXISTING = "true";
    await new PlatformAdminEnvBootstrapService(harness.prisma).bootstrap();
    expect(harness.users[0]?.platformRole).toBe("platform_owner");
    expect(harness.users[0]?.passwordHash).toBe("existing-hash");
    expect(recordedLogs([log, warn, error])).not.toContain(password);
  });
});

describe("platform admin CLI env resolution", () => {
  it("uses the environment password and email without accepting a password flag", async () => {
    await expect(
      resolvePassword({ SETUP_PLATFORM_ADMIN_PASSWORD: "from-env" }),
    ).resolves.toBe("from-env");
    expect(
      resolveEmail(parseArgs([]), {
        SETUP_PLATFORM_ADMIN_EMAIL: "owner@example.com",
      }),
    ).toBe("owner@example.com");
    expect(() => parseArgs(["--password", "nope"])).toThrow(
      "Senha por argumento nao e aceita",
    );
  });

  it("explains how to provide a password when stdin is a TTY", async () => {
    await expect(resolvePassword({}, { isTTY: true } as never)).rejects.toThrow(
      "SETUP_PLATFORM_ADMIN_PASSWORD ou forneca a senha por pipe",
    );
  });
});
