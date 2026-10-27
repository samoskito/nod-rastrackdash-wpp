import "reflect-metadata";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BackofficeParserReleasesController } from "../../src/inbound-webhooks/backoffice-parser-releases.controller";

/**
 * Fase 6.5 — the SaaS "liberar leitor/plataforma" (b4d71afc, #166) is NOT a
 * student step in the nod (production direct): validated readers enter
 * certified by migration. What remains is a read-only diagnostic
 * ("Leitores de webhook"): it lists the releases with their effective
 * status and has no way to certify, release or change sending.
 */

const srcDir = resolve(__dirname, "../../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : path.endsWith(".ts")
        ? [path]
        : [];
  });
}

describe("no certification path for the student (production direct)", () => {
  it("exposes no certify/release route in any API controller", () => {
    const controllers = sourceFiles(srcDir).filter((path) =>
      path.endsWith(".controller.ts"),
    );
    for (const path of controllers) {
      const text = readFileSync(path, "utf8");
      expect(text, path).not.toMatch(
        /@(Post|Patch|Put)\(\s*["'`][^"'`]*(certify|release-parser|liberar)/iu,
      );
    }
  });

  it("the parser-release diagnostic only reads (GET), never writes", () => {
    const methods = Object.getOwnPropertyNames(
      BackofficeParserReleasesController.prototype,
    ).filter((name) => name !== "constructor");
    expect(methods).toEqual(["list"]);
    const handler = BackofficeParserReleasesController.prototype.list;
    // Nest stores the HTTP verb as metadata (0 = GET).
    expect(Reflect.getMetadata("method", handler)).toBe(0);
  });

  it("lists Braip as in use (certified) and keeps a retired release retired", async () => {
    const at = new Date("2026-10-27T14:01:00.000Z");
    const prisma = {
      inboundWebhookParserRelease: {
        findMany: vi.fn(async () => [
          { id: "inbound_parser_braip_automation_v1", provider: "braip", version: "automation-v1", status: "certified", certifiedAt: at, createdAt: at, updatedAt: at },
          { id: "inbound_parser_payt_automation_v1", provider: "payt", version: "automation-v1", status: "certified", certifiedAt: at, createdAt: at, updatedAt: at },
          { id: "old", provider: "umbler", version: "v0", status: "retired", certifiedAt: null, createdAt: at, updatedAt: at },
        ]),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    const platformAdmin = {
      assertPlatformAdmin: vi.fn(async () => ({
        id: "admin",
        email: "admin@example.test",
        role: "platform_owner",
      })),
    };
    const controller = new BackofficeParserReleasesController(
      platformAdmin as never,
      prisma as never,
    );
    const result = await controller.list("token");
    expect(platformAdmin.assertPlatformAdmin).toHaveBeenCalledWith("token");
    expect(result.releases.map((r) => [r.provider, r.status])).toEqual([
      ["braip", "certified"],
      ["payt", "certified"],
      ["umbler", "retired"],
    ]);
    expect(prisma.inboundWebhookParserRelease.update).not.toHaveBeenCalled();
    expect(prisma.inboundWebhookParserRelease.updateMany).not.toHaveBeenCalled();
  });

  it("refuses non platform admins", async () => {
    const controller = new BackofficeParserReleasesController(
      {
        assertPlatformAdmin: vi.fn(async () => {
          throw Object.assign(new Error("forbidden"), { status: 403 });
        }),
      } as never,
      { inboundWebhookParserRelease: { findMany: vi.fn() } } as never,
    );
    await expect(controller.list("token")).rejects.toMatchObject({ status: 403 });
  });
});
