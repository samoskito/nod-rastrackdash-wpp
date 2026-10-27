import { Test } from "@nestjs/testing";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/auth.service";
import {
  liveHttpUrl,
  metaCdnUrlExpiresAt,
} from "../../src/integrations/meta/meta-cdn-url";
import {
  creativeThumbnailBackoffMs,
  creativeThumbnailNeedsRefresh,
  isMetaRateLimitError,
  MetaCreativeThumbnailService,
  type MetaCreativeThumbnailState,
} from "../../src/integrations/meta/meta-creative-thumbnail.service";
import { CreativeThumbnailsController } from "../../src/reporting/creative-thumbnails.controller";
import { WorkspacesService } from "../../src/workspaces/workspaces.service";

const NOW = new Date("2026-10-13T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const hexSeconds = (date: Date) =>
  Math.floor(date.getTime() / 1000).toString(16);
const cdnUrl = (name: string, expiresAt = new Date(NOW.getTime() + 2 * DAY)) =>
  `https://scontent.fgru1-1.fna.fbcdn.net/v/t45/${name}.jpg?stp=dst-jpg_p320x320&oe=${hexSeconds(expiresAt)}`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

type Row = Record<string, unknown> & {
  workspaceId: string;
  creativeId: string;
};

function createHarness(
  options: {
    rows?: Row[];
    candidates?: Map<string, { url: string; source: "image" | "video" }>;
    adapterError?: Error;
    env?: Record<string, string>;
    download?: (url: string) => Response;
  } = {},
) {
  const rows: Row[] = options.rows ?? [];
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === "object" && "in" in value) {
        return (value as { in: unknown[] }).in.includes(row[key]);
      }

      return row[key] === value;
    });
  const prisma = {
    metaCreativeThumbnail: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((row) => matches(row, where)),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          rows.find((row) => matches(row, where)) ?? null,
      ),
      upsert: vi.fn(
        async (args: {
          where: {
            workspaceId_creativeId: { workspaceId: string; creativeId: string };
          };
          create: Row;
          update: Record<string, unknown>;
        }) => {
          const key = args.where.workspaceId_creativeId;
          const existing = rows.find(
            (row) =>
              row.workspaceId === key.workspaceId &&
              row.creativeId === key.creativeId,
          );

          if (existing) {
            Object.assign(existing, args.update);
            return existing;
          }

          rows.push({ ...args.create });
          return args.create;
        },
      ),
    },
    metaAd: {
      findFirst: vi.fn(
        async ({ where }: { where: { workspaceId: string; adId: string } }) =>
          where.workspaceId === "workspace_1" && where.adId === "ad_1"
            ? { creativeId: "111" }
            : null,
      ),
    },
  };
  const metaAdapter = {
    getCreativeThumbnails: vi.fn(async () => {
      if (options.adapterError) {
        throw options.adapterError;
      }

      return options.candidates ?? new Map();
    }),
  };
  const fetchImpl = vi.fn(async (url: string | URL | Request) =>
    options.download
      ? options.download(String(url))
      : new Response(JSON.stringify("unexpected"), { status: 500 }),
  );
  const service = new MetaCreativeThumbnailService(
    prisma as never,
    metaAdapter as never,
    options.env ?? {},
    fetchImpl as unknown as typeof fetch,
  );

  return { fetchImpl, metaAdapter, prisma, rows, service };
}

const jpegResponse = () =>
  new Response(JPEG, {
    status: 200,
    headers: { "Content-Type": "image/jpeg" },
  });

describe("meta CDN url helpers", () => {
  it("parses the hex oe expiry and hides expired signed URLs", () => {
    const expired = cdnUrl("old", new Date(NOW.getTime() - DAY));
    const live = cdnUrl("new");

    expect(metaCdnUrlExpiresAt(live)?.getTime()).toBe(
      Math.floor((NOW.getTime() + 2 * DAY) / 1000) * 1000,
    );
    expect(liveHttpUrl(expired, NOW)).toBeNull();
    expect(liveHttpUrl(live, NOW)).toBe(live);
    expect(liveHttpUrl("https://cdn.example.test/creative.jpg", NOW)).toBe(
      "https://cdn.example.test/creative.jpg",
    );
    expect(liveHttpUrl("data:image/png;base64,AAAA", NOW)).toBeNull();
  });
});

