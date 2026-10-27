import type {
  BackofficeIntegrationEventDto,
  BackofficeIntegrationEventStatusFilterDto,
  IntegrationEndpointProviderDto,
} from "@wpptrack/shared";
import {
  backofficeIntegrationEventStatusFilters,
  conversionEventNameSchema,
  integrationEndpointProviders,
} from "@wpptrack/shared";
import {
  eventLabel,
  singleUrlPlatformNames,
} from "../../../../(app)/integrations/single-url/single-url-copy";

/**
 * Backoffice "Recebimentos das URLs únicas" (porte do SaaS #170, fase 6.5):
 * textos e decisões puras (sem React), testados direto. Só leitura: nada
 * aqui libera, certifica ou muda o envio.
 */

export const integrationEventsPath =
  "/backoffice/inbound-webhooks/integration-events";

export const integrationEventsTitle = "Recebimentos das URLs únicas";

export const statusFilterLabels: Record<
  BackofficeIntegrationEventStatusFilterDto,
  string
> = {
  all: "Todos",
  routed: "Com regra",
  unattributed: "Sem atribuição",
  pending: "Pendente",
  ignored: "Ignorado",
  invalid: "Inválido",
  rejected: "Recusado (erro HTTP)",
  duplicate: "Duplicado (reenvio)",
};

export const statusFilterOptions = backofficeIntegrationEventStatusFilters.map(
  (value) => ({ value, label: statusFilterLabels[value] }),
);

export const providerOptions = integrationEndpointProviders.map((value) => ({
  value,
  label: singleUrlPlatformNames[value],
}));

/** Eventos mapeados que as URLs únicas/por evento produzem. */
export const mappedEventOptions = [
  "Purchase",
  "InitiateCheckout",
  "CartAbandoned",
  "QualifiedLead",
  "AddToCart",
  "ViewContent",
].map((value) => ({ value, label: eventLabel(value) }));

export function statusChip(
  item: Pick<BackofficeIntegrationEventDto, "status">,
): {
  label: string;
  tone: "good" | "warn" | "bad" | "neutral";
} {
  switch (item.status) {
    case "routed":
      return { label: "Com regra", tone: "good" };
    case "unattributed":
      return { label: "Sem atribuição", tone: "warn" };
    case "pending":
      return { label: "Pendente", tone: "warn" };
    case "ignored":
      return { label: "Ignorado", tone: "neutral" };
    case "invalid":
      return { label: "Inválido", tone: "bad" };
    case "rejected":
      return { label: "Recusado", tone: "bad" };
  }
}

/** "Compra aprovada", "Boleto/Pix gerado"... or "—". */
export function mappedEventLabel(
  provider: IntegrationEndpointProviderDto,
  eventName: string | null,
): string {
  if (!eventName) return "—";
  return eventLabel(eventName, provider);
}

/** "Pagamento Aprovado" (the receipt keeps it lowercase). */
export function providerStatusLabel(value: string | null): string {
  if (!value) return "—";
  return value.replace(
    /(^|\s)(\p{L})/gu,
    (_match, space: string, letter: string) =>
      `${space}${letter.toUpperCase()}`,
  );
}

export type IntegrationEventsFilters = {
  workspace?: string;
  provider?: string;
  status?: string;
  eventName?: string;
  from?: string;
  to?: string;
  cursor?: string;
};

function first(value: string | string[] | undefined): string | undefined {
  const resolved = Array.isArray(value) ? value[0] : value;
  return resolved?.trim() || undefined;
}

/** Only known values reach the API (the API validates again). */
export function readFilters(
  searchParams: Record<string, string | string[] | undefined>,
): IntegrationEventsFilters {
  const provider = first(searchParams.provider);
  const status = first(searchParams.status);
  const eventName = first(searchParams.eventName);
  const day = (value: string | undefined) =>
    value && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : undefined;
  const cursor = first(searchParams.cursor);
  return {
    workspace: first(searchParams.workspace)?.slice(0, 120),
    provider: (integrationEndpointProviders as readonly string[]).includes(
      provider ?? "",
    )
      ? provider
      : undefined,
    status:
      status &&
      status !== "all" &&
      (backofficeIntegrationEventStatusFilters as readonly string[]).includes(
        status,
      )
        ? status
        : undefined,
    eventName: conversionEventNameSchema.safeParse(eventName).success
      ? eventName
      : undefined,
    from: day(first(searchParams.from)),
    to: day(first(searchParams.to)),
    cursor:
      cursor && /^[A-Za-z0-9_-]{1,200}$/u.test(cursor) ? cursor : undefined,
  };
}

export function filterParams(
  filters: IntegrationEventsFilters,
  options: { cursor?: string | null } = {},
): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of [
    "workspace",
    "provider",
    "status",
    "eventName",
    "from",
    "to",
  ] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  if (options.cursor) params.set("cursor", options.cursor);
  return params;
}

export function pageHref(
  filters: IntegrationEventsFilters,
  cursor?: string | null,
): string {
  const query = filterParams(filters, { cursor }).toString();
  return `${integrationEventsPath}${query ? `?${query}` : ""}`;
}
