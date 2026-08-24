import { afterEach, describe, expect, it, vi } from "vitest";
import { getOnboardingStatus } from "../src/lib/onboarding-status";

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    toString: (): string => "wpptrack_session=refresh-token",
  })),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getOnboardingStatus", () => {
  it("returns the parsed checklist on success", async () => {
    const payload = {
      checks: { database: true, licenseActive: true, metaConnected: false, hasWorkspace: true },
      completedCount: 3,
      totalCount: 4,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(payload));

    await expect(getOnboardingStatus()).resolves.toEqual(payload);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/onboarding/status",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("returns null (fails open) when there is no session", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ message: "Sessao nao encontrada" }, 401));

    await expect(getOnboardingStatus()).resolves.toBeNull();
  });

  it("returns null when the API is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network unreachable"));

    await expect(getOnboardingStatus()).resolves.toBeNull();
  });
});
