import {
  normalizeCurrencyCode,
  type ConversionEventCustomDataDto,
  type ConversionEventNameDto,
} from "@wpptrack/shared";
import type { AuthorizedPagePixelCtwaDestination } from "../inbound-webhooks/authorized-ctwa-destination";
import { isMetaAuthFailureResponse } from "./conversion-event-retry";
import { metaCapiFirstNameHash } from "./meta-capi-first-name";
import { pickMetaCapiRejectionError } from "./meta-capi-rejection";
import {
  buildMetaCapiPayload,
  type MetaCapiPayload,
} from "./meta-capi-payload.builder";

type MetaCapiEnv = Record<string, string | undefined>;
type Fetcher = typeof fetch;

type DispatchOptions = {
  beforeDispatch?: () => void;
  signal?: AbortSignal;
};

function bounded<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("meta_dispatch_deadline"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export type MetaCapiSendEventErrorCode =
  | "MissingMetaDestination"
  | "MissingAccessToken"
  | "MissingPhoneHash"
  | "MissingCtwaClid"
  | "MissingAdId"
  | "MetaEventTimeExpired"
  | "UnsupportedCurrency"
  | "MetaCapiRejected"
  | "MetaCapiNetworkError"
  | "MetaCapiDeliveryUnknown"
  | null;

export type MetaCapiSendEventInput = {
  /**
   * CTWA lead with ctwa_clid and no known ad: the authorized page/pixel. The
   * ad id becomes optional (only an optional hint); ctwa_clid stays mandatory.
   */
  pagePixelDestination?: AuthorizedPagePixelCtwaDestination;
  accessToken?: string | null;
  pixelId: string | null;
  pageId: string | null;
  eventName: ConversionEventNameDto;
  dedupeKey: string;
  phoneHash: string | null;
  /** Raw lead name; only its normalized, hashed first name is ever sent. */
  leadName?: string | null;
  adId: string | null;
  ctwaClid: string | null;
  valueCents?: number | null;
  currency?: string | null;
  contentName?: string | null;
  customData?: ConversionEventCustomDataDto | null;
  eventTime?: Date | null;
  testEventCode?: string | null;
};

export type MetaCapiSendEventResult = {
  status: "not_configured" | "sent" | "error";
  requestPayload: MetaCapiPayload | null;
  responseSummary: Record<string, unknown> | null;
  errorMessage: string | null;
  errorCode: MetaCapiSendEventErrorCode;
  deliveryOutcome?: "unknown";
};

/**
 * Graph codes that fail every event of a batch the same way (dead token or
 * throttling): resending one by one would only spend the app limit again.
 */
const BATCH_WIDE_REJECTION_CODES = new Set([
  102, 190, 4, 17, 32, 341, 613, 80000, 80001, 80002, 80003, 80004, 80005,
  80006, 80008, 80009, 80014,
]);
/**
 * Usage limits (app/account/ads throttling): Meta did not take the events and
 * will after a pause. In the batch path they become retryable (the queue
 * retries the job with backoff; Meta dedupes by event_id) instead of a final
 * MetaCapiRejected.
 */
const RATE_LIMIT_CODES = new Set([
  4, 17, 32, 341, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008,
  80009, 80014,
]);
/** The batch POST never hangs a whole group of jobs (like a single POST). */
const BATCH_REQUEST_TIMEOUT_MS = 30_000;

function graphErrorCode(summary: Record<string, unknown> | null): number | null {
  const error = summary?.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" && Number.isInteger(code) ? code : null;
}

/**
 * Batch path and the default single POST (1.3.1): a usage-limit refusal is
 * resent later. errorCode
 * MetaCapiNetworkError is the retryable class of the queue processor (the
 * job throws and BullMQ retries); the stored response keeps the Graph code,
 * and the message says it was a usage limit.
 */
export function retryableRateLimit(
  result: MetaCapiSendEventResult,
): MetaCapiSendEventResult {
  const code = graphErrorCode(result.responseSummary);
  if (
    result.status !== "error" ||
    result.errorCode !== "MetaCapiRejected" ||
    code === null ||
    !RATE_LIMIT_CODES.has(code)
  )
    return result;
  return {
    ...result,
    errorCode: "MetaCapiNetworkError",
    errorMessage: `Meta CAPI usage limit (code ${code}): will retry`,
  };
}

/** Parallel single POSTs when a batch must be resent one by one. */
const BATCH_FALLBACK_CONCURRENCY = 4;

type BatchItem = {
  url: string;
  requestPayload: MetaCapiPayload;
  ctwaDestination: boolean;
  resolve: (result: MetaCapiSendEventResult) => void;
};

export class MetaCapiAdapter {
  private readonly batchGroups = new Map<
    string,
    { items: BatchItem[]; timer: ReturnType<typeof setTimeout> | null }
  >();

  constructor(
    private readonly env: MetaCapiEnv = process.env,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async sendEvent(
    input: MetaCapiSendEventInput,
    dispatch: DispatchOptions = {},
  ): Promise<MetaCapiSendEventResult> {
    // The CTWA page/pixel path only uses the token resolved for its business
    // connection, never the environment fallback token.
    const accessToken = (
      input.accessToken === undefined && !input.pagePixelDestination
        ? this.env.META_CAPI_ACCESS_TOKEN
        : input.accessToken
    )?.trim();
    const pixelId = input.pixelId?.trim() ?? null;
    const pageId = input.pageId?.trim() ?? null;
    const phoneHash = input.phoneHash?.trim() ?? null;
    const ctwaClid = input.ctwaClid?.trim() ?? null;
    const adId = input.adId?.trim() ?? null;

    const rejected = preflightMetaCapiEvent({ ...input, accessToken });
    if (rejected) return rejected;

    const version = this.env.META_GRAPH_API_VERSION ?? "v21.0";
    const url = new URL(
      `https://graph.facebook.com/${version}/${pixelId}/events`,
    );
    url.searchParams.set("access_token", accessToken!);
    const requestPayload = buildMetaCapiPayload({
      eventName: input.eventName,
      eventTime: input.eventTime ?? new Date(),
      eventId: input.dedupeKey,
      phoneHash: phoneHash!,
      firstNameHash: metaCapiFirstNameHash(input.leadName, this.env),
      ctwaClid: ctwaClid!,
      pageId: pageId!,
      adId: adId || null,
      valueCents: input.valueCents ?? null,
      currency: input.currency ?? null,
      contentName: input.contentName ?? null,
      customData: input.customData ?? null,
      testEventCode: input.testEventCode ?? null,
    });
    const ctwaDestination = Boolean(input.pagePixelDestination);

    // Dispatches with a deadline/signal or a lease (Kommo, Pipedrive, the
    // inbound rules and the CTWA page/pixel path) own an exactly-once guard
    // around the single POST: never batch those.
    if (
      this.batchingEnabled() &&
      !dispatch.signal &&
      !dispatch.beforeDispatch
    ) {
      return this.enqueueBatched({
        url: url.toString(),
        requestPayload,
        ctwaDestination,
      });
    }

    // Envio unitário padrão (fila de conversões, sem trava de envio único):
    // limite de uso volta para a fila, como no lote (1.3.1). Os envios com
    // trava (Kommo, Pipedrive, regras de entrada, CTWA) não reenviam sozinhos:
    // para eles continua MetaCapiRejected.
    if (!dispatch.signal && !dispatch.beforeDispatch) {
      return retryableRateLimit(
        await this.postEvents(url.toString(), requestPayload, ctwaDestination),
      );
    }

    return this.postEvents(
      url.toString(),
      requestPayload,
      ctwaDestination,
      dispatch,
    );
  }

  /** One POST /{pixel}/events for one event (original behavior). */
  private async postEvents(
    requestUrl: string,
    requestPayload: MetaCapiPayload,
    ctwaDestination: boolean,
    dispatch: DispatchOptions = {},
  ): Promise<MetaCapiSendEventResult> {
    let response: Response | undefined;
    let payload: unknown;
    let dispatched = false;
    try {
      const request: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestPayload),
        ...(dispatch.signal ? { signal: dispatch.signal } : {}),
      };
      dispatch.signal?.throwIfAborted();
      dispatch.beforeDispatch?.();
      dispatched = true;
      response = await bounded(
        this.fetcher(requestUrl, request),
        dispatch.signal,
      );
      // A received non-2xx is an explicit rejection even if its body is not JSON.
      if (!response.ok) {
        // nod (#181): keep only code, error_subcode, type and fbtrace_id of the
        // Graph error (never message/error_user_* or other provider text,
        // which may carry PII), so "Reenviar bloqueados" can tell a dead Meta
        // login/token (190/102) apart and the screen can explain the refusal.
        let errorBody: unknown = null;
        try {
          errorBody = await bounded(response.json(), dispatch.signal);
        } catch {
          errorBody = null;
        }
        const graphError = pickMetaCapiRejectionError(errorBody);
        const responseSummary: Record<string, unknown> = {
          httpStatus: response.status,
          ...(graphError ? { error: graphError } : {}),
        };
        return {
          status: "error",
          requestPayload,
          responseSummary,
          // errorCode stays MetaCapiRejected (screens/reports rely on it); the
          // message flags a dead Meta login/token (code 190/102), resendable
          // after reconnecting.
          errorMessage: isMetaAuthFailureResponse(responseSummary)
            ? "Meta CAPI authentication failed (code 190/102): reconnect Meta and resend"
            : "Meta CAPI request failed",
          errorCode: "MetaCapiRejected",
        };
      }
      payload = await bounded(response.json(), dispatch.signal);
    } catch {
      // As in the SaaS: a CTWA page/pixel event whose final authorization
      // (credential expiry/deadline) failed before the POST was never sent.
      if (ctwaDestination && !dispatched)
        return notConfigured(
          "MissingMetaDestination",
          "CTWA authorization unavailable before dispatch",
        );
      return {
        status: "error",
        requestPayload,
        responseSummary: null,
        errorMessage: response?.ok
          ? "Meta CAPI delivery acknowledgement unavailable"
          : "Meta CAPI network request failed",
        errorCode: response?.ok
          ? "MetaCapiDeliveryUnknown"
          : "MetaCapiNetworkError",
        deliveryOutcome: "unknown",
      };
    }

    // This adapter sends exactly one event. HTTP success alone is inconclusive.
    // Meta's EventResponse defines int events_received, list[str] messages and
    // string fbtrace_id. Never persist arbitrary provider bodies/messages (PII).
    const ack =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    if (
      !ack ||
      "error" in ack ||
      !Number.isInteger(ack.events_received) ||
      ack.events_received !== 1 ||
      !Array.isArray(ack.messages) ||
      !ack.messages.every((m) => typeof m === "string") ||
      typeof ack.fbtrace_id !== "string" ||
      !ack.fbtrace_id.trim() ||
      ack.fbtrace_id.length > 256
    ) {
      return {
        status: "error",
        requestPayload,
        responseSummary: {
          httpStatus: response.status,
          acknowledgement: "invalid",
        },
        errorMessage: "Meta CAPI delivery acknowledgement unavailable",
        errorCode: "MetaCapiDeliveryUnknown",
        deliveryOutcome: "unknown",
      };
    }

    return {
      status: "sent",
      requestPayload,
      responseSummary: {
        events_received: 1,
        messageCount: ack.messages.length,
      },
      errorMessage: null,
      errorCode: null,
    };
  }

  private networkError(
    requestPayload: MetaCapiPayload,
  ): MetaCapiSendEventResult {
    return {
      status: "error",
      requestPayload,
      responseSummary: null,
      errorMessage: "Meta CAPI network request failed",
      errorCode: "MetaCapiNetworkError",
      deliveryOutcome: "unknown",
    };
  }

  private batchingEnabled(): boolean {
    return this.env.META_CAPI_BATCH_ENABLED?.trim().toLowerCase() === "true";
  }

  private batchSettings(): { windowMs: number; maxEvents: number } {
    const windowMs = Number.parseInt(
      this.env.META_CAPI_BATCH_WINDOW_MS ?? "",
      10,
    );
    const maxEvents = Number.parseInt(
      this.env.META_CAPI_BATCH_MAX_EVENTS ?? "",
      10,
    );

    return {
      windowMs:
        Number.isFinite(windowMs) && windowMs >= 0
          ? Math.min(windowMs, 5_000)
          : 250,
      // Meta accepts at most 1,000 events per request.
      maxEvents:
        Number.isFinite(maxEvents) && maxEvents > 0
          ? Math.min(maxEvents, 1_000)
          : 1_000,
    };
  }

  /**
   * Micro-batching: events for the same pixel, token and test_event_code
   * that arrive inside the window share one POST. Each caller still receives
   * its own per-event result (status, payload, error), so dedupe/status
   * tracking and BullMQ retries stay per event.
   */
  private enqueueBatched(item: {
    url: string;
    requestPayload: MetaCapiPayload;
    ctwaDestination: boolean;
  }): Promise<MetaCapiSendEventResult> {
    const key = `${item.url}\u0000${item.requestPayload.test_event_code ?? ""}`;
    const { windowMs, maxEvents } = this.batchSettings();

    return new Promise<MetaCapiSendEventResult>((resolve) => {
      let group = this.batchGroups.get(key);

      if (!group) {
        group = { items: [], timer: null };
        this.batchGroups.set(key, group);
      }

      group.items.push({ ...item, resolve });

      if (group.items.length >= maxEvents) {
        void this.flushBatch(key);
      } else if (!group.timer) {
        group.timer = setTimeout(() => void this.flushBatch(key), windowMs);
      }
    });
  }

  /** Sends whatever is pending (also used by tests and shutdown). */
  async flushAllBatches(): Promise<void> {
    await Promise.all(
      [...this.batchGroups.keys()].map((key) => this.flushBatch(key)),
    );
  }

  private async flushBatch(key: string): Promise<void> {
    const group = this.batchGroups.get(key);

    if (!group) {
      return;
    }

    this.batchGroups.delete(key);

    if (group.timer) {
      clearTimeout(group.timer);
    }

    const items = group.items;

    try {
      if (items.length === 1) {
        const [item] = items;
        item.resolve(
          retryableRateLimit(
            await this.postEvents(
              item.url,
              item.requestPayload,
              item.ctwaDestination,
            ),
          ),
        );
        return;
      }

      const testEventCode = items[0].requestPayload.test_event_code;
      const batchPayload: MetaCapiPayload = {
        data: items.flatMap((item) => item.requestPayload.data),
        ...(testEventCode ? { test_event_code: testEventCode } : {}),
      };
      let response: Response;
      let payload: unknown;

      try {
        response = await this.fetcher(items[0].url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batchPayload),
          signal: AbortSignal.timeout(BATCH_REQUEST_TIMEOUT_MS),
        });
        payload = await response.json().catch(() => null);
      } catch {
        // Unknown outcome for every event: same as a single lost POST.
        // BullMQ retries each job; Meta dedupes by event_id.
        items.forEach((item) =>
          item.resolve(this.networkError(item.requestPayload)),
        );
        return;
      }

      // nod: same strict acknowledgement as a single POST (events_received,
      // messages and fbtrace_id) and never persist the provider body (PII).
      const ack =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : null;
      const acknowledged =
        response.ok &&
        ack !== null &&
        !("error" in ack) &&
        ack.events_received === items.length &&
        Array.isArray(ack.messages) &&
        ack.messages.every((message) => typeof message === "string") &&
        typeof ack.fbtrace_id === "string" &&
        Boolean(ack.fbtrace_id.trim()) &&
        ack.fbtrace_id.length <= 256;

      if (acknowledged) {
        const messageCount = (ack.messages as unknown[]).length;

        items.forEach((item) =>
          item.resolve({
            status: "sent",
            requestPayload: item.requestPayload,
            responseSummary: {
              events_received: 1,
              messageCount,
              batch_size: items.length,
            },
            errorMessage: null,
            errorCode: null,
          }),
        );
        return;
      }

      // nod: a dead token (190/102) or a throttle fails every event alike;
      // answer each one with the same rejection instead of 1 POST per event
      // (only code, error_subcode, type and fbtrace_id are kept, as in the
      // single path).
      const graphError = response.ok
        ? null
        : pickMetaCapiRejectionError(payload);
      const graphErrorCode = graphError?.code ?? null;

      if (
        graphErrorCode !== null &&
        BATCH_WIDE_REJECTION_CODES.has(graphErrorCode)
      ) {
        const responseSummary: Record<string, unknown> = {
          httpStatus: response.status,
          error: graphError,
        };

        items.forEach((item) =>
          item.resolve(
            retryableRateLimit({
              status: "error",
              requestPayload: item.requestPayload,
              responseSummary,
              errorMessage: isMetaAuthFailureResponse(responseSummary)
                ? "Meta CAPI authentication failed (code 190/102): reconnect Meta and resend"
                : "Meta CAPI request failed",
              errorCode: "MetaCapiRejected",
            }),
          ),
        );
        return;
      }

      // Meta rejects the whole request when one event is invalid (or did not
      // confirm every event): resend one by one so each event gets its own
      // status. Resending an accepted event is deduplicated by event_id.
      // Bounded concurrency keeps a large batch from holding the jobs long.
      for (
        let offset = 0;
        offset < items.length;
        offset += BATCH_FALLBACK_CONCURRENCY
      ) {
        await Promise.all(
          items
            .slice(offset, offset + BATCH_FALLBACK_CONCURRENCY)
            .map(async (item) =>
              item.resolve(
                retryableRateLimit(
                  await this.postEvents(
                    item.url,
                    item.requestPayload,
                    item.ctwaDestination,
                  ),
                ),
              ),
            ),
        );
      }
    } catch {
      items.forEach((item) =>
        item.resolve(this.networkError(item.requestPayload)),
      );
    }
  }
}

