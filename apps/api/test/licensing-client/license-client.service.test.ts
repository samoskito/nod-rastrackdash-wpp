import { generateKeyPairSync, type KeyLike } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { signCompactToken, type LicenseCachePayload } from "../../src/licensing-client/compact-token";
import { LICENSE_GRACE_WINDOW_MS } from "../../src/licensing-client/license-client.constants";
import { LicenseClientService } from "../../src/licensing-client/license-client.service";
import type { LicenseActionResult } from "../../src/licensing-client/license-client.types";
import { createFakePrisma } from "./support";

const LICENSE_SERVER_URL = "https://license.test";

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    LICENSE_SERVER_URL,
    LICENSE_KEY: "student-key-123",
    LICENSE_ACCOUNT_IDENTITY: "student@example.com",
    ...overrides,
  };
}

function actionResultFixture(
  privateKey: KeyLike,
  overrides: Partial<LicenseCachePayload> = {},
): LicenseActionResult {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: LicenseCachePayload = {
    status: "active",
    softLock: false,
    hardLock: false,
    usable: true,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    validUntil: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    bound: true,
    keyPrefix: "RTD-1234",
    fingerprint: "any-fingerprint",
    iat: nowSeconds,
    exp: nowSeconds + 6 * 60 * 60,
    ...overrides,
  };
  return {
    status: payload.status,
    softLock: payload.softLock,
    hardLock: payload.hardLock,
    usable: payload.usable,
    expiresAt: payload.expiresAt,
    validUntil: payload.validUntil,
    bound: payload.bound,
    keyPrefix: payload.keyPrefix,
    cacheToken: signCompactToken(payload, privateKey),
  };
}

function createFetchRouter(handlers: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url).pathname;
    const handler = handlers[path];
    if (!handler) throw new Error(`unhandled fetch path in test: ${path}`);
    return handler();
  }) as typeof fetch;
}

describe("LicenseClientService", () => {
  let publicKey: KeyLike;
  let privateKey: KeyLike;
  let publicKeyPem: string;

  beforeEach(() => {
    ({ publicKey, privateKey } = generateKeyPairSync("ed25519"));
    publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  });

  function publicKeyHandler(): Response {
    return Response.json({ alg: "Ed25519", publicKey: publicKeyPem });
  }

  it("activate() verifies the server response and persists LicenseState", async () => {
    const { prisma, getRow } = createFakePrisma();
    const activateResult = actionResultFixture(privateKey, { status: "active" });
    const fetchFn = createFetchRouter({
      "/license/public-key": publicKeyHandler,
      "/license/activate": () => Response.json(activateResult),
    });
    const service = new LicenseClientService(prisma, baseEnv(), fetchFn);

    const state = await service.activate();

    expect(state.status).toBe("active");
    expect(state.source).toBe("server");
    const row = getRow();
    expect(row?.status).toBe("active");
    expect(row?.licenseKeyPrefix).toBe("RTD-1234");
    expect(row?.accountIdentity).toBe("student@example.com");
    expect(row?.bound).toBe(true);
    expect(row?.signedCache).toBe(activateResult.cacheToken);
  });

  it("heartbeat() network failure keeps prior status (grace via cache), never jumps to blocked", async () => {
    const { prisma, getRow } = createFakePrisma({
      status: "active",
      fingerprint: "fp-1",
      accountIdentity: "student@example.com",
      licenseKeyPrefix: "RTD-1234",
      cacheValidUntil: new Date(Date.now() - 60_000), // already stale
      lastCheckedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago, inside 72h grace
    });
    const fetchFn: typeof fetch = async () => {
      throw new Error("network unreachable");
    };
    const service = new LicenseClientService(prisma, baseEnv(), fetchFn);
    const lastCheckedBefore = getRow()?.lastCheckedAt;

    const state = await service.heartbeat();

    expect(state.status).toBe("grace");
    expect(state.status).not.toBe("blocked");
    const row = getRow();
    expect(row?.status).toBe("active"); // stored status untouched, "extend nothing"
    expect(row?.lastCheckedAt).toEqual(lastCheckedBefore); // not extended
    expect(row?.lastError).toContain("network unreachable");
  });

  it("a verified 'blocked' server response is persisted and stays blocked (fail-closed)", async () => {
    const { prisma, getRow } = createFakePrisma({
      status: "active",
      fingerprint: "fp-1",
      accountIdentity: "student@example.com",
      licenseKeyPrefix: "RTD-1234",
      cacheValidUntil: new Date(Date.now() + 6 * 60 * 60 * 1000),
      lastCheckedAt: new Date(),
    });
    const blockedResult = actionResultFixture(privateKey, {
      status: "blocked",
      hardLock: true,
      usable: false,
      validUntil: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    });
    const fetchFn = createFetchRouter({
      "/license/public-key": publicKeyHandler,
      "/license/heartbeat": () => Response.json(blockedResult),
    });
    const service = new LicenseClientService(prisma, baseEnv(), fetchFn);

    const state = await service.heartbeat();

    expect(state.status).toBe("blocked");
    expect(getRow()?.status).toBe("blocked");

    const laterState = await service.getState();
    expect(laterState.status).toBe("blocked");
  });

  it("getState() reports grace just inside the 72h no-contact window", async () => {
    const { prisma } = createFakePrisma({
      status: "active",
      cacheValidUntil: new Date(Date.now() - 60_000),
      lastCheckedAt: new Date(Date.now() - (LICENSE_GRACE_WINDOW_MS - 60_000)),
    });
    const service = new LicenseClientService(prisma, baseEnv(), (async () => {
      throw new Error("no network calls expected");
    }) as typeof fetch);

    const state = await service.getState();

    expect(state.status).toBe("grace");
  });

  it("getState() reports blocked just outside the 72h no-contact window", async () => {
    const { prisma } = createFakePrisma({
      status: "active",
      cacheValidUntil: new Date(Date.now() - 60_000),
      lastCheckedAt: new Date(Date.now() - (LICENSE_GRACE_WINDOW_MS + 60_000)),
    });
    const service = new LicenseClientService(prisma, baseEnv(), (async () => {
      throw new Error("no network calls expected");
    }) as typeof fetch);

    const state = await service.getState();

    expect(state.status).toBe("blocked");
  });
});
