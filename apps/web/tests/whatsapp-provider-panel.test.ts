import type { WhatsappConnectionDto } from "@wpptrack/shared";
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

function renderPanel({
  connections = [connection],
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
    }),
  );
}

describe("WhatsappProviderPanel", () => {
  it("does not render the receiver secret block or raw webhook payload fields", () => {
    const html = renderPanel();

    expect(html).not.toContain("Exibido uma unica vez");
    expect(html).not.toContain("data-presentation-sensitive-field");
    expect(html).not.toContain("payloadAvailable");
    expect(html).not.toContain("externalEventId");
  });

  it("no longer renders the removed student-facing webhook receipt block", () => {
    const html = renderPanel();

    expect(html).not.toContain("Recebimento de webhook");
    expect(html).not.toContain("whatsapp-webhook-receipt-status");
  });
});
