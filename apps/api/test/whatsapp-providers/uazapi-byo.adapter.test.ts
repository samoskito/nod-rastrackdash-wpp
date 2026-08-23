import { describe, expect, it } from "vitest";
import { UazapiAdapter } from "../../src/integrations/uazapi/uazapi.adapter";
import { UazapiByoAdapter } from "../../src/integrations/whatsapp-providers/uazapi-byo.adapter";

describe("UazapiByoAdapter", () => {
  it("has id 'uazapi_byo'", () => {
    const adapter = new UazapiByoAdapter(new UazapiAdapter({}));

    expect(adapter.id).toBe("uazapi_byo");
  });

  it("getHealth() reports disconnected with a message when credentials are missing", async () => {
    const adapter = new UazapiByoAdapter(new UazapiAdapter({}));

    const health = await adapter.getHealth();

    expect(health).toEqual({
      provider: "uazapi_byo",
      status: "disconnected",
      checkedAt: expect.any(String),
      message: "Missing UAZAPI_BASE_URL or UAZAPI_TOKEN",
    });
  });

  it("getHealth() reports connected when UAZAPI_BASE_URL and UAZAPI_TOKEN are set", async () => {
    const adapter = new UazapiByoAdapter(
      new UazapiAdapter({
        UAZAPI_BASE_URL: "https://uazapi.example.com",
        UAZAPI_TOKEN: "instance-token",
      }),
    );

    const health = await adapter.getHealth();

    expect(health.provider).toBe("uazapi_byo");
    expect(health.status).toBe("connected");
    expect(health.message).toBeUndefined();
  });

  it("listLabels() delegates to the wrapped UazapiAdapter and returns its labels", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([{ id: "1", name: "VIP", labelid: "1" }]),
        { status: 200 },
      )) as typeof fetch;
    const adapter = new UazapiByoAdapter(
      new UazapiAdapter(
        {
          UAZAPI_BASE_URL: "https://uazapi.example.com",
          UAZAPI_TOKEN: "instance-token",
        },
        fetchImpl,
      ),
    );

    const result = await adapter.listLabels?.("instance-1");

    expect(result?.status).toBe("success");
    expect(result?.labels).toEqual([
      { id: "1", name: "VIP", colorHex: null, labelId: "1" },
    ]);
  });
});
