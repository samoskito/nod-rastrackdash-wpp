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

/** Prazo do PUT da sessão: salvar reinicia a sessão na WAHA. */
export const WAHA_SESSION_UPDATE_TIMEOUT_MS = 30_000;

/** Prazo curto da consulta de LID: nunca segura a ingestão. */
export const WAHA_LID_LOOKUP_TIMEOUT_MS = 3_000;

const MASKED_SECRET_PATTERN = /^\*+$|\*{3,}/u;

/** Algum texto da configuração parece um segredo mascarado (***)? */
function containsMaskedSecret(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === "string") return MASKED_SECRET_PATTERN.test(value);
  if (Array.isArray(value))
    return value.some((item) => containsMaskedSecret(item, depth + 1));
  const record = asRecord(value);
  return record
    ? Object.values(record).some((item) => containsMaskedSecret(item, depth + 1))
    : false;
}

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

    // A WAHA pode devolver segredos mascarados (senha do proxy, hmac.key ou
    // cabeçalhos de outros webhooks). Gravar a configuração de volta trocaria
    // o segredo real pelos asteriscos: nesse caso nada é gravado. O nosso
    // próprio webhook antigo é substituído, então não conta.
    if (
      containsMaskedSecret({ ...existingConfig, webhooks: otherWebhooks })
    ) {
      return {
        configured: false,
        reason: "masked_secrets",
        message:
          "A sua WAHA devolveu senhas mascaradas na configuração da sessão (proxy, HMAC ou cabeçalhos de outro webhook). Para não apagá-las, o app não grava nada: use a configuração manual.",
        sessionStatus,
      };
    }

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
    const success: WhatsappWebhookConfigureResult = {
      configured: true,
      events: [...WAHA_GOWS_WEBHOOK_EVENTS],
      sessionStatus,
    };

    try {
      // Salvar reinicia a sessão na WAHA: o PUT tem um prazo bem maior que
      // as leituras.
      const response = await fetchProviderUrl(
        this.fetchImpl,
        url,
        {
          method: "PUT",
          headers: {
            "X-Api-Key": target.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        WAHA_SESSION_UPDATE_TIMEOUT_MS,
      );

      if (response.ok) {
        return success;
      }

      if (response.status >= 500 && (await this.webhookSaved(target, input))) {
        return success;
      }

      return {
        configured: false,
        reason: "provider_error",
        message: `A WAHA respondeu HTTP ${response.status} ao salvar o webhook.`,
        sessionStatus,
      };
    } catch (error) {
      // Prazo esgotado ou conexão caída durante o reinício: o PUT pode ter
      // sido aplicado. Confere com uma nova leitura antes de desistir.
      if (await this.webhookSaved(target, input)) {
        return success;
      }

      return {
        configured: false,
        reason: "unreachable",
        message: this.unreachableMessage(error),
        sessionStatus,
      };
    }
  }

  /**
   * Resolve o telefone de um LID pela WAHA do aluno:
   * GET {baseUrl}/api/{session}/lids/{lid} → { lid, pn } (documentado pela
   * WAHA para GOWS; pn é null quando a WAHA não conhece o número). Prazo
   * curto e nunca lança: qualquer falha devolve null.
   */
  async resolveLidPhone(
    config: WhatsappProviderConfig,
    lid: string,
  ): Promise<string | null> {
    const target = this.resolveTarget(config, { useEnvFallback: false });
    const lidUser = lid.replace(/@lid$/u, "");

    if (target.kind !== "ok" || !/^[0-9]{6,24}$/u.test(lidUser)) {
      return null;
    }

    try {
      const response = await fetchProviderUrl(
        this.fetchImpl,
        `${target.baseUrl.replace(/\/$/, "")}/api/${encodeURIComponent(target.session)}/lids/${lidUser}`,
        { method: "GET", headers: { "X-Api-Key": target.apiKey } },
        WAHA_LID_LOOKUP_TIMEOUT_MS,
      );

      if (!response.ok) {
        return null;
      }

      const payload = asRecord(await response.json().catch(() => null));
      const pn = typeof payload?.pn === "string" ? payload.pn : null;
      const match = pn
        ? /^([0-9]{8,20})(?::\d{1,4})?@(c\.us|s\.whatsapp\.net)$/u.exec(pn)
        : null;

      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /** Nova leitura da sessão: o nosso webhook (URL, eventos e token) está lá? */
  private async webhookSaved(
    target: { baseUrl: string; apiKey: string; session: string },
    input: WhatsappWebhookConfigureInput,
  ): Promise<boolean> {
    try {
      const response = await fetchProviderUrl(
        this.fetchImpl,
        this.sessionUrl(target.baseUrl, target.session),
        { method: "GET", headers: { "X-Api-Key": target.apiKey } },
      );

      if (!response.ok) {
        return false;
      }

      const session = asRecord(await response.json().catch(() => null));
      const webhooks = asRecord(session?.config)?.webhooks;
      const ourKey = webhookUrlKey(input.url);

      return (Array.isArray(webhooks) ? webhooks : []).some((entry) => {
        const webhook = asRecord(entry);
        const events = Array.isArray(webhook?.events) ? webhook.events : [];
        const headers = Array.isArray(webhook?.customHeaders)
          ? webhook.customHeaders
          : [];

        // Só o token exato prova que é a nossa gravação (um valor
        // mascarado não prova nada).
        return (
          webhookUrlKey(webhook?.url) === ourKey &&
          WAHA_GOWS_WEBHOOK_EVENTS.every((event) => events.includes(event)) &&
          headers.some((header) => {
            const record = asRecord(header);
            return (
              typeof record?.name === "string" &&
              record.name.toLowerCase() ===
                WAHA_WEBHOOK_TOKEN_HEADER.toLowerCase() &&
              record.value === input.token
            );
          })
        );
      });
    } catch {
      return false;
    }
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
