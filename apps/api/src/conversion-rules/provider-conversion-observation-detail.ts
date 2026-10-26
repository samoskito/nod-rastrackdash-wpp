import type { Prisma } from "@prisma/client";
import {
  providerConversionObservationDetailSchema,
  type ProviderConversionObservationDetailDto,
} from "@wpptrack/shared";

/**
 * Why an execution ended observed (nothing sent to Meta). New executions
 * carry it in normalizedResult.observationDetail (recorded with the
 * decision); older rows fall back to the only reason codes that say it
 * unambiguously. `before_production_activation` without a recorded detail
 * stays null (rule or number: not knowable afterwards).
 *
 * Ported from the SaaS (#171, `d4c6a419`). Student edition: there is no paid
 * seat and no support team that migrates numbers, so the messages point to
 * what the student can do in the panel.
 */
export function observationDetailOf(input: {
  status: string | null | undefined;
  reasonCode: string | null | undefined;
  normalizedResult: Prisma.JsonValue | null | undefined;
}): ProviderConversionObservationDetailDto | null {
  if (input.status !== "observed") return null;
  const normalized = input.normalizedResult;
  if (
    normalized &&
    typeof normalized === "object" &&
    !Array.isArray(normalized)
  ) {
    const parsed = providerConversionObservationDetailSchema.safeParse(
      (normalized as Record<string, unknown>).observationDetail,
    );
    if (parsed.success) return parsed.data;
  }
  const reasonCode = input.reasonCode ?? "";
  if (
    reasonCode.endsWith("_payt_observation") ||
    reasonCode === "ctwa_requires_canonical_engine"
  ) {
    return "lead_number_legacy_engine";
  }
  if (reasonCode.endsWith("_observation")) return "rule_observation_at_receipt";
  return null;
}

/** Message of a production reprocess whose result is still observed. */
export function observedReprocessMessage(
  detail: ProviderConversionObservationDetailDto | null | undefined,
): string {
  switch (detail) {
    case "lead_number_legacy_engine":
      return "O número do lead ainda usa o motor antigo de conversões; reprocessar não envia";
    case "lead_number_not_production":
      return "O número do lead ainda não está em produção na própria conexão; ative o envio neste número (na regra ou em Integrações) e reprocesse";
    case "production_sending_disabled":
      return "O envio de conversões está desligado no servidor";
    case "rule_not_activated":
      return "A regra ainda não tem o envio ativo registrado";
    default:
      return "A regra ainda permanece em observação";
  }
}
