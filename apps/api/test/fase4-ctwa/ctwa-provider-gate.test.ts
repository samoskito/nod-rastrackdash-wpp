import { describe, expect, it, vi } from "vitest";
import { InboundWebhookProvider } from "@prisma/client";
import { ctwaDestinationProviderValue } from "../../src/inbound-webhooks/authorized-ctwa-destination";
import { resolveCtwaLeadProof } from "../../src/conversion-rules/ctwa-lead-proof";

describe("CTWA page/pixel entries before the Unnichat provider exists (Fase 4.0)", () => {
  it("has no provider value yet, so no entry proof is ever accepted", async () => {
    expect(Object.values(InboundWebhookProvider)).not.toContain("unnichat");
    expect(ctwaDestinationProviderValue()).toBeNull();
    const client = {
      conversionEventLog: { findMany: vi.fn() },
      inboundWebhookEvent: { findFirst: vi.fn() },
    };
    expect(
      await resolveCtwaLeadProof(client as never, {
        workspaceId: "ws1",
        leadId: "lead1",
        phoneHash: "h",
        ctwaClid: "clid",
      }),
    ).toBeNull();
    expect(client.conversionEventLog.findMany).not.toHaveBeenCalled();
  });
});
