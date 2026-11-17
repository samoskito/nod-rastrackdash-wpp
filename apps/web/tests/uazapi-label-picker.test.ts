// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UazapiLabelPicker,
  whatsappLabelsPath,
} from "../src/app/(app)/integrations/uazapi-label-picker";

/**
 * O seletor de etiquetas chamava uma rota que a API não tinha (404) e a regra
 * era salva sem a lista. Agora ele chama a rota das conexões WhatsApp e mostra
 * o motivo que a API devolve. Dados fictícios.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPicker() {
  return render(
    createElement(UazapiLabelPicker, {
      whatsappInstanceId: "conexao_1",
      selectedLabels: [],
      onLabelsChange: () => undefined,
      fallbackValue: "",
      onFallbackChange: () => undefined,
    }),
  );
}

describe("UazapiLabelPicker", () => {
  it("calls the API route served by the WhatsApp connections controller", () => {
    expect(whatsappLabelsPath("conexao 1")).toBe(
      "/integrations/whatsapp-connections/conexao%201/labels",
    );
  });

  it("shows the API's reason when Uazapi fails, and reloads on demand", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: "A Uazapi recusou o token desta conexão (HTTP 401).",
          }),
          { status: 502 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: "7", name: "Comprou", colorHex: null, labelId: "7" },
          ]),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    renderPicker();

    await screen.findByText(/A Uazapi recusou o token desta conexão/);
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "/integrations/whatsapp-connections/conexao_1/labels",
    );

    fireEvent.click(screen.getByRole("button", { name: /Recarregar etiquetas/ }));

    await waitFor(() => expect(screen.getByText("Comprou")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
