import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  RUNTIME_FETCH,
  type RuntimeFetch,
} from "../../common/runtime/runtime.module";
import { INTEGRATION_ENV } from "../integration.types";
import type { IntegrationEnv } from "../integration.types";
import {
  WAHA_GOWS_WEBHOOK_EVENTS,
  WAHA_WEBHOOK_TOKEN_HEADER,
} from "@wpptrack/shared";
import type {
  WahaConfig,
  WhatsappProviderAdapter,
  WhatsappProviderConfig,
  WhatsappProviderHealthDto,
  WhatsappWebhookConfigureInput,
  WhatsappWebhookConfigureResult,
} from "./whatsapp-provider.types";
import {
  fetchProviderUrl,
  normalizeProviderBaseUrl,
  providerRequestFailureMessage,
} from "./whatsapp-provider-http";
import {
  mapWahaSessionStatus,
  wahaSessionStatusMessage,
} from "./waha-session-status";

const DEFAULT_SESSION = "default";

/** Motor da WAHA suportado pelo parser v2. */
export const WAHA_SUPPORTED_ENGINE = "GOWS";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** URL sem query string, para reconhecer um webhook nosso já configurado. */
function webhookUrlKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Motor informado pela WAHA na resposta da sessão (`engine.engine`) ou no
 * envelope (`engine`). Sem a informação, não presume nada.
 */
function reportedEngine(session: JsonRecord): string | null {
  const engine = session.engine;
  if (typeof engine === "string" && engine.trim()) return engine.trim();
  const nested = asRecord(engine)?.engine;
  return typeof nested === "string" && nested.trim() ? nested.trim() : null;
}

/**
 * Adaptador da WAHA própria do aluno (BYO). O servidor, a sessão e o QR
 * ficam no painel da WAHA do aluno; o app só:
 *   - valida a conexão: GET {baseUrl}/api/sessions/{session} (X-Api-Key);
 *   - configura o webhook da sessão: PUT {baseUrl}/api/sessions/{session},
 *     preservando a configuração existente e trocando só o nosso webhook.
 *
 * Nunca cria sessão, nunca pede QR e não usa segredos PalmUP. HMAC fica
 * fora por enquanto: a entrega é autenticada pelo token no cabeçalho
 * X-Wpptrack-Webhook-Token (ou ?token= na URL, no modo manual).
 *
 * `listLabels` continua sem implementação — a WAHA não tem catálogo de
 * etiquetas como a Uazapi.
 */
@Injectable()
export class WahaWhatsappAdapter implements WhatsappProviderAdapter {
  readonly id = "waha" as const;

  constructor(
    @Inject(INTEGRATION_ENV) private readonly env: IntegrationEnv = process.env,
    @Optional()
    @Inject(RUNTIME_FETCH)
    private readonly fetchImpl: RuntimeFetch = fetch,
  ) {}

  async getHealth(
    config?: WhatsappProviderConfig,
  ): Promise<WhatsappProviderHealthDto> {
    const checkedAt = new Date().toISOString();
    const target = this.resolveTarget(config);

    if (target.kind === "missing") {
      return {
        provider: this.id,
        status: "disconnected",
        checkedAt,
        message: "Missing WAHA_BASE_URL or WAHA_API_KEY",
      };
    }

    if (target.kind === "invalid_url") {
      return {
        provider: this.id,
        status: "error",
        checkedAt,
        message: "Invalid WAHA base URL",
      };
    }

    try {
      const response = await fetchProviderUrl(
        this.fetchImpl,
        this.sessionUrl(target.baseUrl, target.session),
        {
          method: "GET",
          headers: { "X-Api-Key": target.apiKey },
        },
      );

      if (!response.ok) {
        return {
          provider: this.id,
          status: "error",
          checkedAt,
          message: `WAHA session API HTTP ${response.status}`,
        };
      }

      const payload = asRecord(await response.json().catch(() => ({}))) ?? {};
      const status = typeof payload.status === "string" ? payload.status : null;
      const engine = reportedEngine(payload);

      if (engine && engine.toUpperCase() !== WAHA_SUPPORTED_ENGINE) {
        return {
          provider: this.id,
          status: "error",
          checkedAt,
          message: "WAHA engine not supported: use GOWS",
          ...this.providerStatus(status),
        };
      }

      return {
        provider: this.id,
        status: mapWahaSessionStatus(status),
        checkedAt,
        message: wahaSessionStatusMessage(status),
        ...this.providerStatus(status),
      };
    } catch (error) {
      return {
        provider: this.id,
        status: "error",
        checkedAt,
        message: providerRequestFailureMessage(error),
      };
    }
  }