describe("creative thumbnail refresh policy", () => {
  const base: MetaCreativeThumbnailState = {
    creativeId: "111",
    status: "ready",
    byteSize: 1200,
    fetchedAt: new Date(NOW.getTime() - DAY),
    nextAttemptAt: null,
    sourceUrlExpiresAt: null,
    attemptCount: 0,
  };

  it("fetches new creatives and never refetches a stored image", () => {
    expect(creativeThumbnailNeedsRefresh(undefined, NOW)).toBe(true);
    expect(creativeThumbnailNeedsRefresh(base, NOW)).toBe(false);
    // Creatives are immutable: no TTL for stored images.
    expect(
      creativeThumbnailNeedsRefresh(
        { ...base, fetchedAt: new Date(NOW.getTime() - 400 * DAY) },
        NOW,
      ),
    ).toBe(false);
  });

  it("respects backoff for rows without bytes, even with a dead signed URL", () => {
    expect(
      creativeThumbnailNeedsRefresh(
        {
          ...base,
          status: "failed",
          byteSize: null,
          nextAttemptAt: new Date(NOW.getTime() + DAY),
        },
        NOW,
      ),
    ).toBe(false);
    expect(
      creativeThumbnailNeedsRefresh(
        {
          ...base,
          status: "missing",
          byteSize: null,
          nextAttemptAt: new Date(NOW.getTime() - 1),
        },
        NOW,
      ),
    ).toBe(true);
    expect(
      creativeThumbnailNeedsRefresh(
        {
          ...base,
          status: "url_only",
          byteSize: null,
          fetchedAt: new Date(NOW.getTime() - 2 * DAY),
          nextAttemptAt: new Date(NOW.getTime() + DAY),
          sourceUrlExpiresAt: new Date(NOW.getTime() - 60_000),
        },
        NOW,
      ),
    ).toBe(false);
    expect(
      creativeThumbnailNeedsRefresh(
        {
          ...base,
          status: "url_only",
          byteSize: null,
          nextAttemptAt: new Date(NOW.getTime() - 1),
        },
        NOW,
      ),
    ).toBe(true);
    expect(creativeThumbnailBackoffMs(1)).toBe(DAY);
    expect(creativeThumbnailBackoffMs(2)).toBe(2 * DAY);
    expect(creativeThumbnailBackoffMs(10)).toBe(7 * DAY);
  });
});

