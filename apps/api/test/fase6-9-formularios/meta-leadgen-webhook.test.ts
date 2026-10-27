import { createHmac } from "node:crypto";
import { UnauthorizedException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebhooksController } from "../../src/webhooks/webhooks.controller";

// Fase 6.9 (PR #91 do nod): POST /webhooks/meta, after the signature check,
// sends the "leadgen" changes of a Page with an active lead form connection to
// the lead form ingestion. Any other Page keeps the diagnostic-only path.

const APP_SECRET = "app-secret-de-teste";
const body = {
  object: "page",
  entry: [
    {
      id: "page_exemplo",
      changes: [
        {
          field: "leadgen",
          value: { leadgen_id: "900000000000003", page_id: "111", form_id: "55" },
        },
      ],
    },
  ],
};
const raw = Buffer.from(JSON.stringify(body));
const signature = `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;

function controller(hasConnection: boolean, fetchFailed = 0, inactivePages: string[] = []) {
  const diagnostics = { recordWebhookLog: vi.fn(async () => ({ id: "log" })) };
  const metaLeadForms = {
    inactiveConnectionPages: vi.fn(async () => new Set(inactivePages)),
    activeConnectionPages: vi.fn(async () =>
      hasConnection ? new Set(["111"]) : new Set<string>(),
    ),
    ingestLeadgen: vi.fn(async () => ({
      received: 1,
      saved: 1 - fetchFailed,
      duplicates: 0,
      unrouted: 0,
      fetchFailed,
    })),
  };
  const instance = new WebhooksController(
    diagnostics as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    {},
    metaLeadForms as never,
  );
  return { instance, diagnostics, metaLeadForms };
}

let previousSecret: string | undefined;
beforeEach(() => {
  previousSecret = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = APP_SECRET;
});
afterEach(() => {
  if (previousSecret === undefined) delete process.env.META_APP_SECRET;
  else process.env.META_APP_SECRET = previousSecret;
});

describe("POST /webhooks/meta: leadgen", () => {
  it("a Page with an active form connection goes to the lead form ingestion", async () => {
    const h = controller(true);

    const result = await h.instance.recordMeta(body as never, raw, signature);

    expect(h.metaLeadForms.activeConnectionPages).toHaveBeenCalledWith(["111"], undefined);
    expect(h.metaLeadForms.ingestLeadgen).toHaveBeenCalledWith(
      [{ leadgen_id: "900000000000003", page_id: "111", form_id: "55" }],
      { workspaceId: undefined },
    );
    expect(result).toMatchObject({ saved: 1 });
    expect(h.diagnostics.recordWebhookLog).not.toHaveBeenCalled();
  });

  it("a Graph read failure answers 503 so Meta redelivers", async () => {
    const h = controller(true, 1);

    await expect(h.instance.recordMeta(body as never, raw, signature)).rejects.toMatchObject({
      status: 503,
    });
  });

  it("a mixed delivery ingests only the connected Page and keeps the rest on the old path", async () => {
    const mixed = {
      object: "page",
      entry: [
        body.entry[0],
        {
          id: "page_sem_conexao",
          changes: [
            { field: "leadgen", value: { leadgen_id: "900000000000004", page_id: "222" } },
          ],
        },
      ],
    };
    const mixedRaw = Buffer.from(JSON.stringify(mixed));
    const mixedSignature = `sha256=${createHmac("sha256", APP_SECRET).update(mixedRaw).digest("hex")}`;
    const h = controller(true);
    const oldPath = vi
      .spyOn(h.instance as any, "resolveMetaContext")
      .mockRejectedValue(new Error("página desconhecida"));

    const result = await h.instance.recordMeta(mixed as never, mixedRaw, mixedSignature);

    expect(h.metaLeadForms.ingestLeadgen).toHaveBeenCalledWith(
      [{ leadgen_id: "900000000000003", page_id: "111", form_id: "55" }],
      { workspaceId: undefined },
    );
    expect(oldPath).toHaveBeenCalled();
    expect(result).toMatchObject({ saved: 1 });
  });

  it("never reads a leadgen without a valid signature", async () => {
    const h = controller(true);

    await expect(
      h.instance.recordMeta(body as never, raw, "sha256=" + "0".repeat(64)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.metaLeadForms.ingestLeadgen).not.toHaveBeenCalled();
  });

  it("a Page without connection keeps the previous path (never ingested)", async () => {
    const h = controller(false);

    await h.instance.recordMeta(body as never, raw, signature).catch(() => undefined);

    expect(h.metaLeadForms.ingestLeadgen).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/meta: Página com a conexão desativada", () => {
  it("answers 2xx and ignores the leadgen: nothing read, saved or logged", async () => {
    const h = controller(false, 0, ["111"]);
    const oldPath = vi.spyOn(h.instance as any, "resolveMetaContext");

    const result = await h.instance.recordMeta(body as never, raw, signature);

    expect(h.metaLeadForms.inactiveConnectionPages).toHaveBeenCalledWith(["111"], undefined);
    expect(h.metaLeadForms.ingestLeadgen).not.toHaveBeenCalled();
    expect(oldPath).not.toHaveBeenCalled();
    expect(h.diagnostics.recordWebhookLog).not.toHaveBeenCalled();
    expect(result).toMatchObject({ saved: 0, ignoredInactive: 1 });
  });

  it("an active Page in the same delivery is still ingested", async () => {
    const mixed = {
      object: "page",
      entry: [
        body.entry[0],
        {
          id: "page_desativada",
          changes: [
            { field: "leadgen", value: { leadgen_id: "900000000000005", page_id: "333" } },
          ],
        },
      ],
    };
    const mixedRaw = Buffer.from(JSON.stringify(mixed));
    const mixedSignature = `sha256=${createHmac("sha256", APP_SECRET).update(mixedRaw).digest("hex")}`;
    const h = controller(true, 0, ["333"]);
    const oldPath = vi.spyOn(h.instance as any, "resolveMetaContext");

    const result = await h.instance.recordMeta(mixed as never, mixedRaw, mixedSignature);

    expect(h.metaLeadForms.ingestLeadgen).toHaveBeenCalledWith(
      [{ leadgen_id: "900000000000003", page_id: "111", form_id: "55" }],
      { workspaceId: undefined },
    );
    expect(oldPath).not.toHaveBeenCalled();
    expect(result).toMatchObject({ saved: 1, ignoredInactive: 1 });
  });
});
