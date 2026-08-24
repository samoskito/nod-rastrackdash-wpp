import { describe, expect, it } from "vitest";
import { ZapiWhatsappAdapter } from "../../src/integrations/whatsapp-providers/stubs/zapi-whatsapp.adapter";
import type { WhatsappProviderAdapter } from "../../src/integrations/whatsapp-providers/whatsapp-provider.types";

// "nod_api" graduated to a real adapter in F5.3b — see
// ../nod-api-whatsapp.adapter.test.ts. "waha" graduated to a real adapter
// in F5.4 — see ../waha-whatsapp.adapter.test.ts. Only "zapi" remains a
// stub.
const STUBS: Array<{
  name: string;
  id: "zapi";
  create: () => WhatsappProviderAdapter;
}> = [
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
