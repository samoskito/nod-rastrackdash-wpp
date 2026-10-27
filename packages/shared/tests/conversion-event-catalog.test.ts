import { describe, expect, it } from "vitest";
import {
  conversionEventBuilderLabel,
  conversionEventCarriesValue,
  conversionEventCatalog,
  conversionEventCatalogOrder,
  conversionEventCatalogOrdered,
  conversionEventDedupeMode,
  conversionEventMetaEventIdPrefix,
  conversionEventMetadata,
  conversionEventNameSchema,
  conversionEventRequiresValue,
  conversionEventValuePolicy,
} from "../src";

describe("conversion event catalog", () => {
  it("cobre exatamente os eventos do enum compartilhado", () => {
    expect(Object.keys(conversionEventCatalog).sort()).toEqual(
      [...conversionEventNameSchema.options].sort(),
    );
  });

  it("mantem cada entrada coerente com a propria chave", () => {
    for (const [eventName, metadata] of Object.entries(conversionEventCatalog)) {
      expect(metadata.eventName).toBe(eventName);
      expect(metadata.label.length).toBeGreaterThan(1);
      expect(metadata.description.length).toBeGreaterThan(10);
      expect(metadata.metaEventIdPrefix).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("nao usa acento em nenhum texto do catalogo", () => {
    for (const metadata of conversionEventCatalogOrdered) {
      expect(`${metadata.label} ${metadata.description}`).not.toMatch(/[À-ſ]/);
    }
  });

  it("ordena o catalogo pela ordem do funil", () => {
    const orders = conversionEventCatalogOrdered.map((item) => item.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(conversionEventCatalogOrdered[0].eventName).toBe("LeadSubmitted");
    expect(conversionEventCatalogOrdered.at(-1)?.eventName).toBe(
      "ReviewProvided",
    );
  });

  it("preserva os prefixos legados de event_id enviados a Meta", () => {
    expect(conversionEventMetaEventIdPrefix("Purchase")).toBe("purchase");
    expect(conversionEventMetaEventIdPrefix("QualifiedLead")).toBe("qualified");
    expect(conversionEventMetaEventIdPrefix("InitiateCheckout")).toBe(
      "checkout",
    );
    expect(conversionEventMetaEventIdPrefix("AddToCart")).toBe("add_to_cart");
  });

  it("mantem todos os prefixos de event_id unicos", () => {
    const prefixes = conversionEventCatalogOrdered.map(
      (item) => item.metaEventIdPrefix,
    );
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("classifica a politica de valor de cada evento", () => {
    expect(conversionEventValuePolicy("Purchase")).toBe("required");
    expect(conversionEventValuePolicy("InitiateCheckout")).toBe("required");
    expect(conversionEventValuePolicy("AddToCart")).toBe("optional");
    expect(conversionEventValuePolicy("QualifiedLead")).toBe("none");
    expect(conversionEventValuePolicy("OrderShipped")).toBe("none");

    expect(conversionEventRequiresValue("Purchase")).toBe(true);
    expect(conversionEventRequiresValue("AddToCart")).toBe(false);
    expect(conversionEventCarriesValue("AddToCart")).toBe(true);
    expect(conversionEventCarriesValue("QualifiedLead")).toBe(false);
  });

  it("reserva o dedupe vitalicio para eventos de uma vez por lead", () => {
    const lifetime = conversionEventCatalogOrdered
      .filter((item) => item.dedupeMode === "lifetime")
      .map((item) => item.eventName);

    expect(lifetime).toEqual(["LeadSubmitted", "QualifiedLead"]);
    expect(conversionEventDedupeMode("Purchase")).toBe("rolling_window");
  });

  it("so marca hasItems em eventos que carregam valor", () => {
    for (const metadata of conversionEventCatalogOrdered) {
      if (metadata.hasItems) {
        expect(metadata.valuePolicy).not.toBe("none");
      }
    }
  });

  it("expoe rotulo do builder e cai no proprio nome para evento desconhecido", () => {
    expect(conversionEventBuilderLabel("QualifiedLead")).toBe(
      "Lead qualificado",
    );
    expect(conversionEventBuilderLabel("Purchase")).toBe("Compra realizada");
    expect(conversionEventBuilderLabel("NaoExiste")).toBe("NaoExiste");
  });

  it("qualifica antes do checkout e fecha a jornada na compra", () => {
    const journey = conversionEventCatalogOrdered
      .filter((item) => item.category !== "operational")
      .map((item) => item.eventName);

    expect(journey).toEqual([
      "LeadSubmitted",
      "ViewContent",
      "AddToCart",
      "QualifiedLead",
      "InitiateCheckout",
      "Purchase",
    ]);
    expect(conversionEventCatalogOrder("InitiateCheckout")).toBeLessThan(
      conversionEventCatalogOrder("Purchase"),
    );
  });

  it("joga evento fora do catalogo para o fim da ordem do funil", () => {
    expect(conversionEventCatalogOrder("NaoExiste")).toBeGreaterThan(
      conversionEventCatalogOrder("ReviewProvided"),
    );
  });

  it("devolve os metadados por evento", () => {
    expect(conversionEventMetadata("Purchase")).toMatchObject({
      category: "conversion",
      valuePolicy: "required",
      hasItems: true,
      hasOrderId: true,
    });
  });
});
