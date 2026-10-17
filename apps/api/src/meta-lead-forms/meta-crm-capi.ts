import { createHash } from "node:crypto";
import { isMetaLeadId } from "./meta-leadgen";

// Conversions API for CRM (Dashboard Leads lib/meta/capi.ts, source lead_form):
// tells Meta the funnel stage reached by an instant-form lead, matched by
// user_data.lead_id. A separate integration from the WhatsApp messaging pixel.

export const LEAD_EVENT_SOURCE = "RastrackDash";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Meta accepts CRM events for leads up to 28 days old. */
export const META_CRM_WINDOW_DAYS = 28;
/** Meta rejects event_time older than 7 days; 6 keeps a margin. */
const MAX_EVENT_AGE_MS = 6 * DAY_MS;
/** Meta already receives the lead itself: these would double count it. */
export const FORBIDDEN_CRM_EVENTS = new Set(["Lead", "LeadSubmitted"]);

export type CrmEventLead = {
  metaLeadId: string;
  email: string | null;
  phone: string | null;
  createdAt: Date;
};

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function normalizeEmail(email: string | null | undefined): string | null {
  const value = (email ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

export function normalizePhoneDigits(
  phone: string | null | undefined,
): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

/** Portuguese reason why the event cannot be sent, or null. */
export function crmIneligibility(
  input: {
    metaLeadId: string | null;
    createdAt: Date | null;
    datasetId: string | null;
    eventName: string;
  },
  now: Date = new Date(),
): string | null {
  if (!input.datasetId) return "Conexao sem dataset do CRM configurado";
  if (FORBIDDEN_CRM_EVENTS.has(input.eventName))
    return `O evento "${input.eventName}" nao pode ser enviado (a Meta ja recebe o lead)`;
  if (!isMetaLeadId(input.metaLeadId)) return "ID do lead da Meta invalido";
  if (!input.createdAt || Number.isNaN(input.createdAt.getTime()))
    return "Data de criacao do lead desconhecida";
  if (now.getTime() - input.createdAt.getTime() > META_CRM_WINDOW_DAYS * DAY_MS)
    return `Lead com mais de ${META_CRM_WINDOW_DAYS} dias: fora da janela da Meta`;
  return null;
}

/** The qualification moment; a late (re)send past Meta's limit uses now. */
export function crmEventTime(qualifiedAt: Date, now: Date = new Date()): number {
  const at = qualifiedAt.getTime();
  const ts =
    !Number.isNaN(at) && now.getTime() - at <= MAX_EVENT_AGE_MS && at <= now.getTime()
      ? at
      : now.getTime();
  return Math.floor(ts / 1000);
}

/**
 * JSON body. lead_id goes as a number literal: 16-17 digit ids exceed the
 * JavaScript safe integer, so they cannot become a Number.
 */
export function buildCrmEventBody(input: {
  lead: CrmEventLead;
  eventName: string;
  eventId: string;
  qualifiedAt: Date;
  now?: Date;
  testEventCode?: string | null;
}): string {
  if (!isMetaLeadId(input.lead.metaLeadId)) {
    throw new Error("meta_lead_id invalido");
  }

  const email = normalizeEmail(input.lead.email);
  const phone = normalizePhoneDigits(input.lead.phone);
  const hashed: Record<string, unknown> = {};
  if (email) hashed.em = [sha256(email)];
  if (phone) hashed.ph = [sha256(phone)];

  const payload: Record<string, unknown> = {
    data: [
      {
        event_name: input.eventName,
        event_time: crmEventTime(input.qualifiedAt, input.now),
        action_source: "system_generated",
        event_id: input.eventId,
        user_data: { lead_id: "__LEAD_ID__", ...hashed },
        custom_data: {
          event_source: "crm",
          lead_event_source: LEAD_EVENT_SOURCE,
        },
      },
    ],
  };
  if (input.testEventCode) payload.test_event_code = input.testEventCode;

  return JSON.stringify(payload).replace(
    '"__LEAD_ID__"',
    input.lead.metaLeadId,
  );
}

export type CrmSendResult = {
  status: "sent" | "error";
  /** Body as sent, with the hashes; never the token. */
  requestPayload: unknown;
  responseSummary: Record<string, unknown> | null;
  errorCode: "MetaCapiRejected" | "MetaCapiNetworkError" | "MetaCapiDeliveryUnknown" | null;
  errorMessage: string | null;
};

/**
 * POST /{dataset}/events. Without appsecret_proof: the CRM token is usually
 * generated inside the dataset (Events Manager), outside the app.
 */
export async function postCrmEvent(input: {
  datasetId: string;
  token: string;
  body: string;
  version: string;
  fetcher?: typeof fetch;
}): Promise<CrmSendResult> {
  const fetcher = input.fetcher ?? fetch;
  const url = `https://graph.facebook.com/${input.version}/${encodeURIComponent(input.datasetId)}/events`;
  const requestPayload = JSON.parse(input.body) as unknown;
  let response: Response;

  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
      },
      body: input.body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return {
      status: "error",
      requestPayload,
      responseSummary: null,
      errorCode: "MetaCapiNetworkError",
      errorMessage: "Falha de comunicacao com a Meta",
    };
  }

  const json = (await response.json().catch(() => null)) as {
    events_received?: unknown;
    fbtrace_id?: unknown;
    error?: { message?: string; error_user_msg?: string; code?: number; fbtrace_id?: string };
  } | null;
  const fbtraceId =
    typeof json?.fbtrace_id === "string"
      ? json.fbtrace_id
      : (json?.error?.fbtrace_id ?? null);

  if (!response.ok || json?.error) {
    const detail =
      json?.error?.error_user_msg || json?.error?.message || `HTTP ${response.status}`;
    return {
      status: "error",
      requestPayload,
      responseSummary: { httpStatus: response.status, fbtraceId },
      errorCode: "MetaCapiRejected",
      errorMessage: `A Meta recusou o evento${json?.error?.code ? ` (codigo ${json.error.code})` : ""}: ${detail}`.slice(0, 500),
    };
  }

  if (json?.events_received !== 1) {
    return {
      status: "error",
      requestPayload,
      responseSummary: { httpStatus: response.status, fbtraceId },
      errorCode: "MetaCapiDeliveryUnknown",
      errorMessage: "A Meta nao confirmou o recebimento do evento",
    };
  }

  return {
    status: "sent",
    requestPayload,
    responseSummary: { events_received: 1, fbtraceId },
    errorCode: null,
    errorMessage: null,
  };
}
