import type { InboundWebhookParserReleaseDto } from "@wpptrack/shared";

/** Backoffice "Leitores de webhook" (fase 6.5): textos puros, testados direto. */
export const parserProviderLabels: Record<
  InboundWebhookParserReleaseDto["provider"],
  string
> = {
  umbler: "Umbler Talk",
  gupshup: "Gupshup",
  uazapi: "Uazapi",
  meta_cloud: "WhatsApp Cloud API (Meta)",
  data_crazy: "DataCrazy",
  payt: "Payt",
  unnichat: "Unnichat",
  waha: "WAHA",
  braip: "Braip",
  roichat: "ROI Chat",
};

/** Texto do estado de um leitor (sem jargão de certificação). */
export function parserStatusLabel(
  status: InboundWebhookParserReleaseDto["status"],
): { label: string; tone: "good" | "neutral" | "bad" } {
  switch (status) {
    case "certified":
      return { label: "Em uso", tone: "good" };
    case "retired":
      return { label: "Retirado", tone: "bad" };
    default:
      return { label: "Não usado para envio", tone: "neutral" };
  }
}

