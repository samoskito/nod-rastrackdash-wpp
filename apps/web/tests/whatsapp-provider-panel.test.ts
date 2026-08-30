import type {
  WhatsappConnectionDto,
  WhatsappWebhookReceiptStatusDto,
} from "@wpptrack/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WhatsappProviderPanel } from "../src/app/(app)/integrations/whatsapp-provider-panel";
import type { WhatsappProviderActionResult } from "../src/app/(app)/integrations/whatsapp-provider-actions";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

const connection: WhatsappConnectionDto = {
  id: "connection_1",
  name: "uazapi-principal",
  displayName: "Uazapi Principal",
  provider: "uazapi_byo",
  status: "active",
  lastHealthStatus: "connected",
  lastHealthCheckedAt: "2026-08-30T12:00:00.000Z",
  connectedPhone: null,
  createdAt: "2026-08-01T00:00:00.000Z",
};

const organicReceipt: WhatsappWebhookReceiptStatusDto = {
  hasReceipts: true,
  lastReceivedAt: "2026-08-30T12:00:00.000Z",
  lastSource: "uazapi",
  lastEventType: "message.received",
  lastStatus: "received",
  lastLeadCreated: false,
  recentCount: 2,
};

function renderPanel({
  connections = [connection],
  webhookStatus = null as WhatsappWebhookReceiptStatusDto | null,
  webhookStatusState = "empty" as "real" | "empty" | "error",
} = {}) {
  const action = vi.fn(
    async (): Promise<WhatsappProviderActionResult> => ({
      ok: true,
      message: "ok",
    }),
  );

  return renderToStaticMarkup(
    createElement(WhatsappProviderPanel, {
      connections,
      canManage: true,
      createAction: action,
      testAction: action,
      rotateAction: action,
      webhookStatus,
      webhookStatusState,
    }),
  );
}

describe("WhatsappProviderPanel webhook receipt visibility", () => {
  it("shows students an honest empty state before any webhook arrives", () => {
    const html = renderPanel();

    expect(html).toContain("Nenhum webhook recebido ainda");
  });

  it("shows the organic receipt status inline with the connection panel", () => {
    const html = renderPanel({
      webhookStatus: organicReceipt,
      webhookStatusState: "real",
    });

    expect(html).toContain("Recebido — organico, sem lead CTWA");
    expect(html).toContain("Uazapi Principal");
  });

  it("does not render the receiver secret block or raw webhook payload fields", () => {
    const html = renderPanel({
      webhookStatus: organicReceipt,
      webhookStatusState: "real",
    });

    expect(html).not.toContain("Exibido uma unica vez");
    expect(html).not.toContain("data-presentation-sensitive-field");
    expect(html).not.toContain("payloadAvailable");
    expect(html).not.toContain("externalEventId");
  });
});
