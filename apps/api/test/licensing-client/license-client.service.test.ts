import { generateKeyPairSync, type KeyLike } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { signCompactToken, type LicenseCachePayload } from "../../src/licensing-client/compact-token";
import { LicenseAccountMismatchError } from "../../src/licensing-client/license-client-errors";
import { deriveLicenseStatus, LicenseClientService } from "../../src/licensing-client/license-client.service";
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

  describe("license server outage (fail open until expiresAt)", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const failingFetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;

    it("deriveLicenseStatus: 10-day outage with expiresAt in the future stays usable", () => {
      const now = Date.now();
      const result = deriveLicenseStatus(
        "active",
        new Date(now + 300 * DAY_MS),
        new Date(now - 7 * DAY_MS),
        new Date(now - 10 * DAY_MS),
        now,
      );
      expect(result).toEqual({ status: "grace", reason: null });
    });

    it("deriveLicenseStatus: lifetime (null expiresAt) stays usable through an outage", () => {
      const now = Date.now();
      expect(deriveLicenseStatus("active", null, new Date(now - DAY_MS), new Date(now - 30 * DAY_MS), now)).toEqual({
        status: "grace",
        reason: null,
      });
    });

    it("deriveLicenseStatus: outage after expiresAt passed blocks as expired", () => {
      const now = Date.now();
      expect(
        deriveLicenseStatus("active", new Date(now - DAY_MS), new Date(now - 7 * DAY_MS), new Date(now - 10 * DAY_MS), now),
      ).toEqual({ status: "blocked", reason: "expired" });
    });

    it("deriveLicenseStatus: expiresAt passed but a fresh cache says grace stays usable", () => {
      const now = Date.now();
      expect(
        deriveLicenseStatus("grace", new Date(now - DAY_MS), new Date(now + 2 * DAY_MS), new Date(now - 60_000), now),
      ).toEqual({ status: "grace", reason: null });
    });

    it("deriveLicenseStatus: a verified blocked verdict stays blocked", () => {
      const now = Date.now();
      expect(
        deriveLicenseStatus("blocked", new Date(now + 300 * DAY_MS), new Date(now + DAY_MS), new Date(now), now),
      ).toEqual({ status: "blocked", reason: "revoked" });
    });

    it("heartbeat() during a 10-day outage keeps the install usable with no lock flags", async () => {
      const { prisma, getRow } = createFakePrisma({
        status: "active",
        fingerprint: "fp-1",
        accountIdentity: "student@example.com",
        expiresAt: new Date(Date.now() + 300 * DAY_MS),
        cacheValidUntil: new Date(Date.now() - 7 * DAY_MS),
        lastCheckedAt: new Date(Date.now() - 10 * DAY_MS),
      });
      const service = new LicenseClientService(prisma, baseEnv(), failingFetch);

      const state = await service.heartbeat();

      expect(state).toMatchObject({
        status: "grace",
        usable: true,
        softLock: false,
        hardLock: false,
        reason: null,
        serverUnreachable: true,
      });
      expect(getRow()?.status).toBe("active");
      expect((await service.getLockState()).locked).toBe(false);
    });

    it("heartbeat() 5xx during an outage never locks", async () => {
      const { prisma } = createFakePrisma({
        status: "active",
        expiresAt: new Date(Date.now() + 300 * DAY_MS),
        cacheValidUntil: new Date(Date.now() - 7 * DAY_MS),
        lastCheckedAt: new Date(Date.now() - 10 * DAY_MS),
      });
      const fetchFn = createFetchRouter({
        "/license/public-key": publicKeyHandler,
        "/license/heartbeat": () => new Response(null, { status: 503 }),
      });
      const service = new LicenseClientService(prisma, baseEnv(), fetchFn);

      const state = await service.heartbeat();

      expect(state.usable).toBe(true);
      expect(state.status).toBe("grace");
    });

    it("heartbeat() during an outage after expiresAt passed is blocked as expired", async () => {
      const { prisma } = createFakePrisma({
        status: "active",
        expiresAt: new Date(Date.now() - DAY_MS),
        cacheValidUntil: new Date(Date.now() - 7 * DAY_MS),
        lastCheckedAt: new Date(Date.now() - 10 * DAY_MS),
      });
      const service = new LicenseClientService(prisma, baseEnv(), failingFetch);

      const state = await service.heartbeat();

      expect(state).toMatchObject({ status: "blocked", reason: "expired", usable: false, hardLock: true });
      expect(await service.getLockState()).toMatchObject({ locked: true, reason: "expired" });
    });

    it("a state the old 72h rule derived as grace_exceeded is usable on the new code", async () => {
      // Exactly what stuck installs have in the DB: stored status "active",
      // stale cache, last confirmation 5 days ago, expiresAt 10/09/2027.
      const { prisma } = createFakePrisma({
        status: "active",
        expiresAt: new Date("2027-09-10T00:00:00.000Z"),
        cacheValidUntil: new Date(Date.now() - 2 * DAY_MS),
        lastCheckedAt: new Date(Date.now() - 5 * DAY_MS),
        lastError: "license_heartbeat_failed:502",
      });
      const service = new LicenseClientService(prisma, baseEnv(), failingFetch);

      const lock = await service.getLockState();
      await service.waitForBackgroundRefresh();

      expect(lock.locked).toBe(false);
      expect(lock.reason).toBeNull();
      expect(lock.state).toMatchObject({ status: "grace", usable: true, hardLock: false, serverUnreachable: true });
    });

    it("recovers to active on the first successful heartbeat after an outage", async () => {
      const { prisma, getRow } = createFakePrisma({
        status: "active",
        fingerprint: "fp-1",
        accountIdentity: "student@example.com",
        expiresAt: new Date(Date.now() + 300 * DAY_MS),
        cacheValidUntil: new Date(Date.now() - 7 * DAY_MS),
        lastCheckedAt: new Date(Date.now() - 10 * DAY_MS),
        lastError: "connect ECONNREFUSED",
      });
      let serverUp = false;
      const fetchFn = createFetchRouter({
        "/license/public-key": publicKeyHandler,
        "/license/heartbeat": () => {
          if (!serverUp) throw new Error("connect ECONNREFUSED");
          return Response.json(actionResultFixture(privateKey, { status: "active" }));
        },
      });
      const service = new LicenseClientService(prisma, baseEnv(), fetchFn);

      expect((await service.heartbeat()).status).toBe("grace");

      serverUp = true;
      const recovered = await service.heartbeat();

      expect(recovered).toMatchObject({ status: "active", source: "server", serverUnreachable: false });
      expect(getRow()?.lastError).toBeNull();
      expect((await service.getState()).status).toBe("active");
    });

    it("getLockState() with a stale cache triggers one throttled background refresh that recovers", async () => {
      const { prisma } = createFakePrisma({
        status: "active",
        fingerprint: "fp-1",
        accountIdentity: "student@example.com",
        expiresAt: new Date(Date.now() + 300 * DAY_MS),
        cacheValidUntil: new Date(Date.now() - DAY_MS),
        lastCheckedAt: new Date(Date.now() - 4 * DAY_MS),
      });
      let heartbeatCalls = 0;
      const fetchFn = createFetchRouter({
        "/license/public-key": publicKeyHandler,
        "/license/heartbeat": () => {
          heartbeatCalls += 1;
          return Response.json(actionResultFixture(privateKey, { status: "active" }));
        },
      });
      const service = new LicenseClientService(prisma, baseEnv(), fetchFn);

      expect((await service.getLockState()).state.status).toBe("grace");
      await service.getLockState(); // in flight / throttled: no second call
      await service.waitForBackgroundRefresh();

      expect(heartbeatCalls).toBe(1);
      expect((await service.getState()).status).toBe("active");
    });

    it("heartbeatIfDue() skips a healthy recent check and retries after a failure", async () => {
      const { prisma } = createFakePrisma({
        status: "active",
        expiresAt: new Date(Date.now() + 300 * DAY_MS),
        cacheValidUntil: new Date(Date.now() + 2 * DAY_MS),
        lastCheckedAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      let heartbeatCalls = 0;
      const fetchFn = createFetchRouter({
        "/license/public-key": publicKeyHandler,
        "/license/heartbeat": () => {
          heartbeatCalls += 1;
          throw new Error("connect ECONNREFUSED");
        },
      });
      const service = new LicenseClientService(prisma, baseEnv(), fetchFn);

      expect(await service.heartbeatIfDue()).toBeNull();
      expect(heartbeatCalls).toBe(0);

      await service.heartbeat(); // fails -> lastError set
      expect(heartbeatCalls).toBe(1);

      await service.heartbeatIfDue(); // retried on the next tick
      expect(heartbeatCalls).toBe(2);
    });
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

    it("never locks just because the server has been unreachable for longer than 72h", async () => {
      const { prisma } = createFakePrisma({
        status: "active",
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        cacheValidUntil: new Date(Date.now() - 60_000),
        lastCheckedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
      });
      const service = new LicenseClientService(prisma, baseEnv(), offlineFetch());

      const lock = await service.getLockState();
      await service.waitForBackgroundRefresh();

      expect(lock).toMatchObject({ locked: false, reason: null });
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
