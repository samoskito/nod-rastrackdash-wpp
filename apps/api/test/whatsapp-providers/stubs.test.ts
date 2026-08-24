import { describe, expect, it } from "vitest";
import { WahaWhatsappAdapter } from "../../src/integrations/whatsapp-providers/stubs/waha-whatsapp.adapter";
import { ZapiWhatsappAdapter } from "../../src/integrations/whatsapp-providers/stubs/zapi-whatsapp.adapter";
import type { WhatsappProviderAdapter } from "../../src/integrations/whatsapp-providers/whatsapp-provider.types";

// "nod_api" graduated to a real adapter in F5.3b — see
// ../nod-api-whatsapp.adapter.test.ts. Only "waha"/"zapi" remain stubs.
const STUBS: Array<{
  name: string;
  id: "waha" | "zapi";
  create: () => WhatsappProviderAdapter;
}> = [
  { name: "WahaWhatsappAdapter", id: "waha", create: () => new WahaWhatsappAdapter() },
  { name: "ZapiWhatsappAdapter", id: "zapi", create: () => new ZapiWhatsappAdapter() },
];

describe.each(STUBS)("$name (stub)", ({ id, create }) => {
  it(`has id '${id}'`, () => {
    expect(create().id).toBe(id);
  });

  it("getHealth() reports disconnected with message 'not_implemented'", async () => {
    const health = await create().getHealth();

    expect(health).toEqual({
      provider: id,
      status: "disconnected",
      checkedAt: expect.any(String),
      message: "not_implemented",
    });
  });
});