/** A configuration rejection here happens before any provider dispatch. */
export function preflightMetaCapiEvent(
  input: MetaCapiSendEventInput,
): MetaCapiSendEventResult | null {
  const accessToken = input.accessToken?.trim();
  const pixelId = input.pixelId?.trim();
  const pageId = input.pageId?.trim();
  const phoneHash = input.phoneHash?.trim();
  const ctwaClid = input.ctwaClid?.trim();
  const adId = input.adId?.trim();
  if (!accessToken) {
    return notConfigured(
      "MissingAccessToken",
      "Meta CAPI access token not configured",
    );
  }

  const pagePixel = input.pagePixelDestination;
  if (
    pagePixel &&
    (pagePixel.kind !== "authorized_ctwa_destination" ||
      pagePixel.deliveryKind !== "page_pixel" ||
      !pagePixel.pixelId?.trim() ||
      !pagePixel.pageId?.trim() ||
      pagePixel.pixelId !== pixelId ||
      pagePixel.pageId !== pageId)
  )
    return notConfigured(
      "MissingMetaDestination",
      "CTWA page/pixel intent mismatch",
    );
  if (
    pagePixel &&
    (!input.eventTime ||
      !Number.isFinite(input.eventTime.getTime()) ||
      input.eventTime.getTime() > Date.now() ||
      Date.now() - input.eventTime.getTime() > 7 * 86400000)
  )
    return notConfigured(
      "MetaEventTimeExpired",
      "CTWA destination requires a real event time within seven days",
    );

  if (!pixelId || !pageId) {
    return notConfigured(
      "MissingMetaDestination",
      "Meta CAPI pixel id or page id not configured",
    );
  }

  if (!phoneHash) {
    return notConfigured(
      "MissingPhoneHash",
      "Meta CAPI phone hash not available",
    );
  }

  if (!ctwaClid) {
    return notConfigured(
      "MissingCtwaClid",
      "Meta CAPI ctwa_clid not available",
    );
  }

  // ctwa_clid is checked above for every path. Only the authorized CTWA
  // page/pixel path may travel without an ad id.
  if (!adId && !pagePixel) {
    return notConfigured("MissingAdId", "Meta CAPI ad id not available");
  }

  // Só BRL/USD/EUR vão à Meta: valor com moeda fora da lista (evento gravado
  // antes da Fase 5.1) fica bloqueado com motivo, nunca sai com outra moeda.
  const currency = input.currency?.trim();
  if (
    typeof input.valueCents === "number" &&
    currency &&
    !normalizeCurrencyCode(currency)
  ) {
    return notConfigured(
      "UnsupportedCurrency",
      `Moeda ${currency.toUpperCase()} fora de BRL, USD ou EUR: nada foi enviado à Meta`,
    );
  }

  return null;
}

function notConfigured(
  errorCode: Exclude<
    MetaCapiSendEventErrorCode,
    | "MetaCapiRejected"
    | "MetaCapiNetworkError"
    | "MetaCapiDeliveryUnknown"
    | null
  >,
  errorMessage: string,
): MetaCapiSendEventResult {
  return {
    status: "not_configured",
    requestPayload: null,
    responseSummary: null,
    errorMessage,
    errorCode,
  };
}
