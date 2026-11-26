import { createHash } from "node:crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  conversionEventNameSchema,
  conversionEventRequiresValue,
  isWebhookFamilyProvider,
  isXmaxProvider,
  type WebhookFamilyProvider,
  type WebhookValueSourceDto,
} from "@wpptrack/shared";
import type { Prisma } from "@prisma/client";
import { readWebhookValueSource } from "../inbound-webhooks/providers/webhook/webhook-automation-v1.parser";

/**
 * Regras Webhook / n8n (uma URL por regra): as checagens ficam aqui para o
 * servico de regras so chamar.
 *
 * - sempre todos os numeros, ancorada numa conexao de WhatsApp viva; a URL
 *   da regra e a URL publica;
 * - uma regra por evento (uma URL por evento: duas fariam o mesmo trabalho);
 * - evento com valor: "received" (valor do corpo, o da regra e reserva
 *   opcional) ou "fixed" (o da regra, obrigatorio quando o evento exige).
 *
 * A XMAX CRM segue as mesmas regras (uma regra por evento DA XMAX), com o
 * valor sempre fixo.
 */
export const WEBHOOK_ALL_NUMBERS_MESSAGE =
  "A regra de webhook vale para todos os números";
export const WEBHOOK_NO_NUMBER_MESSAGE =
  "Conecte (ou retome) um número de WhatsApp antes de criar uma regra de webhook";
export const WEBHOOK_EVENT_TAKEN_MESSAGE =
  "Este evento já tem uma regra de webhook; use a URL dela";
export const WEBHOOK_FIXED_VALUE_MESSAGE =
  "Informe o valor fixo (ticket médio) para usar valor fixo";
export const XMAX_EVENT_TAKEN_MESSAGE =
  "Este evento já tem uma regra da XMAX; use a URL dela";
export const XMAX_FIXED_VALUE_ONLY_MESSAGE =
  "A regra da XMAX usa sempre o valor fixo";

/** Webhook / n8n or XMAX CRM rule (same model): its provider, else null. */
export function webhookFamilyProviderOf(rule: {
  conversionRule: { triggerType: string };
  parserRelease?: { provider: string } | null;
}): WebhookFamilyProvider | null {
  const provider = rule.parserRelease?.provider;
  return rule.conversionRule.triggerType === "provider_automation" &&
    isWebhookFamilyProvider(provider)
    ? provider
    : null;
}

/** Webhook / n8n or XMAX CRM rule (URL per rule, every number). */
export function isWebhookRule(rule: {
  conversionRule: { triggerType: string };
  parserRelease?: { provider: string } | null;
}): boolean {
  return webhookFamilyProviderOf(rule) !== null;
}

/** Serializa a criacao de regras de webhook do workspace (trava da transacao). */
export async function lockWebhookRules(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  const digest = createHash("sha256")
    .update(JSON.stringify(["webhook-rules-lock-v1", workspaceId]))
    .digest("hex");
  const lockId = BigInt.asIntN(64, BigInt(`0x${digest.slice(0, 16)}`));
  await transaction.$queryRaw`SELECT pg_advisory_xact_lock(${lockId}::bigint)::text`;
}

export async function assertWebhookEventFree(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  eventName: string,
  provider: WebhookFamilyProvider = "webhook",
): Promise<void> {
  const existing = await transaction.providerConversionRuleConfig.findFirst({
    where: {
      workspaceId,
      removedAt: null,
      conversionRule: { triggerType: "provider_automation", eventName },
      parserRelease: { is: { provider } },
    },
    select: { id: true },
  });
  if (existing) {
    throw new ConflictException(
      isXmaxProvider(provider)
        ? XMAX_EVENT_TAKEN_MESSAGE
        : WEBHOOK_EVENT_TAKEN_MESSAGE,
    );
  }
}

export function assertWebhookCreate(input: {
  connection: { status: string } | null;
  scope: string | undefined;
}): void {
  if (
    !input.connection ||
    !["observation", "production"].includes(input.connection.status)
  ) {
    throw new BadRequestException(WEBHOOK_NO_NUMBER_MESSAGE);
  }
  if ((input.scope ?? "specific_numbers") !== "all_numbers") {
    throw new BadRequestException(WEBHOOK_ALL_NUMBERS_MESSAGE);
  }
}

/**
 * Checagens de edicao (e recusa dos campos de webhook em outra regra). Devolve
 * se a regra pode ficar sem valor fixo ("valor recebido" com reserva opcional).
 */
export function assertWebhookUpdate(
  current: {
    conversionRule: {
      triggerType: string;
      eventName: string;
      defaultValueCents: number | null;
      defaultItems: unknown;
    };
    parserRelease?: { provider: string } | null;
  },
  input: {
    webhookValueSource?: WebhookValueSourceDto;
    defaultValueCents?: number | null;
    scope?: string;
    channelIds?: string[];
  },
): { valueOptional: boolean } {
  if (!isWebhookRule(current)) {
    if (input.webhookValueSource !== undefined) {
      throw new BadRequestException(
        "A origem do valor pertence apenas às regras de webhook",
      );
    }
    return { valueOptional: false };
  }
  if (input.scope === "specific_numbers" || input.channelIds) {
    throw new BadRequestException(WEBHOOK_ALL_NUMBERS_MESSAGE);
  }
  // XMAX CRM: always the rule's fixed value (no value field yet).
  const xmax = isXmaxProvider(current.parserRelease?.provider);
  if (xmax && input.webhookValueSource === "received") {
    throw new BadRequestException(XMAX_FIXED_VALUE_ONLY_MESSAGE);
  }
  const source = xmax
    ? "fixed"
    : (input.webhookValueSource ??
      readWebhookValueSource(current.conversionRule.defaultItems));
  const eventName = conversionEventNameSchema.safeParse(
    current.conversionRule.eventName,
  );
  const nextValue =
    input.defaultValueCents !== undefined
      ? input.defaultValueCents
      : current.conversionRule.defaultValueCents;
  if (
    source === "fixed" &&
    eventName.success &&
    conversionEventRequiresValue(eventName.data) &&
    !nextValue
  ) {
    throw new BadRequestException(WEBHOOK_FIXED_VALUE_MESSAGE);
  }
  return { valueOptional: source === "received" };
}
