import { ConflictException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type {
  ProviderConversionRulePendingNumberDto,
  ProviderConversionRulePendingNumberReasonDto,
} from "@wpptrack/shared";
import { metaRouteRequiredForProvider } from "../inbound-webhooks/inbound-webhook-production-activation";
import { isBridgedWhatsappProvider } from "../inbound-webhooks/bridged-whatsapp-providers";

/**
 * "Todos os números" x production gates (porte do incidente de 19/10/2026 do
 * SaaS).
 *
 * A global rule is evaluated against the live state of each number it covers:
 * the number's connection must be in production and its channel active
 * (`connection_not_production` / `channel_not_active` otherwise). A specific
 * rule promotes its numbers when "Envio ativo" is turned on; a global rule used
 * to promote nothing, so every QR-code number stayed in observation and every
 * decision was blocked.
 *
 * Edição do aluno: there is no seat, package or charge per number here (the
 * SaaS promotes only numbers with a paid seat). The equivalent conditions are:
 *  - the installation license must be usable: every HTTP write already
 *    answers 423 while it is locked (LicenseSoftlockGuard) and the automatic
 *    activation skips its run while it is locked;
 *  - a UAZAPI/NOD (QR) number is promoted only while its WhatsApp connection
 *    (WhatsappInstance) is `active`, i.e. not suspended/removed in
 *    Integrações (this edition only writes `active` and `suspended`; any
 *    other legacy status is treated as not active, fail-closed). A suspended
 *    connection is already out of the rule scope; one suspended in between is
 *    reported as `whatsapp_connection_inactive`. The QR session itself
 *    (connected or not) is NOT checked: it only shows in the health check
 *    (`lastHealthStatus`), which may be stale, so it never blocks here;
 *  - a paused connection is never resumed here (reason connection_paused);
 *  - the Meta route rules of the Integrations buttons still apply.
 * Everything else is returned as a pending number with a reason code.
 */

export const pendingReasonActivatable: ReadonlySet<ProviderConversionRulePendingNumberReasonDto> =
  new Set(["channel_not_active", "connection_not_production"]);

/** Audit of each automatic (system) activation attempt. */
export const GLOBAL_AUTO_ACTIVATED_ACTION =
  "provider_conversion_rule.global_number_auto_activated";
/**
 * Operator decisions on a connection/channel. Any of them means the number
 * was already live or deliberately held back: automatic activation never
 * touches it (manual save / button keep their behavior).
 */
export const OPERATOR_CONNECTION_ACTIONS = [
  "inbound_webhook.connection_promoted",
  "inbound_webhook.connection_observation",
  "inbound_webhook.connection_paused",
] as const;
export const OPERATOR_CHANNEL_ACTIONS = [
  "inbound_webhook.channel_activated",
  "inbound_webhook.channel_paused",
] as const;
/** A failed automatic attempt is not retried for this long (unless a new event). */
export const GLOBAL_AUTO_ACTIVATION_BACKOFF_MS = 6 * 60 * 60 * 1_000;

/** Bound of numbers promoted per rule write (each in its own transaction). */
export const GLOBAL_RULE_CASCADE_LIMIT = 50;

export function pendingChannelSelect() {
  return {
    id: true,
    connectionId: true,
    status: true,
    channelName: true,
    connectedPhone: true,
    whatsappInstanceId: true,
    connection: {
      select: { id: true, provider: true, status: true, removedAt: true },
    },
    routes: {
      where: { active: true },
      select: { validationStatus: true, metaBusinessConnectionId: true },
    },
    whatsappInstance: {
      select: { status: true },
    },
  } satisfies Prisma.InboundWebhookChannelSelect;
}

export type PendingChannelRow = Prisma.InboundWebhookChannelGetPayload<{
  select: ReturnType<typeof pendingChannelSelect>;
}>;

/**
 * Whether the number's own WhatsApp connection allows sending. Only bridged
 * numbers (Uazapi and WAHA bridges) carry a WhatsappInstance: it must be `active`
 * (not suspended/removed). The QR session health is deliberately ignored. Webhook providers (Umbler,
 * Gupshup, Unnichat...) have no instance and are always connectable.
 */
export function channelConnectable(
  channel: Pick<PendingChannelRow, "whatsappInstance"> & {
    connection: { provider: string };
  },
): boolean {
  if (!isBridgedWhatsappProvider(channel.connection.provider)) return true;
  return channel.whatsappInstance?.status === "active";
}

function hasValidMetaRoute(channel: Pick<PendingChannelRow, "routes">): boolean {
  return (channel.routes ?? []).some(
    (route) =>
      route.validationStatus === "valid" &&
      Boolean(route.metaBusinessConnectionId?.trim()),
  );
}

export type GateConnection = {
  id: string;
  provider: string;
  status: string;
};

/**
 * Pending state of one covered number, from read-only data. `siblings` are
 * the other ACTIVE channels of the gate connection: promoting a connection
 * demands a Meta route for every one of them, so a single sibling without a
 * route keeps the number pending as well.
 */
export function pendingNumberState(input: {
  channel: PendingChannelRow;
  gate: GateConnection;
  siblings: PendingChannelRow[];
}): ProviderConversionRulePendingNumberDto | null {
  const { channel, gate } = input;
  const channelLive = channel.status === "active";
  const gateLive = gate.status === "production";
  if (channelLive && gateLive) return null;

  const promotionSet = gateLive
    ? [channel]
    : [
        channel,
        ...input.siblings.filter(
          (sibling) =>
            sibling.id !== channel.id &&
            sibling.status === "active" &&
            sibling.connectionId === gate.id,
        ),
      ];
  const routeRequired =
    metaRouteRequiredForProvider(gate.provider) &&
    // Unnichat resolves its route through the workspace policy; the
    // activation itself reports it when missing.
    gate.provider !== "unnichat" &&
    channel.connection.provider !== "unnichat";

  let reason: ProviderConversionRulePendingNumberReasonDto;
  if (gate.status === "paused") {
    // Someone paused the connection: only Integrações resumes it.
    reason = "connection_paused";
  } else if (!channelConnectable(channel)) {
    reason = "whatsapp_connection_inactive";
  } else if (
    routeRequired &&
    !promotionSet.every((row) => hasValidMetaRoute(row))
  ) {
    reason = "meta_route_missing";
  } else if (!channelLive) {
    reason = "channel_not_active";
  } else {
    reason = "connection_not_production";
  }

  // A QR instance carries a placeholder (instance id) as connected phone
  // until its first connection test; never show that as a phone.
  const phone =
    isBridgedWhatsappProvider(channel.connection.provider) &&
    !/^\+?\d{8,15}$/u.test((channel.connectedPhone ?? "").trim())
      ? null
      : channel.connectedPhone;

  return {
    channelId: channel.id,
    connectionId: gate.id,
    provider: channel.connection.provider,
    label: channel.channelName?.trim().slice(0, 160) || null,
    phone: phone?.trim().slice(0, 40) || null,
    reason,
    channelStatus: channel.status,
    connectionStatus:
      gate.status as ProviderConversionRulePendingNumberDto["connectionStatus"],
    activatable: pendingReasonActivatable.has(reason),
  };
}

/**
 * Meta-route refusals of the Integrations activation (they carry no code in
 * this edition, only the message the buttons show).
 */
function isMetaRouteConflict(error: ConflictException): boolean {
  const response = error.getResponse();
  const code =
    response && typeof response === "object" && "code" in response
      ? (response as { code?: unknown }).code
      : null;
  if (
    code === "channel_meta_route_required" ||
    code === "connection_meta_route_required"
  ) {
    return true;
  }
  return /rota meta|configure a meta/iu.test(error.message);
}

/** Reason recorded for a number whose activation attempt failed. */
export function pendingReasonFromError(
  error: unknown,
  fallback: ProviderConversionRulePendingNumberReasonDto,
): ProviderConversionRulePendingNumberReasonDto {
  if (error instanceof ConflictException && isMetaRouteConflict(error)) {
    return "meta_route_missing";
  }
  return fallback;
}

/** Short technical code of a failed activation, for the audit trail only. */
export function activationErrorCode(error: unknown): string {
  if (error instanceof ConflictException) {
    const response = error.getResponse();
    if (response && typeof response === "object" && "code" in response) {
      const code = (response as { code?: unknown }).code;
      if (typeof code === "string") return code.slice(0, 80);
    }
    return isMetaRouteConflict(error) ? "meta_route_required" : "conflict";
  }
  return error instanceof Error ? error.name.slice(0, 80) : "unknown";
}
