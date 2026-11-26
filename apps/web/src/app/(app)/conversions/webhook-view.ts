import {
  conversionEventCarriesValue,
  webhookEventNames,
  type ConversionEventNameDto,
  type ProviderConversionRuleDto,
} from "@wpptrack/shared";
import { eventLabel } from "../integrations/single-url/single-url-copy";

/**
 * Decisões puras da origem "Webhook / n8n" (uma URL por regra, uma regra por
 * evento, sempre todos os números). Sem React: testadas direto. Sem
 * dependência do Kinbox, para o port ao repositório do aluno.
 */

export type WebhookEventName = (typeof webhookEventNames)[number];

/**
 * A família "uma URL por regra, todos os números": Webhook / n8n e a XMAX
 * CRM. Cada plataforma tem a sua regra por evento (a da XMAX não ocupa o
 * evento do n8n).
 */
export type WebhookFamilySource = "webhook" | "xmax";

export function isWebhookFamilyOrigin(
  origin: string | null | undefined,
): origin is "automation_webhook" | "automation_xmax" {
  return origin === "automation_webhook" || origin === "automation_xmax";
}

export function webhookSourceOfOrigin(
  origin: string | null | undefined,
): WebhookFamilySource {
  return origin === "automation_xmax" ? "xmax" : "webhook";
}

/** Fluxo pronto para importar no n8n (cópia de docs/setup/n8n). */
export const WEBHOOK_N8N_FLOW_PATH =
  "/integrations/n8n/webhook-conversao.json";

export function webhookRulesOf(
  rules: readonly ProviderConversionRuleDto[],
  sources: readonly WebhookFamilySource[] = ["webhook"],
): ProviderConversionRuleDto[] {
  return rules
    .filter((rule) =>
      sources.includes(rule.automationSource as WebhookFamilySource),
    )
    .sort(
      (left, right) =>
        webhookEventNames.indexOf(
          left.conversionRule.eventName as WebhookEventName,
        ) -
        webhookEventNames.indexOf(
          right.conversionRule.eventName as WebhookEventName,
        ),
    );
}

export function webhookRuleForEvent(
  rules: readonly ProviderConversionRuleDto[],
  eventName: string,
  source: WebhookFamilySource = "webhook",
): ProviderConversionRuleDto | null {
  return (
    rules.find(
      (rule) =>
        (rule.automationSource ?? "webhook") === source &&
        rule.conversionRule.eventName === eventName,
    ) ?? null
  );
}

/** Lead qualificado, depois Compra, depois o primeiro evento sem regra. */
export function firstFreeWebhookEvent(
  rules: readonly ProviderConversionRuleDto[],
  source: WebhookFamilySource = "webhook",
): WebhookEventName | null {
  const used = new Set(
    rules
      .filter((rule) => (rule.automationSource ?? "webhook") === source)
      .map((rule) => rule.conversionRule.eventName),
  );
  return (
    (["QualifiedLead", "Purchase"] as const).find(
      (eventName) => !used.has(eventName),
    ) ??
    webhookEventNames.find((eventName) => !used.has(eventName)) ??
    null
  );
}

export function webhookEventCarriesValue(eventName: string): boolean {
  return conversionEventCarriesValue(eventName as ConversionEventNameDto);
}

export function webhookRuleName(
  eventName: string,
  source: WebhookFamilySource = "webhook",
): string {
  const platform = source === "xmax" ? "XMAX" : "Webhook / n8n";
  return `${platform}: ${eventLabel(eventName)}`.slice(0, 120);
}

/** Recusas da API escritas para a tela (400/409). */
const webhookApiMessages: ReadonlySet<string> = new Set([
  "A regra de webhook vale para todos os números",
  "Conecte (ou retome) um número de WhatsApp antes de criar uma regra de webhook",
  "Este evento já tem uma regra de webhook; use a URL dela",
  "Informe o valor fixo (ticket médio) para usar valor fixo",
  // XMAX CRM (mesmo modelo).
  "Este evento já tem uma regra da XMAX; use a URL dela",
  "A regra da XMAX usa sempre o valor fixo",
]);

export function isWebhookApiMessage(message: string): boolean {
  return webhookApiMessages.has(message);
}

/** Corpo de exemplo da chamada (dados fictícios). */
export function webhookBodyExample(eventName: string): string {
  const body: Record<string, string | number> = { phone: "5511999999999" };
  if (webhookEventCarriesValue(eventName)) {
    body.value = 1500;
    body.currency = "BRL";
  }
  body.message_id = "id-da-mensagem";
  return JSON.stringify(body, null, 2);
}

/**
 * XMAX CRM: corpo que a automação de etapa envia (dados fictícios). Só o ID
 * da oportunidade e o telefone importam; a etapa aparece só para conferência.
 */
export function xmaxBodyExample(): string {
  return JSON.stringify(
    {
      ID_oportunidade: "90001",
      Etapa_oportunidade: "3 Negociação",
      Telefone_oportunidade: "5511900000002",
    },
    null,
    2,
  );
}

/** Passo a passo da XMAX (o guia completo fica em docs/setup/xmax.md). */
export const xmaxSetupSteps: readonly string[] = [
  "Copie a URL da regra (uma URL por evento).",
  "No CRM da XMAX, na automação da etapa que marca a conversão, faça a chamada (POST) para essa URL. O token já vai na URL; se preferir, mande-o no cabeçalho x-wpptrack-webhook-token.",
  "A XMAX não cria lead: só converte o contato que já chegou pelo anúncio no seu WhatsApp. O telefone vem de Telefone_oportunidade (ou do primeiro contato da oportunidade).",
  "Mova uma oportunidade de teste para a etapa e confira em Eventos recebidos (aparece “Em observação”; nada vai para a Meta).",
];

/** Passo a passo (curto: o resto está em docs/setup/n8n/README.md). */
export const webhookSetupSteps: readonly string[] = [
  "Copie a URL da regra.",
  "No n8n (ou no painel), faça um POST para essa URL com o JSON abaixo. phone_number_id só se você tiver mais de um número.",
  "Chame a URL com um lead de teste que veio do anúncio e confira o recebimento.",
  "Com o recebimento certo, ative o envio.",
];
