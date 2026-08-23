import type { ExecutionContext } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LicenseSoftlockGuard } from "../../src/licensing-client/license-softlock.guard";
import type { LicenseClientService } from "../../src/licensing-client/license-client.service";
import type { LicenseRuntimeState } from "../../src/licensing-client/license-client.types";

function blockedState(reason: LicenseRuntimeState["reason"] = "revoked"): LicenseRuntimeState {
  return {
    status: "blocked",
    softLock: true,
    hardLock: true,
    usable: false,
    expiresAt: null,
    validUntil: null,
    source: "cache",
    reason,
  };
}

function activeState(): LicenseRuntimeState {
  return {
    status: "active",
    softLock: false,
    hardLock: false,
    usable: true,
    expiresAt: null,
    validUntil: null,
    source: "cache",
    reason: null,
  };
}

function fakeService(overrides: { isInert?: boolean; state?: LicenseRuntimeState } = {}) {
  const isInert = vi.fn().mockResolvedValue(overrides.isInert ?? false);
  const getState = vi.fn().mockResolvedValue(overrides.state ?? activeState());
  return { isInert, getState } as unknown as LicenseClientService;
}

function makeContext(request: { method: string; path: string }): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

describe("LicenseSoftlockGuard", () => {
  let realDateNow: () => number;

  beforeEach(() => {
    realDateNow = Date.now;
  });

  it("allows read-only HTTP methods even when the license is blocked", async () => {
    const service = fakeService({ state: blockedState() });
    const guard = new LicenseSoftlockGuard(service);

    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      await expect(
        guard.canActivate(makeContext({ method, path: "/leads" })),
      ).resolves.toBe(true);
    }
  });

  it("blocks a mutating request with HTTP 423 and the LOCKED body when the license is blocked", async () => {
    const service = fakeService({ state: blockedState("expired") });
    const guard = new LicenseSoftlockGuard(service);

    const result = guard.canActivate(makeContext({ method: "POST", path: "/leads" }));

    await expect(result).rejects.toBeInstanceOf(HttpException);
    try {
      await result;
      throw new Error("expected canActivate to throw");
    } catch (error) {
      const httpError = error as HttpException;
      expect(httpError.getStatus()).toBe(423);
      expect(httpError.getResponse()).toEqual({
        statusCode: 423,
        error: "License Locked",
        message: expect.any(String),
        reason: "expired",
        licenseStatus: "blocked",
      });
    }
  });

  it("blocks PATCH, PUT and DELETE the same way as POST", async () => {
    const service = fakeService({ state: blockedState() });
    const guard = new LicenseSoftlockGuard(service);

    for (const method of ["PATCH", "PUT", "DELETE"]) {
      await expect(
        guard.canActivate(makeContext({ method, path: "/leads/1" })),
      ).rejects.toBeInstanceOf(HttpException);
    }
  });

  it("defaults reason to 'revoked' when the state carries no reason", async () => {
    const service = fakeService({ state: blockedState(null) });
    const guard = new LicenseSoftlockGuard(service);

    try {
      await guard.canActivate(makeContext({ method: "POST", path: "/leads" }));
      throw new Error("expected canActivate to throw");
    } catch (error) {
      expect((error as HttpException).getResponse()).toMatchObject({ reason: "revoked" });
    }
  });

  it("allows mutating requests when the license is active or in grace", async () => {
    const service = fakeService({ state: activeState() });
    const guard = new LicenseSoftlockGuard(service);

    await expect(
      guard.canActivate(makeContext({ method: "POST", path: "/leads" })),
    ).resolves.toBe(true);
  });

  it.each([
    ["/health", "/health"],
    ["/license-client status", "/license-client/status"],
    ["/license-client activate", "/license-client/activate"],
    ["/auth", "/auth/login"],
  ])("exempts %s from the lock even when the license is blocked", async (_label, path) => {
    const service = fakeService({ state: blockedState() });
    const guard = new LicenseSoftlockGuard(service);

    await expect(
      guard.canActivate(makeContext({ method: "POST", path })),
    ).resolves.toBe(true);
    expect(service.getState).not.toHaveBeenCalled();
  });

  it("passes every mutating request when the guard is inert", async () => {
    const service = fakeService({ isInert: true, state: blockedState() });
    const guard = new LicenseSoftlockGuard(service);

    await expect(
      guard.canActivate(makeContext({ method: "POST", path: "/leads" })),
    ).resolves.toBe(true);
    expect(service.getState).not.toHaveBeenCalled();
  });

  it("caches the inert/state decision for the TTL window instead of hitting the service every request", async () => {
    const service = fakeService({ state: activeState() });
    const guard = new LicenseSoftlockGuard(service);
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    await guard.canActivate(makeContext({ method: "POST", path: "/leads" }));
    now += 30_000; // still within the 60s TTL
    await guard.canActivate(makeContext({ method: "POST", path: "/leads" }));

    expect(service.isInert).toHaveBeenCalledTimes(1);
    expect(service.getState).toHaveBeenCalledTimes(1);

    Date.now = realDateNow;
  });

  it("re-checks after the TTL window elapses", async () => {
    const service = fakeService({ state: activeState() });
    const guard = new LicenseSoftlockGuard(service);
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    await guard.canActivate(makeContext({ method: "POST", path: "/leads" }));
    now += 61_000; // past the 60s TTL
    await guard.canActivate(makeContext({ method: "POST", path: "/leads" }));

    expect(service.isInert).toHaveBeenCalledTimes(2);
    expect(service.getState).toHaveBeenCalledTimes(2);

    Date.now = realDateNow;
  });
});
