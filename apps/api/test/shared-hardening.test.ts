import { Logger } from "@nestjs/common";
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  acquirePlatformRoleLock,
  platformRoleTransactionOptions,
} from "../src/common/prisma/platform-role-concurrency";
import {
  acquirePlatformWorkspaceWriteLocks,
  withWorkspaceUniqueRetry,
} from "../src/common/prisma/workspace-write-concurrency";
import { EmailDeliveryAuditService } from "../src/email/email-delivery-audit.service";
import { EmailQueueService } from "../src/email/email-queue.service";
import { assertCliUserIsNotPlatformAdmin } from "../src/scripts/create-user-guards";

describe("shared hardening", () => {
  it("uses one transaction-scoped lock for platformRole writes", async () => {
    const executeRaw = vi.fn(async () => 1);

    await acquirePlatformRoleLock({ $executeRaw: executeRaw } as never);

    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(platformRoleTransactionOptions.isolationLevel).toBe("Serializable");
  });

  it("takes platform-role before workspace lock and never bypasses PostgreSQL", async () => {
    const values: number[] = [];
    const queryRaw = vi.fn(
      async (_strings: TemplateStringsArray, ...queryValues: unknown[]) => {
        values.push(...(queryValues as number[]));
        return 1;
      },
    );

    const executeRaw = vi.fn(
      async (_strings: TemplateStringsArray, ...queryValues: unknown[]) => {
        values.push(...(queryValues as number[]));
      },
    );

    await acquirePlatformWorkspaceWriteLocks({
      $queryRaw: queryRaw,
      $executeRaw: executeRaw,
    } as never);

    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(values).toEqual([
      147_203_911, 619_470_281, 147_203_911, 731_884_217,
    ]);
    await expect(
      acquirePlatformWorkspaceWriteLocks({} as never),
    ).rejects.toThrow("PostgreSQL transaction is required");
  });

  it("retries only the exact known workspace slug constraint", async () => {
    const slugCollision = knownUniqueConstraint(["slug"]);
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(slugCollision)
      .mockResolvedValue("created");

    await expect(withWorkspaceUniqueRetry(operation)).resolves.toBe("created");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("maps the exact known user email constraint to a controlled conflict", async () => {
    const emailCollision = knownUniqueConstraint(["email"]);

    await expect(
      withWorkspaceUniqueRetry(async () => {
        throw emailCollision;
      }),
    ).rejects.toMatchObject({
      constructor: ConflictException,
      message: "Email ja cadastrado",
    });
  });

  it("does not misclassify compound or unknown unique targets", async () => {
    const unknownCollision = knownUniqueConstraint(["slug", "other"]);

    await expect(
      withWorkspaceUniqueRetry(async () => {
        throw unknownCollision;
      }),
    ).rejects.toBe(unknownCollision);
  });

  it("does not map an unrecognized Prisma unique target", async () => {
    const unknownConstraint = knownUniqueConstraint(["tokenHash"]);

    await expect(
      withWorkspaceUniqueRetry(async () => {
        throw unknownConstraint;
      }),
    ).rejects.toBe(unknownConstraint);
  });

  it("keeps platform users outside the create-user CLI path", () => {
    expect(() =>
      assertCliUserIsNotPlatformAdmin({ platformRole: "platform_owner" }),
    ).toThrow(/bootstrap ou backoffice/);
    expect(() =>
      assertCliUserIsNotPlatformAdmin({ platformRole: "platform_operator" }),
    ).toThrow(/bootstrap ou backoffice/);
    expect(() =>
      assertCliUserIsNotPlatformAdmin({ platformRole: null }),
    ).not.toThrow();
    expect(() => assertCliUserIsNotPlatformAdmin(null)).not.toThrow();
  });

  it("propagates audit persistence failure to the delivery boundary", async () => {
    const audit = new EmailDeliveryAuditService({
      auditLog: { create: vi.fn().mockRejectedValue(new Error("db down")) },
    } as never);

    await expect(
      audit.record({
        deliveryId: "delivery-1",
        workspaceId: null,
        template: "password_reset",
        recipientHash: "hash",
        status: "queued",
      }),
    ).rejects.toThrow("db down");
  });

  describe("email enqueue policy", () => {
    let loggerError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      loggerError = vi
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);
    });

    afterEach(() => {
      loggerError.mockRestore();
    });

    it("keeps a queued delivery successful while making audit failure observable", async () => {
      const queue = {
        add: vi.fn(async () => ({ id: "job-1" })),
      };
      const service = new EmailQueueService(
        queue as never,
        { isEnabled: () => true } as never,
        {
          encrypt: vi.fn(() => ({
            encryptionVersion: 1 as const,
            ciphertext: "ciphertext",
            iv: "iv",
            authTag: "tag",
          })),
        } as never,
        { record: vi.fn().mockRejectedValue(new Error("audit down")) } as never,
      );

      const result = await service.enqueue({
        workspaceId: null,
        action: { type: "AuthActionToken", id: "token-1", version: "1" },
        envelope: {
          to: { address: "person@example.com" },
          template: "password_reset",
          data: {
            token: "secret-token",
            expiresAt: "2026-08-26T10:00:00.000Z",
          },
        },
      });

      expect(result).toMatchObject({ status: "queued", jobId: "job-1" });
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Falha ao registrar auditoria de delivery enfileirado",
        ),
      );
    });
  });
});

function knownUniqueConstraint(target: readonly string[]) {
  return new Prisma.PrismaClientKnownRequestError("unique constraint", {
    code: "P2002",
    clientVersion: "test",
    meta: { target },
  });
}
