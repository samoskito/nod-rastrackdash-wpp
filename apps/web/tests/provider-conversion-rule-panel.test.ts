import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  ConversionEventNameDto,
  InboundWebhookChannelDto,
  ProviderConversionRuleDto,
} from "@wpptrack/shared";
import {
  buildCreatePayload,
  buildUmblerAutomationPayloadExample,
  ConversionRuleOriginEventSelector,
  mergeTriggerPhrases,
  MessagePhraseFields,
  parseMoneyToCents,
  previewMessagePhrase,
  ProviderConversionRulePanel,
  UmblerAutomationPayloadPanel,
  umblerAutomationKeyForEvent,
} from "../src/app/(app)/integrations/provider-conversion-rule-panel";
import { ProviderCatalogTestResult } from "../src/app/(app)/settings/provider-catalog-test-result";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

const channel = {
  id: "channel_1",
  connectionId: "connection_1",
  organizationId: "organization_1",
  providerChannelId: "provider_channel_1",
  connectedPhone: "+5511999990000",
  channelName: "Comercial",
  whatsappInstanceId: null,
  status: "active",
  productionActivatedAt: null,
  firstSeenAt: "2026-07-21T10:00:00.000Z",
  lastSeenAt: "2026-07-21T11:00:00.000Z",
  routes: [],
  readiness: {
    state: "ready",
    blockers: [],
    routeCount: 1,
    validRouteCount: 1,
    totalCtwa: 1,
    routedCtwa: 1,
    unresolvedCtwa: 0,
    retainedCtwa: 1,
    retainedRoutedCtwa: 1,
    payloadUnavailableCtwa: 0,
    alreadyMaterializedCtwa: 0,
    nextPayloadExpiresAt: null,
  },
  createdAt: "2026-07-21T10:00:00.000Z",
  updatedAt: "2026-07-21T11:00:00.000Z",
} satisfies InboundWebhookChannelDto;

// A channel a student registered right after connecting Umbler/Gupshup,
// before any inbound webhook has arrived (P0.2). No provider identity, no
// routes, no CTWA observed yet — it must still unlock "Nova regra".
const provisionalChannel = {
  ...channel,
  id: "channel_provisional",
  organizationId: "provisional:connection_1",
  providerChannelId: "provisional:5511999990000",
  status: "discovered",
  routes: [],
  readiness: {
    ...channel.readiness,
    state: "waiting",
    blockers: ["route_not_configured", "ctwa_not_observed"],
    routeCount: 0,
    validRouteCount: 0,
    totalCtwa: 0,
    routedCtwa: 0,
    retainedCtwa: 0,
    retainedRoutedCtwa: 0,
  },
} satisfies InboundWebhookChannelDto;

const catalogRule = {
  id: "provider_rule_catalog",
  workspaceId: "workspace_1",
  conversionRule: {
    id: "conversion_rule_catalog",
    workspaceId: "workspace_1",
    name: "Compra por catalogo",
    triggerType: "structured_catalog",
    triggerValue: "structured_catalog",
    matchMode: "exact",
    eventName: "Purchase",
    pixelId: null,
    defaultValueCents: null,
    defaultCurrency: "BRL",
    defaultContentName: "Cama elastica",
    defaultItems: null,
    active: true,
    createdAt: "2026-07-21T12:00:00.000Z",
    updatedAt: "2026-07-21T12:00:00.000Z",
  },
  connectionId: "connection_1",
  mode: "observation",
  parserReleaseId: "parser_1",
  productionActivatedAt: null,
  channelIds: ["channel_1"],
  triggerPhrases: ["Dados para confirmar o pedido"],
  messageAuthorScope: "both",
  valueMode: "fixed",
  exampleMessage: null,
  endpoint: null,
  catalog: {
    id: "catalog_1",
    name: "Camas elasticas",
    productName: "Cama elastica",
    currency: "BRL",
    active: true,
    attributes: [
      { id: "attribute_size", position: 1, key: "tamanho", label: "Tamanho" },
      { id: "attribute_model", position: 2, key: "modelo", label: "Modelo" },
    ],
    variants: [
      {
        id: "variant_1",
        normalizedKey: "4,90\u001fnacional",
        attributeValues: ["4,90", "Nacional"],
        aliases: [[], []],
        valueCents: 359700,
        contentName: null,
        active: true,
      },
    ],
  },
  lastExecution: null,
  createdAt: "2026-07-21T12:00:00.000Z",
  updatedAt: "2026-07-21T12:00:00.000Z",
} satisfies ProviderConversionRuleDto;

