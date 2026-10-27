import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/(app)/reports/creative-thumbnails/ads/[adId]/route";
import {
  CreativePreview,
  creativePreviewSources,
} from "../src/app/(app)/leads/[leadId]/creative-preview";
import { ReportAdPreview } from "../src/app/(app)/reports/report-ad-preview";
import {
  liveCreativeImageUrl,
  storedCreativeThumbnailSrc,
} from "../src/lib/creative-thumbnail";

const originalFetch = global.fetch;
const hexSeconds = (date: Date) =>
  Math.floor(date.getTime() / 1000).toString(16);
const expiredCdnUrl = `https://scontent.xx.fbcdn.net/v/t45/a.jpg?oe=${hexSeconds(new Date("2020-01-01T00:00:00Z"))}`;
const liveCdnUrl = `https://scontent.xx.fbcdn.net/v/t45/b.jpg?oe=${hexSeconds(new Date("2099-01-01T00:00:00Z"))}`;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("creative thumbnail sources", () => {
  it("builds the versioned same-origin path only for safe ids", () => {
    expect(storedCreativeThumbnailSrc("120210000001", "abcdef0123456789")).toBe(
      "/reports/creative-thumbnails/ads/120210000001?v=abcdef0123456789",
    );
    expect(storedCreativeThumbnailSrc("120210000001", null)).toBeNull();
    expect(storedCreativeThumbnailSrc("../x", "abcdef0123456789")).toBeNull();
    expect(storedCreativeThumbnailSrc("ad_1", "<script>")).toBeNull();
  });

  it("never renders an expired signed Meta CDN URL", () => {
    expect(liveCreativeImageUrl(expiredCdnUrl)).toBeNull();
    expect(liveCreativeImageUrl(liveCdnUrl)).toBe(liveCdnUrl);
    expect(liveCreativeImageUrl("https://cdn.example.test/creative.jpg")).toBe(
      "https://cdn.example.test/creative.jpg",
    );
    expect(liveCreativeImageUrl("javascript:alert(1)")).toBeNull();
  });

  it("prefers the persisted thumbnail on the lead creative card", () => {
    expect(
      creativePreviewSources({
        adId: "ad_1",
        thumbnailUrl: expiredCdnUrl,
        thumbnailVersion: "abcdef0123456789",
      }),
    ).toEqual(["/reports/creative-thumbnails/ads/ad_1?v=abcdef0123456789"]);

    const html = renderToStaticMarkup(
      createElement(CreativePreview, {
        adId: "ad_1",
        adName: "PB0013",
        destinationUrl: null,
        thumbnailUrl: expiredCdnUrl,
        thumbnailVersion: "abcdef0123456789",
      }),
    );

    expect(html).toContain(
      'src="/reports/creative-thumbnails/ads/ad_1?v=abcdef0123456789"',
    );
    expect(html).not.toContain("Miniatura indisponível");
  });

  it("shows the unavailable state instead of a dead Meta URL", () => {
    const html = renderToStaticMarkup(
      createElement(CreativePreview, {
        adId: "ad_1",
        adName: "PB0013",
        destinationUrl: null,
        thumbnailUrl: expiredCdnUrl,
        thumbnailVersion: null,
      }),
    );

    expect(html).toContain("Miniatura indisponível");
    expect(html).not.toContain("fbcdn.net");
  });

  it("uses the persisted thumbnail in report rows", () => {
    const html = renderToStaticMarkup(
      createElement(ReportAdPreview, {
        adId: "ad_1",
        adName: "PB0013",
        previewUrl: expiredCdnUrl,
        thumbnailUrl: expiredCdnUrl,
        thumbnailVersion: "abcdef0123456789",
      }),
    );

    expect(html).toContain(
      'src="/reports/creative-thumbnails/ads/ad_1?v=abcdef0123456789"',
    );
    expect(html).not.toContain("fbcdn.net");
  });
});

describe("creative thumbnail route", () => {
  it("proxies the stored image from the API with the session cookie", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
          status: 200,
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "private, max-age=604800, immutable",
          },
        }),
    ) as typeof fetch;

    const response = await GET(
      new Request("http://localhost/reports/creative-thumbnails/ads/ad_1?v=1"),
      { params: Promise.resolve({ adId: "ad_1" }) },
    );

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/reports/creative-thumbnails/ads/ad_1",
      expect.objectContaining({ credentials: "include", cache: "no-store" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toBe(
      "private, max-age=604800, immutable",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    );
  });

  it("does not forward non-image or missing responses", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "Miniatura indisponível" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    ) as typeof fetch;

    const missing = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ adId: "ad_1" }),
    });
    const invalid = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ adId: "../../leads" }),
    });

    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("");
    expect(invalid.status).toBe(400);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