describe("meta creative thumbnail service", () => {
  it("fetches only new creatives once and stores the image bytes", async () => {
    const { fetchImpl, metaAdapter, rows, service } = createHarness({
      rows: [
        {
          workspaceId: "workspace_1",
          creativeId: "222",
          status: "ready",
          byteSize: 900,
          fetchedAt: new Date(NOW.getTime() - DAY),
          nextAttemptAt: null,
          sourceUrlExpiresAt: null,
          attemptCount: 0,
        },
      ],
      candidates: new Map([["111", { url: cdnUrl("a"), source: "video" }]]),
      download: () => jpegResponse(),
    });

    const result = await service.refreshCreatives({
      workspaceId: "workspace_1",
      accessToken: "token",
      creativeIds: ["111", "222", "111", null, "not-a-meta-id"],
      now: NOW,
    });

    expect(metaAdapter.getCreativeThumbnails).toHaveBeenCalledTimes(1);
    expect(metaAdapter.getCreativeThumbnails).toHaveBeenCalledWith({
      accessToken: "token",
      creativeIds: ["111"],
      size: 320,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ requested: 2, due: 1, stored: 1 });
    const stored = rows.find((row) => row.creativeId === "111")!;
    expect(stored).toMatchObject({
      status: "ready",
      source: "video",
      contentType: "image/jpeg",
      byteSize: JPEG.length,
      nextAttemptAt: null,
      attemptCount: 0,
    });
    expect(stored.version).toMatch(/^[0-9a-f]{16}$/);
    expect(Buffer.from(stored.imageBytes as Uint8Array)).toEqual(
      Buffer.from(JPEG),
    );
    expect((stored.sourceUrlExpiresAt as Date).getTime()).toBeGreaterThan(
      NOW.getTime(),
    );

    // Next sync: nothing is due, so Meta is not called again.
    await service.refreshCreatives({
      workspaceId: "workspace_1",
      accessToken: "token",
      creativeIds: ["111", "222"],
      now: new Date(NOW.getTime() + DAY),
    });
    expect(metaAdapter.getCreativeThumbnails).toHaveBeenCalledTimes(1);
  });

  it("keeps only the URL with backoff when the image cannot be downloaded safely", async () => {
    const { fetchImpl, rows, service } = createHarness({
      candidates: new Map([
        ["111", { url: "https://evil.example.test/a.jpg", source: "image" }],
        ["222", { url: cdnUrl("big"), source: "image" }],
      ]),
      env: { META_CREATIVE_THUMBNAIL_MAX_BYTES: "4" },
      download: () => jpegResponse(),
    });

    const result = await service.refreshCreatives({
      workspaceId: "workspace_1",
      accessToken: "token",
      creativeIds: ["111", "222"],
      now: NOW,
    });

    expect(result).toMatchObject({ stored: 0, urlOnly: 2 });
    // The non-Meta host is never requested.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(rows.find((row) => row.creativeId === "111")).toMatchObject({
      status: "url_only",
      lastError: "thumbnail_host_not_allowed",
      attemptCount: 1,
      nextAttemptAt: new Date(NOW.getTime() + DAY),
    });
    expect(rows.find((row) => row.creativeId === "222")).toMatchObject({
      status: "url_only",
      lastError: "thumbnail_too_large",
    });
  });

  it("backs off the whole batch when Meta fails and never throws", async () => {
    const { rows, service } = createHarness({
      adapterError: new Error("Meta Graph batch HTTP 500"),
    });

    await expect(
      service.refreshCreatives({
        workspaceId: "workspace_1",
        accessToken: "token",
        creativeIds: ["111", "222"],
        now: NOW,
      }),
    ).resolves.toMatchObject({ failed: 2, rateLimited: false });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      status: "failed",
      nextAttemptAt: new Date(NOW.getTime() + DAY),
    });
  });

  it("stops the refresh for the rest of the sync after a Meta rate limit", async () => {
    const { metaAdapter, rows, service } = createHarness({
      adapterError: Object.assign(new Error("User request limit reached"), {
        code: 17,
      }),
    });

    await expect(
      service.refreshCreatives({
        workspaceId: "workspace_1",
        accessToken: "token",
        creativeIds: ["111", "222"],
        now: NOW,
      }),
    ).resolves.toMatchObject({ rateLimited: true, deferred: 2, failed: 0 });
    // No attempt is burnt: rows stay due once the pause ends.
    expect(rows).toHaveLength(0);

    // Next account of the same sync: Meta is not called at all.
    await expect(
      service.refreshCreatives({
        workspaceId: "workspace_2",
        accessToken: "token",
        creativeIds: ["333"],
        now: new Date(NOW.getTime() + 60_000),
      }),
    ).resolves.toMatchObject({ rateLimited: true });
    expect(metaAdapter.getCreativeThumbnails).toHaveBeenCalledTimes(1);

    // After the cooldown the refresh resumes.
    await service.refreshCreatives({
      workspaceId: "workspace_2",
      accessToken: "token",
      creativeIds: ["333"],
      now: new Date(NOW.getTime() + 16 * 60_000),
    });
    expect(metaAdapter.getCreativeThumbnails).toHaveBeenCalledTimes(2);
  });

  it("recognizes Meta rate-limit errors by code or message", () => {
    expect(isMetaRateLimitError(new Error("(#4) Application request limit reached"))).toBe(true);
    expect(isMetaRateLimitError(Object.assign(new Error("x"), { code: 613 }))).toBe(true);
    expect(isMetaRateLimitError({ error: { code: 32 } })).toBe(true);
    expect(isMetaRateLimitError(new Error("(#100) Invalid parameter"))).toBe(false);
    expect(isMetaRateLimitError(Object.assign(new Error("x"), { code: 190 }))).toBe(false);
  });

  it("gives up within the stage budget without touching rows", async () => {
    const { metaAdapter, rows, service } = createHarness({
      env: { META_CREATIVE_THUMBNAIL_STAGE_BUDGET_MS: "20" },
    });
    metaAdapter.getCreativeThumbnails.mockImplementation(
      () => new Promise(() => undefined),
    );

    const startedAt = Date.now();
    const result = await service.refreshCreatives({
      workspaceId: "workspace_1",
      accessToken: "token",
      creativeIds: ["111"],
      now: NOW,
    });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result).toMatchObject({ budgetExhausted: true, deferred: 1 });
    expect(rows).toHaveLength(0);
  });

  it("caps the Meta lookup per sync and defers the rest", async () => {
    const { metaAdapter, service } = createHarness({
      env: { META_CREATIVE_THUMBNAIL_MAX_PER_SYNC: "2" },
    });

    const result = await service.refreshCreatives({
      workspaceId: "workspace_1",
      accessToken: "token",
      creativeIds: ["1", "2", "3", "4", "5"],
      now: NOW,
    });

    expect(metaAdapter.getCreativeThumbnails).toHaveBeenCalledWith(
      expect.objectContaining({ creativeIds: ["1", "2"] }),
    );
    expect(result).toMatchObject({ due: 5, deferred: 3, missing: 2 });
  });

  it("never refetches a stored image, however old", async () => {
    const { metaAdapter, service } = createHarness({
      rows: [
        {
          workspaceId: "workspace_1",
          creativeId: "111",
          status: "ready",
          byteSize: 10,
          imageBytes: JPEG,
          version: "abcdef0123456789",
          fetchedAt: new Date(NOW.getTime() - 400 * DAY),
          nextAttemptAt: null,
          sourceUrlExpiresAt: new Date(NOW.getTime() - 300 * DAY),
          attemptCount: 0,
        },
      ],
    });

    await expect(
      service.refreshCreatives({
        workspaceId: "workspace_1",
        accessToken: "token",
        creativeIds: ["111"],
        now: NOW,
      }),
    ).resolves.toMatchObject({ requested: 1, due: 0 });
    expect(metaAdapter.getCreativeThumbnails).not.toHaveBeenCalled();
  });

  it("looks up stored images scoped to the workspace", async () => {
    const { service } = createHarness({
      rows: [
        {
          workspaceId: "workspace_1",
          creativeId: "111",
          status: "ready",
          imageBytes: JPEG,
          contentType: "image/jpeg",
          version: "abcdef0123456789",
        },
      ],
    });

    await expect(
      service.findStoredThumbnailForAd("workspace_1", "ad_1"),
    ).resolves.toMatchObject({
      contentType: "image/jpeg",
      version: "abcdef0123456789",
    });
    await expect(
      service.findStoredThumbnailForAd("workspace_2", "ad_1"),
    ).resolves.toBeNull();
  });
});