  /**
   * Configura o webhook da sessão na WAHA do aluno. Lê a sessão, mantém
   * toda a configuração dela (proxy, metadados, outros webhooks) e só
   * substitui o webhook que aponta para a nossa URL. A WAHA pode reiniciar
   * a sessão ao salvar; a sessão já autenticada volta sem novo QR.
   */
  async configureWebhook(
    config: WhatsappProviderConfig,
    input: WhatsappWebhookConfigureInput,
  ): Promise<WhatsappWebhookConfigureResult> {
    const target = this.resolveTarget(config, { useEnvFallback: false });

    if (target.kind !== "ok") {
      return {
        configured: false,
        reason: "invalid_config",
        message: "Informe a URL do servidor, a API key e a sessão da WAHA.",
      };
    }

    const url = this.sessionUrl(target.baseUrl, target.session);
    let current: JsonRecord;

    try {
      const response = await fetchProviderUrl(this.fetchImpl, url, {
        method: "GET",
        headers: { "X-Api-Key": target.apiKey },
      });

      if (response.status === 404) {
        return {
          configured: false,
          reason: "session_not_found",
          message:
            "A sessão não existe nessa WAHA. Crie a sessão no painel da sua WAHA e confira o nome.",
        };
      }

      if (response.status === 401 || response.status === 403) {
        return {
          configured: false,
          reason: "unauthorized",
          message: "A WAHA recusou a API key. Confira a chave informada.",
        };
      }

      if (!response.ok) {
        return {
          configured: false,
          reason: "provider_error",
          message: `A WAHA respondeu HTTP ${response.status} ao ler a sessão.`,
        };
      }

      current = asRecord(await response.json().catch(() => null)) ?? {};
    } catch (error) {
      return {
        configured: false,
        reason: "unreachable",
        message: this.unreachableMessage(error),
      };
    }

    const sessionStatus =
      typeof current.status === "string" ? current.status : null;
    const engine = reportedEngine(current);

    if (engine && engine.toUpperCase() !== WAHA_SUPPORTED_ENGINE) {
      return {
        configured: false,
        reason: "engine_not_supported",
        message: `Esta sessão usa o motor ${engine.slice(0, 40)}. Por enquanto o app só lê o motor GOWS.`,
        sessionStatus,
      };
    }

    const existingConfig = asRecord(current.config) ?? {};
    const ourKey = webhookUrlKey(input.url);
    const otherWebhooks = (
      Array.isArray(existingConfig.webhooks) ? existingConfig.webhooks : []
    ).filter((webhook) => webhookUrlKey(asRecord(webhook)?.url) !== ourKey);
    const body = {
      name: target.session,
      config: {
        ...existingConfig,
        webhooks: [
          ...otherWebhooks,
          {
            url: input.url,
            events: [...WAHA_GOWS_WEBHOOK_EVENTS],
            customHeaders: [
              { name: WAHA_WEBHOOK_TOKEN_HEADER, value: input.token },
            ],
            retries: { policy: "linear", delaySeconds: 2, attempts: 5 },
          },
        ],
      },
    };

    try {
      const response = await fetchProviderUrl(this.fetchImpl, url, {
        method: "PUT",
        headers: {
          "X-Api-Key": target.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        return {
          configured: false,
          reason: "provider_error",
          message: `A WAHA respondeu HTTP ${response.status} ao salvar o webhook.`,
          sessionStatus,
        };
      }
    } catch (error) {
      return {
        configured: false,
        reason: "unreachable",
        message: this.unreachableMessage(error),
        sessionStatus,
      };
    }

    return {
      configured: true,
      events: [...WAHA_GOWS_WEBHOOK_EVENTS],
      sessionStatus,
    };
  }

  private resolveTarget(
    config: WhatsappProviderConfig | undefined,
    options: { useEnvFallback: boolean } = { useEnvFallback: true },
  ):
    | { kind: "missing" }
    | { kind: "invalid_url" }
    | { kind: "ok"; baseUrl: string; apiKey: string; session: string } {
    const saved: WahaConfig | null =
      config?.provider === this.id ? config.config : null;
    const env = options.useEnvFallback ? this.env : {};
    const configuredBaseUrl = saved?.baseUrl.trim() ?? env.WAHA_BASE_URL?.trim();
    const apiKey = saved?.apiKey.trim() ?? env.WAHA_API_KEY?.trim();

    if (!configuredBaseUrl || !apiKey) {
      return { kind: "missing" };
    }

    const baseUrl = normalizeProviderBaseUrl(configuredBaseUrl);
    if (!baseUrl) {
      return { kind: "invalid_url" };
    }

    const session =
      saved?.session?.trim() ||
      env.WAHA_SESSION?.trim() ||
      (options.useEnvFallback ? DEFAULT_SESSION : "");

    if (!session) {
      return { kind: "missing" };
    }

    return { kind: "ok", baseUrl, apiKey, session };
  }

  private sessionUrl(baseUrl: string, session: string): string {
    return `${baseUrl.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(session)}`;
  }

  private providerStatus(
    status: string | null,
  ): { providerStatus?: string } {
    return status && /^[A-Za-z_]{1,40}$/u.test(status)
      ? { providerStatus: status }
      : {};
  }

  private unreachableMessage(error: unknown): string {
    return providerRequestFailureMessage(error) === "Provider request timed out"
      ? "A WAHA não respondeu a tempo. Confira se o servidor está no ar."
      : "Não foi possível falar com a WAHA. Confira a URL do servidor.";
  }
}
