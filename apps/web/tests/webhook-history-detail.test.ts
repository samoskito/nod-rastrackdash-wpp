// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhookHistoryDetail } from "../src/components/webhook-history-detail";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// dialog.showModal()/.close() aren't implemented in jsdom.
function stubDialogMethods() {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

describe("WebhookHistoryDetail", () => {
  it("lazily fetches and renders the redacted payload when opened by a real click", async () => {
    stubDialogMethods();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        webhook: {
          id: "log_1",
          receivedAt: "2026-08-30T12:00:00.000Z",
          status: "received",
          source: "uazapi",
          provider: "uazapi_byo",
          eventType: "message.received",
          externalEventId: "ext_1",
          leadId: "lead_1",
          errorCode: null,
        },
        payloadAvailable: true,
        payload: { eventType: "message.received", body: "[redacted-phone]" },
      }),
    );

    render(
      createElement(WebhookHistoryDetail, {
        connectionId: "conn_1",
        webhookLogId: "log_1",
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /inspecionar/i }));

    await waitFor(() => {
      expect(screen.getByText("message.received")).toBeTruthy();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/backoffice/whatsapp-webhooks/connections/conn_1/history/log_1",
    );
    expect(screen.getByText(/\[redacted-phone\]/)).toBeTruthy();
  });

  it("does not fetch again on a second open once the payload is cached", async () => {
    stubDialogMethods();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        webhook: {
          id: "log_1",
          receivedAt: "2026-08-30T12:00:00.000Z",
          status: "received",
          source: "uazapi",
          provider: "uazapi_byo",
          eventType: "message.received",
          externalEventId: "ext_1",
          leadId: null,
          errorCode: null,
        },
        payloadAvailable: true,
        payload: {},
      }),
    );

    render(
      createElement(WebhookHistoryDetail, {
        connectionId: "conn_1",
        webhookLogId: "log_1",
      }),
    );

    const openButton = screen.getByRole("button", { name: /inspecionar/i });
    fireEvent.click(openButton);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByLabelText("Fechar"));
    fireEvent.click(openButton);

    await waitFor(() => {
      expect(screen.getByText("message.received")).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders an honest failure message when the detail read fails", async () => {
    stubDialogMethods();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ message: "boom" }, 500),
    );

    render(
      createElement(WebhookHistoryDetail, {
        connectionId: "conn_1",
        webhookLogId: "log_1",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /inspecionar/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Não foi possível carregar os detalhes deste webhook/),
      ).toBeTruthy();
    });
  });
});
