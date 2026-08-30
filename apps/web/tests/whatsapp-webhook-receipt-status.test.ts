import type { WhatsappWebhookReceiptStatusDto } from "@wpptrack/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WhatsappWebhookReceiptStatus } from "../src/app/(app)/integrations/whatsapp-webhook-receipt-status";

const organicReceipt: WhatsappWebhookReceiptStatusDto = {
  hasReceipts: true,
  lastReceivedAt: "2026-08-30T12:00:00.000Z",
  lastSource: "uazapi",
  lastEventType: "message.received",
  lastStatus: "received",
  lastLeadCreated: false,
  recentCount: 3,
};

const ctwaReceipt: WhatsappWebhookReceiptStatusDto = {
  ...organicReceipt,
  lastLeadCreated: true,
};

function render(
  status: WhatsappWebhookReceiptStatusDto | null,
  state: "real" | "empty" | "error",
) {
  return renderToStaticMarkup(
    createElement(WhatsappWebhookReceiptStatus, { status, state }),
  );
}

describe("WhatsappWebhookReceiptStatus", () => {
  it("shows an honest empty state without inventing data when nothing was received", () => {
    const html = render(null, "empty");

    expect(html).toContain("Nenhum webhook recebido ainda");
    expect(html).not.toContain("Recebido");
  });

  it("renders an organic receipt as received without a CTWA lead", () => {
    const html = render(organicReceipt, "real");

    expect(html).toContain("Recebido — organico, sem lead CTWA");
    expect(html).toContain("Origem: Uazapi");
    expect(html).toContain("3 webhooks recentes");
    expect(html).not.toContain("lead CTWA criado");
  });

  it("renders a CTWA lead outcome distinctly from the organic case", () => {
    const html = render(ctwaReceipt, "real");

    expect(html).toContain("Recebido — lead CTWA criado");
    expect(html).not.toContain("sem lead CTWA");
  });

  it("surfaces an error state without pretending the webhook was received", () => {
    const html = render(null, "error");

    expect(html).toContain("Nao foi possivel carregar o status do webhook");
    expect(html).not.toContain("Recebido");
  });

  it("never renders raw ids, hashes or payload fields", () => {
    const html = render(organicReceipt, "real");

    expect(html).not.toContain("phoneHash");
    expect(html).not.toContain("payload");
    expect(html).not.toContain("externalEventId");
  });
});
