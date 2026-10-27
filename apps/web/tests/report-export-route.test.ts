import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/(app)/reports/export/route";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("report export route", () => {
  it("proxies campaign CSV exports from the API", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(
          "Campanha,Status,Investimento\nBlack Friday WhatsApp,active,1200.00\n",
          {
            status: 200,
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition":
                'attachment; filename="wpptrack-campanhas-2026-07-01-2026-07-02.csv"',
            },
          },
        ),
    ) as typeof fetch;

    const response = await GET(
      new Request(
        "http://localhost/reports/export?since=2026-07-01&until=2026-07-02&businessId=business_1&adAccountId=act_1&delivery=had_delivery&selectedIds=cmp_1%2Ccmp_2&whatsappClassification=whatsapp&compareSince=2026-06-24&compareUntil=2026-06-30",
      ),
    );
    const body = await response.text();

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/reports/campaigns/export.csv?since=2026-07-01&until=2026-07-02&businessId=business_1&adAccountId=act_1&delivery=had_delivery&selectedIds=cmp_1%2Ccmp_2&whatsappClassification=whatsapp",
      expect.objectContaining({
        credentials: "include",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Content-Disposition")).toContain(
      "wpptrack-campanhas-2026-07-01-2026-07-02.csv",
    );
    expect(body).toContain("Black Friday WhatsApp");
  });

  it("6.3b: forwards the WhatsApp number so the CSV follows the screen", async () => {
    global.fetch = vi.fn(
      async () => new Response("Campanha;", { status: 200 }),
    ) as typeof fetch;

    await GET(
      new Request(
        "http://localhost/reports/export?since=2026-07-01&until=2026-07-02&whatsappInstanceId=wpp_1",
      ),
    );

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/reports/campaigns/export.csv?since=2026-07-01&until=2026-07-02&whatsappInstanceId=wpp_1",
      expect.anything(),
    );
  });
});
