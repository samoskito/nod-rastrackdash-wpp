import { createHmac } from "node:crypto";
import type { GraphLead } from "./meta-leadgen";

type Env = Record<string, string | undefined>;
type Fetcher = typeof fetch;

const LEAD_FIELDS =
  "id,created_time,field_data,campaign_id,adset_id,ad_id,form_id";

export class MetaLeadFormGraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "MetaLeadFormGraphError";
  }
}

/**
 * Graph calls of the instant-form flow (Dashboard Leads lib/meta/graph.ts).
 * appsecret_proof goes along when META_APP_SECRET is set: the Graph token is a
 * System User token of the same app that receives the webhooks.
 */
export class MetaLeadFormGraphClient {
  constructor(
    private readonly env: Env = process.env,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  fetchLead(leadgenId: string, token: string): Promise<GraphLead> {
    return this.call<GraphLead>("GET", `/${encodeURIComponent(leadgenId)}`, token, {
      fields: LEAD_FIELDS,
    });
  }

  /**
   * Subscribes the app to the Page "leadgen" field. Needs a Page token, read
   * with the System User token (pages_manage_metadata).
   */
  async subscribePage(pageId: string, token: string): Promise<void> {
    const page = await this.call<{ access_token?: string }>(
      "GET",
      `/${encodeURIComponent(pageId)}`,
      token,
      { fields: "access_token" },
    );

    if (!page.access_token) {
      throw new MetaLeadFormGraphError(
        "O token não tem acesso de administrador a esta Página",
        403,
      );
    }

    const result = await this.call<{ success?: boolean }>(
      "POST",
      `/${encodeURIComponent(pageId)}/subscribed_apps`,
      page.access_token,
      { subscribed_fields: "leadgen" },
    );

    if (result.success !== true) {
      throw new MetaLeadFormGraphError("A Meta não confirmou a assinatura", 502);
    }
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    token: string,
    params: Record<string, string>,
  ): Promise<T> {
    const version = this.env.META_GRAPH_API_VERSION ?? "v21.0";
    const url = new URL(`https://graph.facebook.com/${version}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const appSecret = this.env.META_APP_SECRET;
    if (appSecret) {
      url.searchParams.set(
        "appsecret_proof",
        createHmac("sha256", appSecret).update(token).digest("hex"),
      );
    }

    const response = await this.fetcher(url.toString(), {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await response.json().catch(() => ({}))) as T & {
      error?: { message?: string; code?: number };
    };

    if (!response.ok || body.error) {
      throw new MetaLeadFormGraphError(
        body.error?.message ?? `Graph API HTTP ${response.status}`,
        response.status,
        body.error?.code,
      );
    }

    return body;
  }
}

/**
 * What a failed lead read means for the webhook answer:
 *  - transient: network, timeout, Graph 5xx or usage limits (4, 17, 32, 613,
 *    80001-80014, and 1/2/341 that Meta marks as temporary). The webhook
 *    answers 503 so Meta redelivers later.
 *  - reconnect: the token/session died (190, 102). Redelivering cannot fix it.
 *  - permission: the token lacks a permission (10, 200-299).
 *  - permanent: any other Graph refusal (e.g. 100, lead no longer readable).
 * Only "transient" asks Meta to redeliver. Answering 503 to a permanent error
 * makes Meta retry for hours and may disable the app subscription that feeds
 * the whole /webhooks/meta.
 */
export type LeadFetchFailureKind =
  | "transient"
  | "reconnect"
  | "permission"
  | "permanent";

const TRANSIENT_GRAPH_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

export function leadFetchFailureKind(error: unknown): LeadFetchFailureKind {
  if (!(error instanceof MetaLeadFormGraphError)) return "transient";
  const code = error.code;
  if (code === 190 || code === 102) return "reconnect";
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299))
    return "permission";
  if (
    code !== undefined &&
    (TRANSIENT_GRAPH_CODES.has(code) || (code >= 80001 && code <= 80014))
  )
    return "transient";
  if (error.status >= 500 || error.status === 429) return "transient";
  return "permanent";
}

/** fetchError of a stored failure: "[kind] message". */
export function leadFetchErrorText(
  kind: LeadFetchFailureKind,
  message: string,
): string {
  return `[${kind}] ${message}`.slice(0, 300);
}

/** Kind recorded in a stored fetchError ("[kind] ..."), when there is one. */
export function storedLeadFetchFailureKind(
  fetchError: string | null | undefined,
): LeadFetchFailureKind | null {
  const match = /^\[(transient|reconnect|permission|permanent)\]/u.exec(
    fetchError ?? "",
  );
  return match ? (match[1] as LeadFetchFailureKind) : null;
}
