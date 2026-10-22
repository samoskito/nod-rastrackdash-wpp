import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isLicenseLockedError,
  serverApiFetch,
  type LicenseLockedError,
} from "../src/lib/server-api";

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    toString: (): string => "wpptrack_session=refresh-token",
  })),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("server api client", () => {
  it("keeps the machine-readable code of an API error next to its message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 409,
          error: "Conflict",
          code: "provider_rule_reprocess_in_progress",
          message: "Já existe um reprocessamento em andamento para esta regra",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );

    const error = (await serverApiFetch("/conversion-rules/providers/r/reprocess-blocked", {
      method: "POST",
    }).catch((thrown: unknown) => thrown)) as { status: number; code?: string; message: string };

    expect(error).toMatchObject({
      status: 409,
      code: "provider_rule_reprocess_in_progress",
      message: "Já existe um reprocessamento em andamento para esta regra",
    });
  });

  it("forwards the Next.js cookie header to the backend", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await serverApiFetch<{ ok: true }>(
      "/backoffice/diagnostics/events",
    );

    expect(result.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/backoffice/diagnostics/events",
      expect.objectContaining({
        credentials: "include",
        headers: expect.objectContaining({
          Cookie: "wpptrack_session=refresh-token",
        }),
      }),
    );
  });

  it("surfaces a 423 license lock with its reason and pt-BR message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 423,
          error: "License Locked",
          message: "Licença não ativada — ative a licença em /backoffice/license.",
          reason: "license_required",
          licenseStatus: "unlicensed",
        }),
        { status: 423, headers: { "Content-Type": "application/json" } },
      ),
    );

    const error = await serverApiFetch("/workspaces", { method: "POST" }).catch(
      (thrown: unknown) => thrown,
    );

    expect(isLicenseLockedError(error)).toBe(true);
    expect((error as LicenseLockedError).status).toBe(423);
    expect((error as LicenseLockedError).reason).toBe("license_required");
    expect((error as LicenseLockedError).message).toContain("Licença não ativada");
  });

  it("falls back to a clear pt-BR message when a 423 body carries no message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 423 }),
    );

    const error = await serverApiFetch("/workspaces", { method: "POST" }).catch(
      (thrown: unknown) => thrown,
    );

    expect(isLicenseLockedError(error)).toBe(true);
    expect((error as LicenseLockedError).message).toContain("Licença");
    expect((error as LicenseLockedError).message).not.toContain("API request failed");
  });

  it("accepts successful responses without a JSON body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await expect(
      serverApiFetch<void>("/integrations/inbound-webhooks/connection_1", {
        method: "DELETE",
      }),
    ).resolves.toBeUndefined();
  });
});
