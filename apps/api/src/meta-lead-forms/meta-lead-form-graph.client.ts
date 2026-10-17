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
        "O token nao tem acesso de administrador a esta Pagina",
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
      throw new MetaLeadFormGraphError("A Meta nao confirmou a assinatura", 502);
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