describe("provider conversion rule panel", () => {
  it("renders a compact catalog summary and the side-effect-free tester", () => {
    const html = renderPanel({ rules: [catalogRule] });

    expect(html).toContain("Eventos de conversao");
    expect(html).toContain("Compra por catalogo");
    expect(html).toContain("Mensagem com catalogo");
    expect(html).toContain("Camas elasticas");
    expect(html).toContain("Tamanho");
    expect(html).toContain("Modelo");
    expect(html).toContain("R$\u00a03.597,00");
    expect(html).toContain("Testar sem enviar");
    expect(html).toContain("Editar aliases");
    expect(html).toContain("Auditar compras reconhecidas");
    expect(html).toContain('aria-label="Ativar envio automatico"');
  });

  it("keeps management controls out of analyst access", () => {
    const html = renderPanel({ rules: [catalogRule], canManage: false });

    expect(html).toContain("Compra por catalogo");
    expect(html).not.toContain("Nova regra");
    expect(html).not.toContain('aria-label="Remover regra"');
    expect(html).not.toContain('aria-label="Ativar envio automatico"');
    expect(html).not.toContain("Salvar canais");
    expect(html).not.toContain("Editar aliases");
    expect(html).not.toContain("Auditar compras reconhecidas");
  });

  it("hides Nova regra and points to channel registration when no channel exists yet (P0.2)", () => {
    const html = renderPanel({ rules: [], channels: [] });

    expect(html).not.toContain("Nova regra");
    expect(html).toContain("Nenhum canal cadastrado nesta conexao ainda");
    expect(html).not.toMatch(/aguard(e|ando).{0,40}webhook/iu);
    expect(html).not.toMatch(/primeiro payload/iu);
  });

  it("unlocks Nova regra as soon as a provisional channel exists, before any webhook (P0.2)", () => {
    const html = renderPanel({ rules: [], channels: [provisionalChannel] });

    expect(html).toContain("Nova regra");
    expect(html).not.toContain("Nenhum canal cadastrado nesta conexao ainda");
  });

  it("offers explicit production activation for a certified automation rule", () => {
    const html = renderPanel({
      rules: [
        {
          ...catalogRule,
          id: "provider_rule_automation",
          conversionRule: {
            ...catalogRule.conversionRule,
            id: "conversion_rule_automation",
            name: "Lead qualificado",
            triggerType: "provider_automation",
            triggerValue: "provider_automation",
            eventName: "QualifiedLead",
            defaultCurrency: null,
            defaultContentName: null,
          },
          triggerPhrases: [],
          messageAuthorScope: null,
          catalog: null,
        },
      ],
    });

    expect(html).toContain("Lead qualificado");
    expect(html).toContain("Observando");
    expect(html).toContain('aria-label="Ativar envio automatico"');
    expect(html).toContain('aria-label="Gerar nova URL"');
  });

  it("exposes event-level audit when a newer callback is blocked", () => {
    const html = renderPanel({
      rules: [
        {
          ...catalogRule,
          id: "provider_rule_automation",
          mode: "production",
          productionActivatedAt: "2026-07-22T18:00:00.000Z",
          conversionRule: {
            ...catalogRule.conversionRule,
            id: "conversion_rule_automation",
            name: "Lead qualificado",
            triggerType: "provider_automation",
            triggerValue: "provider_automation",
            eventName: "QualifiedLead",
            defaultCurrency: null,
            defaultContentName: null,
          },
          triggerPhrases: [],
          messageAuthorScope: null,
          endpoint: {
            id: "endpoint_1",
            workspaceId: "workspace_1",
            providerRuleId: "provider_rule_automation",
            secretVersion: 1,
            lastDeliveryAt: "2026-07-22T15:34:00.000Z",
            lastSuccessfulParseAt: "2026-07-22T15:34:00.000Z",
            rotatedAt: null,
            removedAt: null,
            createdAt: "2026-07-22T12:00:00.000Z",
            updatedAt: "2026-07-22T15:34:00.000Z",
          },
          catalog: null,
          lastExecution: {
            id: "execution_blocked",
            workspaceId: "workspace_1",
            providerRuleId: "provider_rule_automation",
            sourceDeliveryId: "delivery_blocked",
            channelId: "channel_1",
            externalExecutionKey: "blocked_1",
            occurredAt: "2026-07-22T16:37:00.000Z",
            status: "blocked",
            reasonCode: "automation_paid_lead_missing",
            matchedCatalogVariantId: null,
            valueCents: null,
            currency: null,
            leadId: null,
            conversionEventLogId: null,
            attemptCount: 0,
            createdAt: "2026-07-22T16:37:00.000Z",
            updatedAt: "2026-07-22T16:37:00.000Z",
          },
        },
      ],
    });

    expect(html).toContain("Auditar eventos recebidos");
    expect(html).toContain(
      "Payload, diagnostico e reprocessamento por callback",
    );
    expect(html).not.toContain("Reprocessar ultimo callback observado");
  });

  it("shows UAZAPI tag observation status without the Umbler callback audit", () => {
    const html = renderPanel({
      connectionProvider: "uazapi",
      rules: [
        {
          ...catalogRule,
          id: "provider_rule_uazapi_automation",
          conversionRule: {
            ...catalogRule.conversionRule,
            triggerType: "provider_automation",
            triggerValue: "provider_automation",
          },
          catalog: null,
          endpoint: null,
          lastExecution: null,
        },
      ],
    });

    expect(html).toContain("Lista WhatsApp (chat_labels)");
    expect(html).toContain("Aguardando contato entrar na lista");
    expect(html).not.toContain("Auditar eventos recebidos");
    expect(html).not.toContain("Como configurar na Umbler");
  });

  it("shows how to configure the Umbler HTTP automation on an existing tag rule", () => {
    const html = renderPanel({
      connectionProvider: "umbler",
      rules: [
        {
          ...catalogRule,
          id: "provider_rule_umbler_automation",
          conversionRule: {
            ...catalogRule.conversionRule,
            triggerType: "provider_automation",
            triggerValue: "provider_automation",
            eventName: "QualifiedLead",
            defaultCurrency: null,
            defaultContentName: null,
          },
          triggerPhrases: [],
          messageAuthorScope: null,
          catalog: null,
        },
      ],
    });

    expect(html).toContain("Como configurar na Umbler");
    expect(html).toContain("Corpo JSON da automacao");
    expect(html).toContain("wpptrack.umbler.automation.v1");
    expect(html).toContain("umbler_tag_automation");
    expect(html).toContain("lead_qualificado");
    expect(html).toContain("CONVERSATION_ID");
  });

  it("keeps the Umbler payload helper off a Gupshup automation rule", () => {
    const html = renderPanel({
      connectionProvider: "gupshup",
      rules: [
        {
          ...catalogRule,
          id: "provider_rule_gupshup_automation",
          conversionRule: {
            ...catalogRule.conversionRule,
            triggerType: "provider_automation",
            triggerValue: "provider_automation",
            eventName: "Purchase",
          },
          triggerPhrases: [],
          messageAuthorScope: null,
          catalog: null,
        },
      ],
    });

    expect(html).toContain("Auditar eventos recebidos");
    expect(html).not.toContain("Como configurar na Umbler");
  });

  it("keeps a scoped alias editor wired to the existing catalog update", () => {
    const source = readFileSync(
      new URL(
        "../src/app/(app)/integrations/provider-conversion-rule-panel.tsx",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("Reconhecimento de escrita");
    expect(source).toContain("Salvar aliases");
    expect(source).toContain("splitAliases(aliasDrafts");
    expect(source).toContain("valueCents: variant.valueCents");
    expect(source).toContain('timeZone: "America/Sao_Paulo"');
  });

  it("shows the latest execution outcome without exposing raw message content", () => {
    const html = renderPanel({
      rules: [
        {
          ...catalogRule,
          lastExecution: {
            id: "execution_1",
            workspaceId: "workspace_1",
            providerRuleId: catalogRule.id,
            sourceDeliveryId: "delivery_1",
            channelId: "channel_1",
            externalExecutionKey: "provider-event:1",
            occurredAt: "2026-07-21T13:00:00.000Z",
            status: "blocked",
            reasonCode: "price_mismatch",
            matchedCatalogVariantId: null,
            valueCents: null,
            currency: null,
            leadId: null,
            conversionEventLogId: null,
            attemptCount: 0,
            createdAt: "2026-07-21T13:00:00.000Z",
            updatedAt: "2026-07-21T13:00:00.000Z",
          },
        },
      ],
    });

    expect(html).toContain("Ultimo resultado: Bloqueado");
    expect(html).toContain("Valor diferente do catalogo");
    expect(html).not.toContain("provider-event:1");
  });

  it("keeps two-attribute catalog fields readable and explains optional values", () => {
    const source = readFileSync(
      new URL(
        "../src/app/(app)/integrations/provider-conversion-rule-panel.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const css = readFileSync(
      new URL("../src/styles/globals.css", import.meta.url),
      "utf8",
    );

    expect(source).toContain("Outras formas aceitas (opcional)");
    expect(source).toContain("Nome da variante na Meta (opcional)");
    expect(source).toContain("Automatico: produto + atributos");
    expect(css).toContain(".provider-catalog-variant-attributes");
    expect(css).toContain("minmax(min(100%, 360px), 1fr)");
    expect(css).toContain(".provider-catalog-variant-commerce");
  });

  it("styles the value mode toggle as a segmented pill control with spaced fields and preview", () => {
    const css = readFileSync(
      new URL("../src/styles/globals.css", import.meta.url),
      "utf8",
    );

    expect(css).toContain(".provider-conversion-value-modes label {");
    expect(css).toContain(
      ".provider-conversion-value-modes label:has(input:checked) {",
    );
    expect(css).toContain(".provider-conversion-message-fields {");
    expect(css).toContain(".provider-conversion-preview {");
  });

  it("explains the simulated catalog decision with extracted items and values", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCatalogTestResult, {
        result: {
          matched: true,
          reasonCode: "matched",
          classification: "recognized",
          matchedTriggerPhrase: "Dados para confirmar o pedido",
          parsedAttributes: [
            { key: "tamanho", label: "Tamanho", value: "4,90" },
            { key: "modelo", label: "Modelo", value: "Nacional" },
          ],
          items: [
            {
              position: 1,
              quantity: 2,
              parsedAttributes: [
                { key: "tamanho", label: "Tamanho", value: "4,90" },
                { key: "modelo", label: "Modelo", value: "Nacional" },
              ],
              catalogVariantId: "variant_1",
              unitValueCents: 359700,
              subtotalValueCents: 719400,
              contentName: "Cama elastica",
              reasonCode: "matched",
            },
          ],
          parsedValueCents: 719400,
          calculatedValueCents: 719400,
          observedPaymentValueCents: 700000,
          catalogVariantId: null,
          contentName: "Cama elastica",
          currency: "BRL",
        },
      }),
    );

    expect(html).toContain("Decisao do simulador");
    expect(html).toContain("Variante reconhecida");
    expect(html).toContain("Dados para confirmar o pedido");
    expect(html).toContain("Tamanho");
    expect(html).toContain("4,90");
    expect(html).toContain("Modelo");
    expect(html).toContain("Nacional");
    expect(html).toContain("2 un.");
    expect(html).toContain("R$\u00a07.194,00");
    expect(html).toContain("Valor pelo catalogo");
    expect(html).toContain("Valor informado na mensagem");
    expect(html).toContain("R$\u00a07.000,00");
  });

  it("offers every catalog event under the origin dropdown", () => {
    const html = renderToStaticMarkup(
      createElement(ConversionRuleOriginEventSelector, {
        origin: "message",
        eventName: "QualifiedLead",
        onOriginChange: () => undefined,
        onEventChange: () => undefined,
      }),
    );

    expect(html).toContain("Origem do gatilho");
    expect(html).toContain("Evento enviado a Meta");
    expect(html).toContain("Mensagem no WhatsApp");
    expect(html).toContain("Tag ou automacao do provedor");
    expect(html).toContain("Catalogo estruturado");
    expect(html).toContain("Lead recebido");
    expect(html).toContain("Adicionou ao carrinho");
    expect(html).toContain("Checkout iniciado");
    expect(html).toContain("Lead qualificado");
    expect(html).toContain("Compra realizada");
    expect(html).toContain("Pedido enviado");
    expect(html).toContain("Nao carrega valor");
  });

  it("locks the catalog origin on the only event it supports", () => {
    const html = renderToStaticMarkup(
      createElement(ConversionRuleOriginEventSelector, {
        origin: "catalog",
        eventName: "Purchase",
        onOriginChange: () => undefined,
        onEventChange: () => undefined,
      }),
    );

    expect(html).toContain("Compra realizada");
    expect(html).not.toContain("Adicionou ao carrinho");
    expect(html).not.toContain("Lead qualificado");
  });

  it("builds an InitiateCheckout message rule with a fixed average value", () => {
    const payload = createPayload({
      origin: "message",
      eventName: "InitiateCheckout",
      name: "Checkout Dr Hernia",
      averageValue: "250,00",
      triggerPhrases: "Segue o link do pagamento",
      exampleMessage: "Segue o link do pagamento de R$ 250,00",
      valueMode: "fixed",
    });

    expect(payload).toMatchObject({
      connectionId: "connection_1",
      triggerType: "message_phrase",
      eventName: "InitiateCheckout",
      valueMode: "fixed",
      defaultValueCents: 25_000,
      defaultCurrency: "BRL",
      exampleMessage: "Segue o link do pagamento de R$ 250,00",
      triggerPhrases: ["Segue o link do pagamento"],
      messageAuthorScope: "team",
    });
  });

  it("builds a Purchase message rule that extracts the value from the message", () => {
    const payload = createPayload({
      origin: "message",
      eventName: "Purchase",
      name: "Compra confirmada",
      averageValue: "",
      triggerPhrases: "Pagamento confirmado",
      exampleMessage: "Pagamento confirmado no valor de R$ 1.397,00",
      valueMode: "message_extracted",
    });

    expect(payload).toMatchObject({
      triggerType: "message_phrase",
      eventName: "Purchase",
      valueMode: "message_extracted",
      defaultValueCents: null,
      exampleMessage: "Pagamento confirmado no valor de R$ 1.397,00",
    });
  });

  it("builds a QualifiedLead message rule without any monetary field", () => {
    const payload = createPayload({
      origin: "message",
      eventName: "QualifiedLead",
      name: "Lead qualificado por resposta",
      averageValue: "250,00",
      contentName: "Consulta",
      triggerPhrases: "vou te passar os valores",
      exampleMessage: "Perfeito! Vou te passar os valores agora.",
      valueMode: "message_extracted",
    });

    expect(payload).toMatchObject({
      triggerType: "message_phrase",
      eventName: "QualifiedLead",
      valueMode: "fixed",
      triggerPhrases: ["vou te passar os valores"],
      exampleMessage: "Perfeito! Vou te passar os valores agora.",
      messageAuthorScope: "team",
    });
    expect(payload).not.toHaveProperty("defaultValueCents");
    expect(payload).not.toHaveProperty("defaultCurrency");
    expect(payload).not.toHaveProperty("defaultContentName");
  });

  it("keeps the average value optional for an AddToCart message rule", () => {
    const payload = createPayload({
      origin: "message",
      eventName: "AddToCart",
      name: "Carrinho montado",
      averageValue: "",
      triggerPhrases: "vou querer esse",
      valueMode: "fixed",
    });

    expect(payload).toMatchObject({
      triggerType: "message_phrase",
      eventName: "AddToCart",
      valueMode: "fixed",
      defaultValueCents: null,
      defaultCurrency: "BRL",
    });
  });

  it("builds a Purchase tag rule with label names and no message fields", () => {
    const payload = createPayload({
      origin: "tag",
      eventName: "Purchase",
      name: "Compra por tag",
      averageValue: "299,90",
      contentName: "Pedido medio",
      triggerPhrases: "Venda fechada",
    });

    expect(payload).toMatchObject({
      triggerType: "provider_automation",
      eventName: "Purchase",
      defaultValueCents: 29_990,
      defaultCurrency: "BRL",
      defaultContentName: "Pedido medio",
    });
    expect(payload).toMatchObject({ triggerPhrases: ["Venda fechada"] });
    expect(payload).not.toHaveProperty("valueMode");
  });

  it("builds a QualifiedLead tag rule without monetary fields", () => {
    const payload = createPayload({
      origin: "tag",
      eventName: "QualifiedLead",
      name: "Lead qualificado por tag",
      averageValue: "250,00",
      triggerPhrases: "Lead qualificado",
    });

    expect(payload).toMatchObject({
      triggerType: "provider_automation",
      eventName: "QualifiedLead",
    });
    expect(payload).not.toHaveProperty("defaultValueCents");
  });

  it("keeps the average value required for fixed message rules", () => {
    const result = buildCreatePayload({
      ...payloadInput,
      origin: "message",
      eventName: "InitiateCheckout",
      averageValue: "",
      valueMode: "fixed",
      triggerPhrases: "Segue o link do pagamento",
    });

    expect(result).toEqual({
      ok: false,
      message: "Informe um valor medio valido.",
    });
  });

  it("keeps the average value required for a Purchase tag rule", () => {
    const result = buildCreatePayload({
      ...payloadInput,
      origin: "tag",
      eventName: "Purchase",
      averageValue: "",
      triggerPhrases: "Venda fechada",
    });

    expect(result).toEqual({
      ok: false,
      message: "Informe um valor medio valido.",
    });
  });

  it("keeps the catalog payload free of message value fields", () => {
    const payload = createPayload({
      origin: "catalog",
      eventName: "Purchase",
      triggerPhrases: "Dados para confirmar o pedido",
      catalogName: "Camas elasticas",
      productName: "Cama elastica",
      attributes: [{ id: 1, label: "Tamanho" }],
      variants: [
        {
          id: 1,
          values: ["4,90"],
          aliases: [""],
          value: "3.597,00",
          contentName: "",
        },
      ],
    });

    expect(payload).toMatchObject({
      triggerType: "structured_catalog",
      eventName: "Purchase",
    });
    expect(payload).not.toHaveProperty("valueMode");
    expect(payload).not.toHaveProperty("exampleMessage");
  });

  it("merges the primary phrase and variations into triggerPhrases, deduped and trimmed", () => {
    expect(
      mergeTriggerPhrases(
        "  A sua consulta esta agendada  ",
        "A sua consulta esta confirmada\nconsulta confirmada\n \nA sua consulta esta agendada",
      ),
    ).toBe(
      "  A sua consulta esta agendada  \nA sua consulta esta confirmada\nconsulta confirmada\n \nA sua consulta esta agendada",
    );
  });

  it("builds a message rule payload out of the merged primary phrase and variations", () => {
    const payload = createPayload({
      origin: "message",
      eventName: "Purchase",
      name: "Consulta confirmada",
      averageValue: "",
      valueMode: "message_extracted",
      triggerPhrases: mergeTriggerPhrases(
        "A sua consulta esta agendada",
        "A sua consulta esta confirmada\nconsulta confirmada\n \nA sua consulta esta agendada",
      ),
      exampleMessage: "Estou confirmando: consulta confirmada para amanha.",
    });

    expect(payload).toMatchObject({
      triggerType: "message_phrase",
      triggerPhrases: [
        "A sua consulta esta agendada",
        "A sua consulta esta confirmada",
        "consulta confirmada",
      ],
    });
  });

  it("previews the extracted value of the example message", () => {
    expect(
      previewMessagePhrase({
        triggerPhrases: "Segue o link do pagamento",
        exampleMessage: "Ola! Segue o link do pagamento de R$ 250,00",
        valueMode: "message_extracted",
        averageValue: "",
      }),
    ).toEqual({
      matchedPhrase: "Segue o link do pagamento",
      valueCents: 25_000,
      valueSource: "message",
      ambiguousValue: false,
    });
  });

  it("refuses to guess when the example carries more than one value", () => {
    expect(
      previewMessagePhrase({
        triggerPhrases: "Pagamento confirmado",
        exampleMessage: "Pagamento confirmado: R$ 250,00 de R$ 500,00",
        valueMode: "message_extracted",
        averageValue: "",
      }),
    ).toMatchObject({ valueCents: null, ambiguousValue: true });
  });

  it("falls back to the average value when the example has no value", () => {
    expect(
      previewMessagePhrase({
        triggerPhrases: "Pagamento confirmado",
        exampleMessage: "Pagamento confirmado, obrigado!",
        valueMode: "message_extracted",
        averageValue: "250,00",
      }),
    ).toMatchObject({ valueCents: 25_000, valueSource: "fallback" });
  });

  it("previews the fixed value and reports an example without the trigger phrase", () => {
    expect(
      previewMessagePhrase({
        triggerPhrases: "Pagamento confirmado",
        exampleMessage: "Bom dia, tudo certo por aqui",
        valueMode: "fixed",
        averageValue: "250,00",
      }),
    ).toEqual({
      matchedPhrase: null,
      valueCents: 25_000,
      valueSource: "fixed",
      ambiguousValue: false,
    });
  });

  it("matches a variation phrase even when the example does not repeat the primary phrase", () => {
    const triggerPhrases = mergeTriggerPhrases(
      "A sua consulta esta agendada",
      "consulta confirmada\nestou confirmando sua consulta",
    );

    expect(
      previewMessagePhrase({
        triggerPhrases,
        exampleMessage: "Perfeito, estou confirmando sua consulta para as 14h.",
        valueMode: "fixed",
        averageValue: "",
      }),
    ).toMatchObject({ matchedPhrase: "estou confirmando sua consulta" });
  });

  it("shows the message value fields with a live preview", () => {
    const html = renderToStaticMarkup(
      createElement(MessagePhraseFields, {
        eventName: "InitiateCheckout",
        averageValue: "",
        contentName: "",
        primaryPhrase: "Segue o link do pagamento",
        variationPhrases: "",
        exampleMessage: "Segue o link do pagamento de R$ 250,00",
        valueMode: "message_extracted",
        messageAuthorScope: "team",
        onChange: () => undefined,
      }),
    );

    expect(html).toContain("Exemplo da mensagem");
    expect(html).toContain("Modo de valor");
    expect(html).toContain("Valor fixo");
    expect(html).toContain("Extrair da mensagem");
    expect(html).toContain("Frase principal");
    expect(html).toContain("Variacoes (opcional)");
    expect(html).toContain(
      "Secretarias nem sempre usam a mesma frase. Cadastre variacoes",
    );
    expect(html).toContain("Quem pode enviar");
    expect(html).toContain("Frase gatilho reconhecida");
    expect(html).toContain("Valor extraido do exemplo: R$\u00a0250,00");
    expect(html).toContain("Valor medio (fallback, opcional)");
  });

  it("hides the whole value block for an event that carries no value", () => {
    const html = renderToStaticMarkup(
      createElement(MessagePhraseFields, {
        eventName: "QualifiedLead",
        averageValue: "",
        contentName: "",
        primaryPhrase: "vou te passar os valores",
        variationPhrases: "",
        exampleMessage: "Perfeito! Vou te passar os valores agora.",
        valueMode: "fixed",
        messageAuthorScope: "team",
        onChange: () => undefined,
      }),
    );

    expect(html).toContain("Frase gatilho reconhecida");
    expect(html).toContain("Este evento nao envia valor monetario.");
    expect(html).not.toContain("Modo de valor");
    expect(html).not.toContain("Extrair da mensagem");
    expect(html).not.toContain("Valor medio");
  });

  it("marks the average value as optional for an event that may carry value", () => {
    const html = renderToStaticMarkup(
      createElement(MessagePhraseFields, {
        eventName: "AddToCart",
        averageValue: "",
        contentName: "",
        primaryPhrase: "vou querer esse",
        variationPhrases: "",
        exampleMessage: "",
        valueMode: "fixed",
        messageAuthorScope: "team",
        onChange: () => undefined,
      }),
    );

    expect(html).toContain("Modo de valor");
    expect(html).toContain("Valor medio (opcional)");
  });

  it("finds the matching phrase even when the example only contains a variation", () => {
    const html = renderToStaticMarkup(
      createElement(MessagePhraseFields, {
        eventName: "Purchase",
        averageValue: "",
        contentName: "",
        primaryPhrase: "A sua consulta esta agendada",
        variationPhrases: "consulta confirmada\nestou confirmando sua consulta",
        exampleMessage: "Perfeito, estou confirmando sua consulta para as 14h.",
        valueMode: "fixed",
        messageAuthorScope: "team",
        onChange: () => undefined,
      }),
    );

    expect(html).toContain(
      "Frase gatilho reconhecida: estou confirmando sua consulta",
    );
  });

  it("lists a checkout rule with its event, value mode and example", () => {
    const html = renderPanel({
      rules: [
        {
          ...catalogRule,
          id: "provider_rule_checkout",
          conversionRule: {
            ...catalogRule.conversionRule,
            id: "conversion_rule_checkout",
            name: "Checkout Dr Hernia",
            triggerType: "message_phrase",
            triggerValue: "message_phrase",
            eventName: "InitiateCheckout",
            defaultValueCents: null,
            defaultContentName: null,
          },
          triggerPhrases: ["Segue o link do pagamento"],
          messageAuthorScope: "team",
          valueMode: "message_extracted",
          exampleMessage: "Segue o link do pagamento de R$ 250,00",
          catalog: null,
        },
      ],
    });

    expect(html).toContain("Checkout iniciado");
    expect(html).toContain("Valor na mensagem");
    expect(html).toContain("Exemplo da mensagem");
    expect(html).toContain("Segue o link do pagamento de R$ 250,00");
    expect(html).toContain("Auditar execucoes reconhecidas");
    expect(html).not.toContain("Auditar compras reconhecidas");
  });

  it.each([
    ["3.597,00", 359700],
    ["R$ 1.397,00", 139700],
    ["2997.00", 299700],
    ["", null],
    ["invalido", null],
  ])("normalizes %s to integer cents", (value, expected) => {
    expect(parseMoneyToCents(value)).toBe(expected);
  });
});

