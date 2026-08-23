import { ForbiddenException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LicenseAccountMismatchError } from "../../src/licensing-client/license-client-errors";
import { LicenseClientStatusController } from "../../src/licensing-client/license-client-status.controller";
import type { LicenseClientService } from "../../src/licensing-client/license-client.service";
import type { LicenseRuntimeState } from "../../src/licensing-client/license-client.types";

function fullState(overrides: Partial<LicenseRuntimeState> = {}): LicenseRuntimeState {
  return {
    status: "active",
    softLock: false,
    hardLock: false,
    usable: true,
    expiresAt: "2027-01-01T00:00:00.000Z",
    validUntil: "2026-09-01T00:00:00.000Z",
    source: "cache",
    reason: null,
    ...overrides,
  };
}

function fakeService(overrides: { getState?: LicenseRuntimeState; activate?: () => Promise<LicenseRuntimeState> } = {}) {
  return {
    getState: vi.fn().mockResolvedValue(overrides.getState ?? fullState()),
    activate: overrides.activate ? vi.fn(overrides.activate) : vi.fn().mockResolvedValue(fullState()),
  } as unknown as LicenseClientService;
}

describe("LicenseClientStatusController", () => {
  let realDateNow: () => number;

  beforeEach(() => {
    realDateNow = Date.now;
  });

  it("GET status returns only the coarse, non-sensitive fields", async () => {
    const service = fakeService({
      getState: fullState({ status: "grace", reason: null }),
    });
    const controller = new LicenseClientStatusController(service);

    const response = await controller.getStatus();

    expect(response).toEqual({
      status: "grace",
      softLock: false,
      hardLock: false,
      usable: true,
      expiresAt: "2027-01-01T00:00:00.000Z",
      validUntil: "2026-09-01T00:00:00.000Z",
      source: "cache",
    });
    expect(response).not.toHaveProperty("reason");
  });

  it("POST activate returns the resulting coarse status on success", async () => {
    const service = fakeService({ activate: async () => fullState({ status: "active" }) });
    const controller = new LicenseClientStatusController(service);

    const response = await controller.postActivate({});

    expect(response.status).toBe("active");
    expect(response).not.toHaveProperty("reason");
  });

  it("POST activate forwards the optional key from the request body", async () => {
    const activate = vi.fn().mockResolvedValue(fullState());
    const service = { getState: vi.fn(), activate } as unknown as LicenseClientService;
    const controller = new LicenseClientStatusController(service);

    await controller.postActivate({ key: "my-key" });

    expect(activate).toHaveBeenCalledWith({ key: "my-key" });
  });

  it("POST activate returns 403 when the license is bound to a different account", async () => {
    const service = fakeService({
      activate: async () => {
        throw new LicenseAccountMismatchError();
      },
    });
    const controller = new LicenseClientStatusController(service);

    await expect(controller.postActivate({})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rate-limits rapid repeat activation attempts", async () => {
    const service = fakeService();
    const controller = new LicenseClientStatusController(service);
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    await controller.postActivate({});
    await expect(controller.postActivate({})).rejects.toMatchObject({ status: 429 });

    now += 6_000;
    await expect(controller.postActivate({})).resolves.toBeDefined();

    Date.now = realDateNow;
  });
});
