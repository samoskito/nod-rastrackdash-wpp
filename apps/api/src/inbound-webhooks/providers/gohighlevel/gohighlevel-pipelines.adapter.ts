import { Inject, Optional } from "@nestjs/common";

/**
 * GoHighLevel API v2 (read only): the pipelines and stages of ONE location,
 * so the rule screen can offer them in a list.
 *
 *   GET https://services.leadconnectorhq.com/opportunities/pipelines
 *       ?locationId=<location.id>
 *   Authorization: Bearer <Private Integration Token>   (scope
 *   opportunities.readonly)
 *   Version: 2021-07-28
 *
 * The host is fixed (never built from user input), the answer is size-bounded
 * and the token is only ever put in the Authorization header: never in a log,
 * an error message or a returned value.
 *
 * PENDENTE: the public docs page of this endpoint shows `Version: v3` in its
 * parameter table while the long-standing v2 contract is `2021-07-28`; the
 * constant below is the single place to change if GHL rejects it.
 */
export const GHL_API_ORIGIN = "https://services.leadconnectorhq.com";
export const GHL_API_VERSION = "2021-07-28";
export const GHL_FETCH = Symbol("GHL_FETCH");
const MAX_RESPONSE_BYTES = 1_000_000;
const TIMEOUT_MS = 5_000;

export type GhlStage = { id: string; name: string };
export type GhlPipeline = { id: string; name: string; stages: GhlStage[] };

export class GhlApiError extends Error {
  constructor(
    readonly code:
      | "ghl_unauthorized"
      | "ghl_forbidden"
      | "ghl_rate_limited"
      | "ghl_transport"
      | "ghl_invalid_response",
  ) {
    super(code);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 255) {
    throw new GhlApiError("ghl_invalid_response");
  }
  return value.trim();
}

export class GhlPipelinesAdapter {
  constructor(
    @Optional()
    @Inject(GHL_FETCH)
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async listPipelines(
    locationId: string,
    token: string,
  ): Promise<GhlPipeline[]> {
    const url = new URL("/opportunities/pipelines", GHL_API_ORIGIN);
    url.searchParams.set("locationId", locationId);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Version: GHL_API_VERSION,
          Accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new GhlApiError("ghl_transport");
    }
    if (response.status === 401) throw new GhlApiError("ghl_unauthorized");
    if (response.status === 403) throw new GhlApiError("ghl_forbidden");
    if (response.status === 429) throw new GhlApiError("ghl_rate_limited");
    if (!response.ok) throw new GhlApiError("ghl_transport");
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new GhlApiError("ghl_transport");
    }
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new GhlApiError("ghl_invalid_response");
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new GhlApiError("ghl_invalid_response");
    }
    const pipelines = record(body)?.pipelines;
    if (!Array.isArray(pipelines)) throw new GhlApiError("ghl_invalid_response");
    return pipelines.map((item) => {
      const pipeline = record(item);
      if (!pipeline || !Array.isArray(pipeline.stages)) {
        throw new GhlApiError("ghl_invalid_response");
      }
      return {
        id: name(pipeline.id),
        name: name(pipeline.name),
        stages: pipeline.stages.map((stage) => {
          const entry = record(stage);
          if (!entry) throw new GhlApiError("ghl_invalid_response");
          return { id: name(entry.id), name: name(entry.name) };
        }),
      };
    });
  }
}
