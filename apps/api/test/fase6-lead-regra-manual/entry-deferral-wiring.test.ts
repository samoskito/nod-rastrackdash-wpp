import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fase 6.2a (nod): where the "Lead recebido pela regra" decision is asked.
 * The SaaS asks it on the Unnichat/generic entry and on the Uazapi entry; the
 * nod also asks it on the Meta Cloud (and other non-Unnichat) production
 * path, on the student replay and on the WAHA bridge entry, always with the
 * license gate (never the SaaS seat). The resolver itself is covered by
 * lead-submitted-rule-override.test.ts; here it is replaced to check the
 * wiring. Synthetic data only.
 */
const override = vi.hoisted(() => ({
  resolveLeadSubmittedRuleOverride: vi.fn(
    async (): Promise<{ ruleIds: string[]; ruleNames: string[] } | null> => ({
      ruleIds: ["rule_sintetica"],
      ruleNames: ["Regra sintética"],
    }),
  ),
}));
vi.mock(
  "../../src/conversion-rules/lead-submitted-rule-override",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../src/conversion-rules/lead-submitted-rule-override")
    >()),
    resolveLeadSubmittedRuleOverride: override.resolveLeadSubmittedRuleOverride,
  }),
);

import { InboundWebhookProductionService } from "../../src/inbound-webhook-production/inbound-webhook-production.service";
import { WebhooksController } from "../../src/webhooks/webhooks.controller";
import { wildcardDispatchFixture } from "../support/inbound-wildcard-fixture";

const license = { getLockState: vi.fn(async () => ({ inert: false, locked: false })) };

beforeEach(() => {
  override.resolveLeadSubmittedRuleOverride.mockClear();
});

describe("Meta Cloud entry (production worker)", () => {
  it("asks the deferral with the lead's ad route and the license, and records the entry deferred", async () => {
    const h = wildcardDispatchFixture();
    const production = new InboundWebhookProductionService(
      h.prisma,
      h.encryption,
      h.registry,
      h.leads as never,
      h.conversions as never,
      h.conversionQueue as never,
      h.env,
      license as never,
    );
    await production.processItem({ workspaceId: "ws", productionItemId: "item" });

    expect(override.resolveLeadSubmittedRuleOverride).toHaveBeenCalledWith(
      expect.anything(),
      {
        workspaceId: "ws",
        channel: { id: "channel", connectionId: "connection", provider: "meta_cloud" },
        destination: { kind: "ad_route", adId: "ad-1" },
      },
      { env: h.env, license },
    );
    expect(h.conversions.recordExternalConversion).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTrigger: "inbound_webhook:meta_cloud",
        deferToProviderRule: { ruleIds: ["rule_sintetica"], ruleNames: ["Regra sintética"] },
      }),
    );
  });

  it("without the license service the resolver gets no gate (it never defers then)", async () => {
    const h = wildcardDispatchFixture();
    await h.production.processItem({ workspaceId: "ws", productionItemId: "item" });
    expect(override.resolveLeadSubmittedRuleOverride).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ license: null }),
    );
  });
});

describe("WAHA / Uazapi bridge entry (webhooks controller)", () => {
  function controller(provider: "uazapi" | "waha", env: Record<string, string> = {}) {
    const prisma = {
      inboundWebhookChannel: {
        findUnique: vi.fn(async () => ({
          id: "channel_bridge",
          workspaceId: "ws",
          connectionId: "connection_bridge",
          connection: { provider },
        })),
      },
    };
    const instance = new WebhooksController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      prisma as never,
      undefined,
      license as never,
      env,
    );
    return { instance: instance as any, prisma };
  }

  for (const provider of ["uazapi", "waha"] as const)
    it(`${provider}: a covered bridge number defers its auto_lead entry`, async () => {
      const { instance } = controller(provider);
      await expect(
        instance.bridgedLeadSubmittedOverride(
          provider,
          { workspaceId: "ws", whatsappInstanceId: "instance_sintetica" },
          "ad_1",
        ),
      ).resolves.toEqual({
        ruleIds: ["rule_sintetica"],
        provider,
        channelId: "channel_bridge",
        connectionId: "connection_bridge",
      });
      expect(override.resolveLeadSubmittedRuleOverride).toHaveBeenCalledWith(
        expect.anything(),
        {
          workspaceId: "ws",
          channel: { id: "channel_bridge", connectionId: "connection_bridge", provider },
          destination: { kind: "ad_route", adId: "ad_1" },
        },
        expect.objectContaining({ license }),
      );
    });

  it("bridge of another provider, no ad or the flag explicitly off: never defers", async () => {
    const { instance } = controller("uazapi");
    await expect(
      instance.bridgedLeadSubmittedOverride(
        "waha",
        { workspaceId: "ws", whatsappInstanceId: "instance_sintetica" },
        "ad_1",
      ),
    ).resolves.toBeNull();
    await expect(
      instance.bridgedLeadSubmittedOverride(
        "uazapi",
        { workspaceId: "ws", whatsappInstanceId: "instance_sintetica" },
        null,
      ),
    ).resolves.toBeNull();
    const off = controller("waha", { LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED: "false" });
    await expect(
      off.instance.bridgedLeadSubmittedOverride(
        "waha",
        { workspaceId: "ws", whatsappInstanceId: "instance_sintetica" },
        "ad_1",
      ),
    ).resolves.toBeNull();
    expect(off.prisma.inboundWebhookChannel.findUnique).not.toHaveBeenCalled();
  });
});