const payloadInput = {
  connectionId: "connection_1",
  origin: "message",
  eventName: "Purchase",
  name: "Regra de teste",
  selectedChannelIds: ["channel_1"],
  averageValue: "",
  contentName: "",
  triggerPhrases: "",
  triggerLabels: [],
  messageAuthorScope: "team",
  exampleMessage: "",
  valueMode: "fixed",
  catalogName: "",
  productName: "",
  attributes: [],
  variants: [],
} satisfies Parameters<typeof buildCreatePayload>[0];

function createPayload(
  overrides: Partial<Parameters<typeof buildCreatePayload>[0]>,
): unknown {
  const result = buildCreatePayload({ ...payloadInput, ...overrides });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

function renderPanel({
  rules,
  canManage = true,
  connectionProvider = "umbler",
  channels = [channel],
}: {
  rules: ProviderConversionRuleDto[];
  canManage?: boolean;
  connectionProvider?: "umbler" | "gupshup" | "uazapi";
  channels?: InboundWebhookChannelDto[];
}) {
  const action = vi.fn(async (_formData: FormData) => ({
    ok: true as const,
    message: "ok",
  }));

  return renderToStaticMarkup(
    createElement(ProviderConversionRulePanel, {
      connectionId: "connection_1",
      connectionProvider,
      channels,
      rules,
      enabled: true,
      canManage,
      createAction: action,
      updateAction: action,
      rotateEndpointAction: action,
      loadAutomationAuditAction: action,
      loadAutomationPayloadAction: action,
      loadPurchaseAuditAction: action,
      loadExecutionAuditAction: action,
      reprocessAutomationCallbacksAction: action,
      removeAction: action,
      testMessageAction: action,
    }),
  );
}
