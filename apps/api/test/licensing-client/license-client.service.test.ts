import { generateKeyPairSync, type KeyLike } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { signCompactToken, type LicenseCachePayload } from "../../src/licensing-client/compact-token";
import { LICENSE_GRACE_WINDOW_MS } from "../../src/licensing-client/license-client.constants";
import { LicenseAccountMismatchError } from "../../src/licensing-client/license-client-errors";
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

// The server's signed cacheToken payload only carries the claims
// LicenseCryptoService.signCache actually signs (status/softLock/hardLock/
// expiresAt/validUntil/iat/exp) — `usable`, `bound`, and `keyPrefix` live
// only on the HTTP body (LicenseActionResult), never in the signed payload.
function actionResultFixture(
  privateKey: KeyLike,
  overrides: Partial<LicenseActionResult> = {},
): LicenseActionResult {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const status = overrides.status ?? "active";
  const softLock = overrides.softLock ?? false;
  const hardLock = overrides.hardLock ?? false;
  const expiresAt =
    overrides.expiresAt ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const validUntil = overrides.validUntil ?? new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

  const payload: LicenseCachePayload = {
    status,
    softLock,
    hardLock,
    expiresAt,
    validUntil,
    iat: nowSeconds,
    exp: nowSeconds + 6 * 60 * 60,
  };

  return {
    status,
    softLock,
    hardLock,
    usable: overrides.usable ?? true,
    expiresAt,
    validUntil,
    bound: overrides.bound ?? true,
    keyPrefix: overrides.keyPrefix ?? "RTD-1234",
    interval: overrides.interval ?? null,
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

  it("getState() reason is 'grace_exceeded' when blocked because contact lapsed past the 72h window", async () => {
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
    expect(state.reason).toBe("grace_exceeded");
  });

  it("getState() reason is 'expired' when a verified blocked verdict has an expiresAt already in the past", async () => {
    const { prisma } = createFakePrisma({
      status: "blocked",
      expiresAt: new Date(Date.now() - 60_000),
      cacheValidUntil: new Date(Date.now() + 6 * 60 * 60 * 1000),
      lastCheckedAt: new Date(),
    });
    const service = new LicenseClientService(prisma, baseEnv(), (async () => {
      throw new Error("no network calls expected");
    }) as typeof fetch);

    const state = await service.getState();

    expect(state.status).toBe("blocked");
    expect(state.reason).toBe("expired");
  });

  it("getState() reason is 'revoked' when a verified blocked verdict has no expiry in the past", async () => {
    const { prisma } = createFakePrisma({
      status: "blocked",
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      cacheValidUntil: new Date(Date.now() + 6 * 60 * 60 * 1000),
      lastCheckedAt: new Date(),
    });
    const service = new LicenseClientService(prisma, baseEnv(), (async () => {
      throw new Error("no network calls expected");
    }) as typeof fetch);

    const state = await service.getState();

    expect(state.status).toBe("blocked");
    expect(state.reason).toBe("revoked");
  });

  it("getState() reason is null for non-blocked states", async () => {
    const { prisma } = createFakePrisma({
      status: "active",
      cacheValidUntil: new Date(Date.now() + 6 * 60 * 60 * 1000),
      lastCheckedAt: new Date(),
    });
    const service = new LicenseClientService(prisma, baseEnv(), (async () => {
      throw new Error("no network calls expected");
    }) as typeof fetch);

    const state = await service.getState();

    expect(state.status).toBe("active");
    expect(state.reason).toBeNull();
  });

  describe("isInert()", () => {
    it("is inert when LICENSE_SERVER_URL is not set, regardless of LicenseState", async () => {
      const { prisma } = createFakePrisma({ status: "active" });
      const service = new LicenseClientService(prisma, baseEnv({ LICENSE_SERVER_URL: undefined }));

      expect(await service.isInert()).toBe(true);
    });

    it("is NOT inert when the server is configured but nothing was ever activated and no key is set", async () => {
      const { prisma } = createFakePrisma(); // no initial row -> findUnique() resolves null
      const service = new LicenseClientService(prisma, baseEnv({ LICENSE_KEY: undefined }));

      expect(await service.isInert()).toBe(false);
    });

    it("is not inert when LICENSE_KEY is set, even without a LicenseState row yet", async () => {
      const { prisma } = createFakePrisma();
      const service = new LicenseClientService(prisma, baseEnv());

      expect(await service.isInert()).toBe(false);
    });

    it("is not inert when a LicenseState row exists, even without LICENSE_KEY set", async () => {
      const { prisma } = createFakePrisma({ status: "active" });
      const service = new LicenseClientService(prisma, baseEnv({ LICENSE_KEY: undefined }));

      expect(await service.isInert()).toBe(false);
    });

    it("stays inert without LICENSE_SERVER_URL even when LICENSE_KEY is set", async () => {
      const { prisma } = createFakePrisma();
      const service = new LicenseClientService(prisma, baseEnv({ LICENSE_SERVER_URL: undefined }));

      expect(await service.isInert()).toBe(true);
    });
  });

  describe("getLockState()", () => {
    function offlineFetch(): typeof fetch {
      return (async () => {
        throw new Error("no network calls expected");
      }) as typeof fetch;
    }

    it("does not lock when inert (no license server configured)", async () => {
      const { prisma } = createFakePrisma();
      const service = new LicenseClientService(
        prisma,
        baseEnv({ LICENSE_SERVER_URL: undefined }),
        offlineFetch(),
      );

      const lock = await service.getLockState();

      expect(lock).toMatchObject({ inert: true, locked: false, reason: null });
    });

    it("locks with 'license_required' when the server is configured and nothing was ever activated", async () => {
      const { prisma } = createFakePrisma();
      const service = new LicenseClientService(prisma, baseEnv({ LICENSE_KEY: undefined }), offlineFetch());

      const lock = await service.getLockState();

      expect(lock.locked).toBe(true);
      expect(lock.reason).toBe("license_required");
      expect(lock.state.status).toBe("unlicensed");
    });

    it("locks with 'license_required' when LICENSE_KEY is set but activation was never attempted", async () => {
      const { prisma } = createFakePrisma();
      const service = new LicenseClientService(prisma, baseEnv(), offlineFetch());

      const lock = await service.getLockState();

      expect(lock.locked).toBe(true);
      expect(lock.reason).toBe("license_required");
    });

    it("locks with 'activation_failed' after an activation attempt with LICENSE_KEY fails", async () => {
      const { prisma } = createFakePrisma();
      const fetchFn = createFetchRouter({
        "/license/public-key": publicKeyHandler,
        "/license/activate": () => new Response(null, { status: 500 }),
      });
      const service = new LicenseClientService(prisma, baseEnv(), fetchFn);

      await expect(service.activate()).rejects.toThrow();
      const lock = await service.getLockState();

      expect(lock.locked).toBe(true);
      expect(lock.reason).toBe("activation_failed");
    });

    it("locks with 'activation_failed' when the key is bound to another account", async () => {
      const { prisma } = createFakePrisma();
      const fetchFn = createFetchRouter({
        "/license/public-key": publicKeyHandler,
        "/license/activate": () => new Response(null, { status: 403 }),
      });
      const service = new LicenseClientService(prisma, baseEnv(), fetchFn);

      await expect(service.activate()).rejects.toBeInstanceOf(LicenseAccountMismatchError);

      expect((await service.getLockState()).reason).toBe("activation_failed");
    });

    it("keeps 'license_required' when activation is refused for missing configuration", async () => {
      const { prisma } = createFakePrisma();
      const service = new LicenseClientService(prisma, baseEnv({ LICENSE_KEY: undefined }), offlineFetch());

      await expect(service.activate()).rejects.toThrow("license_client_not_configured");

      expect((await service.getLockState()).reason).toBe("license_required");
    });

    it("unlocks once activation succeeds, clearing a previous failure", async () => {
      const { prisma } = createFakePrisma();
      let activateStatus = 500;
      const activateResult = actionResultFixture(privateKey, { status: "active" });
      const fetchFn = createFetchRouter({
        "/license/public-key": publicKeyHandler,
        "/license/activate": () =>
          activateStatus === 200 ? Response.json(activateResult) : new Response(null, { status: activateStatus }),
      });
      const service = new LicenseClientService(prisma, baseEnv(), fetchFn);

      await expect(service.activate()).rejects.toThrow();
      expect((await service.getLockState()).reason).toBe("activation_failed");

      activateStatus = 200;
      await service.activate();
      const lock = await service.getLockState();

      expect(lock.locked).toBe(false);
      expect(lock.reason).toBeNull();
    });

    it("does not lock while the license is active", async () => {
      const { prisma } = createFakePrisma({
        status: "active",
        cacheValidUntil: new Date(Date.now() + 6 * 60 * 60 * 1000),
        lastCheckedAt: new Date(),
      });
      const service = new LicenseClientService(prisma, baseEnv(), offlineFetch());

      expect(await service.getLockState()).toMatchObject({ locked: false, reason: null });
    });

    it("does not lock while the license is in the grace window", async () => {
      const { prisma } = createFakePrisma({
        status: "active",
        cacheValidUntil: new Date(Date.now() - 60_000),
        lastCheckedAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      const service = new LicenseClientService(prisma, baseEnv(), offlineFetch());

      const lock = await service.getLockState();

      expect(lock.locked).toBe(false);
      expect(lock.state.status).toBe("grace");
    });

    it("locks with the verified 'revoked' reason for a blocked license", async () => {
      const { prisma } = createFakePrisma({
        status: "blocked",
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        cacheValidUntil: new Date(Date.now() + 6 * 60 * 60 * 1000),
        lastCheckedAt: new Date(),
      });
      const service = new LicenseClientService(prisma, baseEnv(), offlineFetch());

      expect(await service.getLockState()).toMatchObject({ locked: true, reason: "revoked" });
    });

    it("locks with 'grace_exceeded' once the 72h no-contact window lapses", async () => {
      const { prisma } = createFakePrisma({
        status: "active",
        cacheValidUntil: new Date(Date.now() - 60_000),
        lastCheckedAt: new Date(Date.now() - (LICENSE_GRACE_WINDOW_MS + 60_000)),
      });
      const service = new LicenseClientService(prisma, baseEnv(), offlineFetch());

      expect(await service.getLockState()).toMatchObject({ locked: true, reason: "grace_exceeded" });
    });
  });

  describe("license interval", () => {
    it("exposes the interval reported by the license server after activation", async () => {
      const { prisma } = createFakePrisma();
      const activateResult = actionResultFixture(privateKey, { status: "active", interval: "annual" });
      const fetchFn = createFetchRouter({
        "/license/public-key": publicKeyHandler,
        "/license/activate": () => Response.json(activateResult),
      });
      const service = new LicenseClientService(prisma, baseEnv(), fetchFn);

      const state = await service.activate();

      expect(state.interval).toBe("annual");
      expect((await service.getState()).interval).toBe("annual");
    });

    it("reports a null interval when the license server does not send one", async () => {
      const { prisma } = createFakePrisma({
        status: "active",
        cacheValidUntil: new Date(Date.now() + 6 * 60 * 60 * 1000),
        lastCheckedAt: new Date(),
      });
      const service = new LicenseClientService(prisma, baseEnv(), (async () => {
        throw new Error("no network calls expected");
      }) as typeof fetch);

      expect((await service.getState()).interval).toBeNull();
    });
  });

  describe("activate() account mismatch", () => {
    it("throws LicenseAccountMismatchError when the server responds 403", async () => {
      const { prisma } = createFakePrisma();
      const fetchFn = createFetchRouter({
        "/license/public-key": publicKeyHandler,
        "/license/activate": () => new Response(null, { status: 403 }),
      });
      const service = new LicenseClientService(prisma, baseEnv(), fetchFn);

      await expect(service.activate()).rejects.toBeInstanceOf(LicenseAccountMismatchError);
    });

    it("throws LicenseAccountMismatchError when the server responds 409", async () => {
      const { prisma } = createFakePrisma();
      const fetchFn = createFetchRouter({
        "/license/public-key": publicKeyHandler,
        "/license/activate": () => new Response(null, { status: 409 }),
      });
      const service = new LicenseClientService(prisma, baseEnv(), fetchFn);

      await expect(service.activate()).rejects.toBeInstanceOf(LicenseAccountMismatchError);
    });

    it("still throws a plain error for unrelated failures (e.g. 500)", async () => {
      const { prisma } = createFakePrisma();
      const fetchFn = createFetchRouter({
        "/license/public-key": publicKeyHandler,
        "/license/activate": () => new Response(null, { status: 500 }),
      });
      const service = new LicenseClientService(prisma, baseEnv(), fetchFn);

      await expect(service.activate()).rejects.not.toBeInstanceOf(LicenseAccountMismatchError);
    });
  });

  it("activate() uses the key passed in options over LICENSE_KEY when both are set", async () => {
    const { prisma, getRow } = createFakePrisma();
    const activateResult = actionResultFixture(privateKey, { status: "active" });
    let capturedBody: { key?: string } = {};
    const fetchFn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(typeof input === "string" ? input : input.toString()).pathname;
      if (path === "/license/public-key") return publicKeyHandler();
      if (path === "/license/activate") {
        capturedBody = JSON.parse(init?.body as string);
        return Response.json(activateResult);
      }
      throw new Error(`unhandled fetch path in test: ${path}`);
    }) as typeof fetch;
    const service = new LicenseClientService(prisma, baseEnv(), fetchFn);

    await service.activate({ key: "override-key" });

    expect(capturedBody.key).toBe("override-key");
    expect(getRow()?.licenseKeyPrefix).toBe("RTD-1234");
  });
});
