import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../src/lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("browser api client", () => {
  it("surfaces the pt-BR message of a 423 license lock instead of a generic error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 423,
          error: "License Locked",
          message:
            "Licença não ativada — ative a licença em /backoffice/license para liberar as operações de escrita.",
          reason: "license_required",
          licenseStatus: "unlicensed",
        }),
        { status: 423, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(apiFetch("/workspaces", { method: "POST" })).rejects.toThrow(
      /Licença não ativada/,
    );
  });

  it("keeps the generic error when the failing response has no message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 500 }),
    );

    await expect(apiFetch("/workspaces", { method: "POST" })).rejects.toThrow(
      "API request failed: 500",
    );
  });
});
