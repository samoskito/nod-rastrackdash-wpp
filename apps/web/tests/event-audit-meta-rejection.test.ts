import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetaRejectionReason } from "../src/app/(app)/events/event-audit-details";

// Aba "Resposta Meta" da auditoria: motivo legível da recusa da Meta.
describe("MetaRejectionReason", () => {
  const reason =
    "A Meta recusou o evento (código 100, subcódigo 2804019): a Meta considerou um parâmetro do evento inválido. Identificador para suporte da Meta: AbC_12-xyz";

  it("mostra o motivo legível de uma recusa da Meta", () => {
    const html = renderToStaticMarkup(
      createElement(MetaRejectionReason, {
        reasonCode: "MetaCapiRejected",
        reason,
      }),
    );
    expect(html).toContain("Motivo da recusa da Meta");
    expect(html).toContain("código 100, subcódigo 2804019");
    expect(html).toContain("Identificador para suporte da Meta: AbC_12-xyz");
  });

  it("não aparece para outros motivos ou sem texto", () => {
    expect(
      renderToStaticMarkup(
        createElement(MetaRejectionReason, {
          reasonCode: "MissingMetaDestination",
          reason: "Destino Meta não configurado",
        }),
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        createElement(MetaRejectionReason, {
          reasonCode: "MetaCapiRejected",
          reason: null,
        }),
      ),
    ).toBe("");
  });
});
