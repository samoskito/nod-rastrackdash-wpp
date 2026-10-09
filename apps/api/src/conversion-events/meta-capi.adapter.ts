import type {
  ConversionEventCustomDataDto,
  ConversionEventNameDto
} from "@wpptrack/shared";
import {
  buildMetaCapiPayload,
  type MetaCapiPayload
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
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export type MetaCapiSendEventErrorCode =
  | "MissingMetaDestination"
  | "MissingAccessToken"
  | "MissingPhoneHash"
  | "MissingCtwaClid"
  | "MissingAdId"
  | "MetaCapiRejected"
  | "MetaCapiNetworkError"
  | "MetaCapiDeliveryUnknown"
  | null;

export type MetaCapiSendEventInput = {
  accessToken?: string | null;
  pixelId: string | null;
  pageId: string | null;
  eventName: ConversionEventNameDto;
  dedupeKey: string;
  phoneHash: string | null;
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

export class MetaCapiAdapter {
  constructor(
    private readonly env: MetaCapiEnv = process.env,
    private readonly fetcher: Fetcher = fetch
  ) {}

  async sendEvent(
    input: MetaCapiSendEventInput,
    dispatch: DispatchOptions = {},
  ): Promise<MetaCapiSendEventResult> {
    const accessToken =
      input.accessToken?.trim() || this.env.META_CAPI_ACCESS_TOKEN?.trim();
    const pixelId = input.pixelId?.trim() ?? null;
    const pageId = input.pageId?.trim() ?? null;
    const phoneHash = input.phoneHash?.trim() ?? null;
    const ctwaClid = input.ctwaClid?.trim() ?? null;
    const adId = input.adId?.trim() ?? null;

    if (!accessToken) {
      return this.notConfigured(
        "MissingAccessToken",
        "Meta CAPI access token not configured"
      );
    }

    if (!pixelId || !pageId) {
      return this.notConfigured(
        "MissingMetaDestination",
        "Meta CAPI pixel id or page id not configured"
      );
    }

    if (!phoneHash) {
      return this.notConfigured(
        "MissingPhoneHash",
        "Meta CAPI phone hash not available"
      );
    }

    if (!ctwaClid) {
      return this.notConfigured(
        "MissingCtwaClid",
        "Meta CAPI ctwa_clid not available"
      );
    }

    if (!adId) {
      return this.notConfigured("MissingAdId", "Meta CAPI ad id not available");
    }

    const version = this.env.META_GRAPH_API_VERSION ?? "v21.0";
    const url = new URL(
      `https://graph.facebook.com/${version}/${pixelId}/events`
    );
    url.searchParams.set("access_token", accessToken);
    const requestPayload = buildMetaCapiPayload({
      eventName: input.eventName,
      eventTime: input.eventTime ?? new Date(),
      eventId: input.dedupeKey,
      phoneHash,
      ctwaClid,
      pageId,
      adId,
      valueCents: input.valueCents ?? null,
      currency: input.currency ?? null,
      contentName: input.contentName ?? null,
      customData: input.customData ?? null,
      testEventCode: input.testEventCode ?? null
    });

    let response: Response;
    let payload: Record<string, unknown>;
    try {
      const request: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestPayload),
        ...(dispatch.signal ? { signal: dispatch.signal } : {})
      };
      dispatch.signal?.throwIfAborted();
      dispatch.beforeDispatch?.();
      response = await bounded(this.fetcher(url.toString(), request), dispatch.signal);
      payload = await bounded(response.json().catch(() => ({})), dispatch.signal);
    } catch {
      return {
        status: "error",
        requestPayload,
        responseSummary: null,
        errorMessage: "Meta CAPI network request failed",
        errorCode: "MetaCapiNetworkError",
        deliveryOutcome: "unknown"
      };
    }

    if (!response.ok) {
      return {
        status: "error",
        requestPayload,
        responseSummary: payload,
        errorMessage: "Meta CAPI request failed",
        errorCode: "MetaCapiRejected"
      };
    }

    return {
      status: "sent",
      requestPayload,
      responseSummary: payload,
      errorMessage: null,
      errorCode: null
    };
  }

  private notConfigured(
    errorCode: Exclude<
      MetaCapiSendEventErrorCode,
      "MetaCapiRejected" | "MetaCapiNetworkError" | "MetaCapiDeliveryUnknown" | null
    >,
    errorMessage: string
  ): MetaCapiSendEventResult {
    return {
      status: "not_configured",
      requestPayload: null,
      responseSummary: null,
      errorMessage,
      errorCode
    };
  }
}