describe("creative thumbnails controller", () => {
  async function createApp(stored: unknown) {
    const thumbnails = {
      findStoredThumbnailForAd: vi.fn(async () => stored),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [CreativeThumbnailsController],
      providers: [
        {
          provide: AuthService,
          useValue: { getSession: vi.fn(async () => ({ user: {} })) },
        },
        {
          provide: WorkspacesService,
          useValue: { getCurrentWorkspace: vi.fn(() => ({ id: "workspace_1" })) },
        },
        { provide: MetaCreativeThumbnailService, useValue: thumbnails },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    return { app, thumbnails };
  }

  it("serves the stored bytes for the current workspace with private cache headers", async () => {
    const { app, thumbnails } = await createApp({
      bytes: Buffer.from(JPEG),
      contentType: "image/jpeg",
      version: "abcdef0123456789",
    });

    const response = await request(app.getHttpServer())
      .get("/reports/creative-thumbnails/ads/ad_1")
      .set("Authorization", "Bearer refresh-token")
      .expect(200);

    expect(thumbnails.findStoredThumbnailForAd).toHaveBeenCalledWith(
      "workspace_1",
      "ad_1",
    );
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.headers["cache-control"]).toBe(
      "private, max-age=604800, immutable",
    );
    expect(Buffer.from(response.body as Buffer)).toEqual(Buffer.from(JPEG));
    await app.close();
  });

  it("returns 404 when nothing is stored and rejects malformed ids", async () => {
    const { app } = await createApp(null);

    await request(app.getHttpServer())
      .get("/reports/creative-thumbnails/ads/ad_1")
      .set("Authorization", "Bearer refresh-token")
      .expect(404);
    await request(app.getHttpServer())
      .get("/reports/creative-thumbnails/ads/ad%20one")
      .set("Authorization", "Bearer refresh-token")
      .expect(400);
    await app.close();
  });
});
