import { describe, expect, it, vi } from "vitest";
import { MetaAdapter } from "../../src/integrations/meta/meta.adapter";
import { MetaGraphError } from "../../src/integrations/meta/meta-graph-error";
import { MetaGraphUsageMonitor } from "../../src/integrations/meta/meta-graph-usage";

// Fase 6.4 (porte do SaaS 918a0837/f1ec6a9e): miniaturas guardadas por
// criativo. Testes do SaaS para getCreativeThumbnails, adaptados ao nod
// (META_VIDEO_THUMBNAILS_ENABLED lido do env do adapter; o batch do nod não
// lança erro, então o limite de taxa vira MetaGraphError código 4).

describe("meta adapter creative thumbnails (Fase 6.4)", () => {
  it("resolves creative thumbnails at the requested size in one batch", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const body = init?.body as URLSearchParams;
        const batch = JSON.parse(body.get("batch") ?? "[]") as Array<{
          relative_url: string;
        }>;
        expect(batch).toHaveLength(2);
        expect(batch[0]?.relative_url).toContain("thumbnail_width=320");
        expect(batch[0]?.relative_url).toContain("thumbnail_height=320");

        return new Response(
          JSON.stringify([
            {
              code: 200,
              body: JSON.stringify({
                id: "111",
                image_url: "https://example.com/creative-high.jpg",
                thumbnail_url: "https://example.com/creative-320.jpg",
              }),
            },
            {
              code: 200,
              body: JSON.stringify({
                id: "222",
                thumbnail_url: "https://example.com/video-320.jpg",
                video_id: "video_1",
              }),
            },
          ]),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;
    const adapter = new MetaAdapter({}, fetcher);

    const thumbnails = await adapter.getCreativeThumbnails({
      accessToken: "meta-token",
      creativeIds: ["111", "222", "111"],
      size: 320,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(thumbnails.get("111")).toEqual({
      url: "https://example.com/creative-320.jpg",
      source: "image",
    });
    expect(thumbnails.get("222")).toEqual({
      url: "https://example.com/video-320.jpg",
      source: "video",
    });
  });

  it("falls back to video thumbnails only for videos without an image candidate", async () => {
    let batchCall = 0;
    const fetcher = vi.fn(async () => {
      batchCall += 1;

      if (batchCall === 1) {
        return new Response(
          JSON.stringify([
            {
              code: 200,
              body: JSON.stringify({ id: "333", video_id: "video_1" }),
            },
          ]),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify([
          {
            code: 200,
            body: JSON.stringify({
              data: [
                {
                  uri: "https://example.com/video-small.jpg",
                  width: 160,
                  height: 90,
                  is_preferred: false,
                },
                {
                  uri: "https://example.com/video-medium.jpg",
                  width: 480,
                  height: 270,
                  is_preferred: true,
                },
                {
                  uri: "https://example.com/video-large.jpg",
                  width: 1920,
                  height: 1080,
                  is_preferred: false,
                },
              ],
            }),
          },
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const adapter = new MetaAdapter(
      { META_VIDEO_THUMBNAILS_ENABLED: "true" },
      fetcher,
    );


    try {
      const thumbnails = await adapter.getCreativeThumbnails({
        accessToken: "meta-token",
        creativeIds: ["333"],
        size: 320,
      });

      expect(batchCall).toBe(2);
      expect(thumbnails.get("333")).toEqual({
        url: "https://example.com/video-medium.jpg",
        source: "video",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("skips /{video}/thumbnails by default and uses the creative thumbnail", async () => {
    let batchCall = 0;
    const relativeUrls: string[] = [];
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        batchCall += 1;
        const body = init?.body as URLSearchParams;
        relativeUrls.push(
          ...(
            JSON.parse(body.get("batch") ?? "[]") as Array<{
              relative_url: string;
            }>
          ).map((item) => item.relative_url),
        );

        return new Response(
          JSON.stringify([
            {
              code: 200,
              body: JSON.stringify({
                id: "444",
                thumbnail_url: "https://example.com/video-rendered.jpg",
                video_id: "video_1",
              }),
            },
            {
              code: 200,
              body: JSON.stringify({ id: "555", video_id: "video_2" }),
            },
          ]),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;
    const adapter = new MetaAdapter({}, fetcher);

    const thumbnails = await adapter.getCreativeThumbnails({
      accessToken: "meta-token",
      creativeIds: ["444", "555"],
      size: 320,
    });

    // One creative batch only: no /{video}/thumbnails call even for the
    // video creative without an image candidate.
    expect(batchCall).toBe(1);
    expect(relativeUrls.some((url) => url.includes("/thumbnails"))).toBe(
      false,
    );
    expect(thumbnails.get("444")).toEqual({
      url: "https://example.com/video-rendered.jpg",
      source: "video",
    });
    expect(thumbnails.has("555")).toBe(false);
  });

  it("does not call Meta when no creative ids are requested", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const adapter = new MetaAdapter({}, fetcher);

    await expect(
      adapter.getCreativeThumbnails({
        accessToken: "meta-token",
        creativeIds: [],
        size: 320,
      }),
    ).resolves.toEqual(new Map());
    expect(fetcher).not.toHaveBeenCalled();
  });


  it("raises a code-4 MetaGraphError when the thumbnail batch is rate limited", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 4, message: "Application limit" } }),
          { status: 400 },
        ),
    ) as unknown as typeof fetch;
    const adapter = new MetaAdapter({}, fetcher);

    const error = await adapter
      .getCreativeThumbnails({
        accessToken: "meta-token",
        creativeIds: ["111"],
        size: 320,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MetaGraphError);
    expect((error as MetaGraphError).code).toBe(4);
    expect(String((error as Error).message)).not.toContain("meta-token");
  });

  it("feeds batch usage headers to the usage monitor", async () => {
    const monitor = new MetaGraphUsageMonitor();
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify([{ code: 200, body: "{}" }]), {
          status: 200,
          headers: {
            "x-app-usage": JSON.stringify({ call_count: 81 }),
          },
        }),
    ) as unknown as typeof fetch;
    const adapter = new MetaAdapter({}, fetcher, monitor);

    await adapter.getCreativeThumbnails({
      accessToken: "meta-token",
      creativeIds: ["111"],
      size: 320,
    });

    expect(monitor.snapshot().app?.percent).toBe(81);
  });
});
