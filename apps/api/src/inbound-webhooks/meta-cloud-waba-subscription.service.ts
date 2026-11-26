import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type {
  MetaCloudWabaCallbackStatusDto,
  MetaCloudWabaCallbackTarget,
  MetaCloudWabaErrorCode,
  MetaCloudWabaPhoneNumberDto,
  MetaCloudWabaSubscribedAppDto,
  MetaCloudWabaSubscriptionMode,
  MetaCloudWabaSubscriptionStatusDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  RUNTIME_ENV,
  RUNTIME_FETCH,
  type RuntimeEnv,
  type RuntimeFetch,
} from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import { matchesInboundWebhookSecret } from "./inbound-webhook-ingestion.service";
import { connectionNotFoundMessage } from "./inbound-webhook-production-activation";
import { isProvisionalProviderChannelId } from "./inbound-webhook-provisional-channel";
import {
  type ResolvedMetaCloudAppSecret,
  resolveMetaCloudAppSecret,
} from "./meta-cloud-app-secret";

/** Mesmo padrão do adapter Meta do projeto. */
const defaultGraphApiVersion = "v21.0";
/** Prazo de cada chamada à Graph e prazo total da operação inteira. */
export const META_CLOUD_WABA_TIMEOUTS = Symbol("META_CLOUD_WABA_TIMEOUTS");
export type MetaCloudWabaTimeouts = { callMs: number; totalMs: number };
const defaultTimeouts: MetaCloudWabaTimeouts = { callMs: 10_000, totalMs: 25_000 };
const requiredScope = "whatsapp_business_management";
const acceptedTokenTypes = new Set(["USER", "SYSTEM_USER"]);

type GraphError = {
  code?: number;
  error_subcode?: number;
  message?: string;
};

type GraphResult = {
  status: number;
  body: Record<string, unknown> & { error?: GraphError };
};

type Operation = "lookup" | "subscribe";

/** Em qual etapa o erro da Graph aconteceu (muda a mensagem). */
type GraphStep = "token" | "waba_read" | "subscribe_post" | "override_post";

export type MetaCloudWabaRequest = {
  workspaceId: string;
  connectionId: string;
  actorUserId: string;
  wabaId: string;
  /** Usado só nas chamadas à Graph; nunca gravado, logado ou devolvido. */
  accessToken: string;
  /** IP de origem da requisição, só para a auditoria. */
  sourceIp?: string | null;
};

export type MetaCloudWabaSubscribeRequest = MetaCloudWabaRequest & {
  /** standard (padrão): sem desvio. agency_central_app: com desvio da WABA. */
  mode?: MetaCloudWabaSubscriptionMode;
  /**
   * Token de verificação desta conexão (só no modo App central). Conferido
   * contra o hash da conexão e repassado à Meta nesta chamada; nunca gravado,
   * logado, auditado ou devolvido.
   */
  verifyToken?: string;
};

/** Máximo de números consultados para ver o desvio por número. */
const maxPhoneOverrideChecks = 20;

type Ctx = MetaCloudWabaSubscribeRequest & {
  deadline: number;
  mode: MetaCloudWabaSubscriptionMode;
  /** URL de callback desta conexão (sem token), ou null sem API_PUBLIC_URL. */
  expectedUrl: string | null;
};

type SubscribedAppsRead = {
  apps: MetaCloudWabaSubscribedAppDto[];
  /** override_callback_uri do app desta conexão na WABA, se houver. */
  thisAppOverride: string | null;
};

/**
 * Erro com mensagem em português e `code` estável para a tela. Nunca carrega
 * o token nem a resposta bruta da Graph.
 */
export class MetaCloudWabaError extends HttpException {
  constructor(
    readonly code: MetaCloudWabaErrorCode,
    message: string,
    status: number,
  ) {
    super({ statusCode: status, message, code }, status);
  }
}

const messages = {
  appNotConfigured:
    "Falta o App ID e o App Secret do app Meta que entrega os webhooks desta conexão. Preencha os dois em “App do Meta desta conexão”, logo acima, ou, se a instalação usa um único app Meta, META_APP_ID e META_APP_SECRET na configuração da API (e reinicie a API) antes de consultar ou inscrever a WABA.",
  appCredentialsRejected:
    "A Meta recusou as credenciais do app desta instalação ao validar o token. Confira o ID e o segredo do app Meta (META_APP_ID e META_APP_SECRET) configurados na API (do seu próprio app Meta).",
  connectionAppCredentialsRejected:
    "A Meta recusou o App ID e o App Secret salvos nesta conexão ao validar o token. Confira os dois em “App do Meta desta conexão” (Configurações do app → Básico, no seu próprio app Meta) e salve de novo.",
  connectionAppUnreadable:
    "Não foi possível ler o App Secret salvo nesta conexão (a chave de criptografia da API pode ter mudado). Salve o App ID e o App Secret de novo em “App do Meta desta conexão”.",
  connectionNotMetaCloud:
    "A inscrição na WABA só existe para conexões Meta WhatsApp (Cloud API).",
  tokenInvalid:
    "A Meta informou que este token é inválido, expirou ou foi revogado. Gere um novo token no app da instalação (WhatsApp → Configuração da API) e tente de novo.",
  tokenType:
    "Este tipo de token não serve. Use o token temporário do painel do app (WhatsApp → Configuração da API), um token do Graph API Explorer ou um token de system user — sempre do app configurado nesta instalação.",
  tokenAppMismatch:
    "Este token foi gerado para outro app Meta. Gere o token no mesmo app desta conexão (o App ID salvo em “App do Meta desta conexão” ou, sem ele, o configurado na API): é com o segredo dele que a assinatura dos webhooks é conferida.",
  tokenMissingScope:
    "O token não tem a permissão whatsapp_business_management. Gere um novo token marcando essa permissão.",
  tokenWabaNotGranted:
    "O token não dá acesso a esta WABA. Ao gerar o token, selecione esta conta do WhatsApp Business (ou dê ao system user acesso a ela) e tente de novo.",
  wabaIdIsPhoneNumber:
    "Esse ID é de um número de telefone (phone number ID), não da WABA. Use o \"ID da conta do WhatsApp Business\", que aparece no Gerenciador do WhatsApp ou em WhatsApp → Configuração da API, logo acima do número.",
  wabaNotFound:
    "A Meta não encontrou essa WABA com este token. Confira se o ID é o \"ID da conta do WhatsApp Business\" (não o do número) e se o token tem acesso a ela.",
  permissionDenied:
    "A Meta negou a permissão para esta WABA. Quem gerou o token precisa ter acesso de administrador à conta do WhatsApp Business e o token precisa ter whatsapp_business_management.",
  rateLimited:
    "A Meta limitou as chamadas deste app ou desta WABA agora. Aguarde alguns minutos e tente de novo.",
  graphUnavailable:
    "Não foi possível falar com a Meta agora (falha de rede). Tente de novo em instantes.",
  graphTimeout:
    "A Meta demorou demais para responder. Clique em \"Consultar\" para ver o estado real da inscrição antes de tentar de novo.",
  graphUnexpected:
    "A Meta respondeu com um erro inesperado. Tente de novo em instantes; se continuar, confira pelo Graph API Explorer.",
  subscribeFailed:
    "A Meta não confirmou a inscrição do app na WABA. Tente de novo ou faça a inscrição manual pelo Graph API Explorer.",
  verifyTokenMismatch:
    "Esse não é o token de verificação desta conexão. Cole o token mostrado quando a conexão foi criada. Se você não tem mais, clique em “Gerar nova URL” nesta conexão: no Meta Cloud o endereço continua o mesmo e só o token de verificação muda (as mensagens continuam sendo conferidas pela assinatura do app).",
  callbackUrlUnavailable:
    "A API não tem um endereço público em HTTPS (API_PUBLIC_URL) para montar a URL desta conexão. A Meta só entrega em HTTPS. Configure API_PUBLIC_URL com o endereço público da API e reinicie a API.",
  overrideVerificationFailed:
    "A Meta não aceitou a URL desta conexão como destino desta WABA. Antes de aceitar, a Meta chama essa URL para conferir o token de verificação. Confira se a API está no ar no endereço público em HTTPS (API_PUBLIC_URL) e se o token de verificação colado é o desta conexão, e tente de novo.",
} as const;

/** origin + caminho, sem barra final, sem parâmetros. */
function normalizeCallbackUrl(value: string): { origin: string; path: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return {
      origin: url.origin.toLowerCase(),
      path: url.pathname.replace(/\/+$/, "") || "/",
    };
  } catch {
    return null;
  }
}

/**
 * Erro da Meta que indica falha na verificação da URL de callback: 2200
 * ("Callback verification failed") ou 100 com mensagem sobre o callback /
 * verify token. A mensagem da Meta só é inspecionada, nunca devolvida.
 */
function isCallbackVerificationError(error: GraphError): boolean {
  if (error.code === 2200) return true;
  return (
    error.code === 100 &&
    typeof error.message === "string" &&
    /callback|verif/i.test(error.message)
  );
}

/** Compara uma URL lida na Meta com a URL desta conexão. */
export function classifyMetaCloudCallbackUrl(
  value: unknown,
  expectedUrl: string | null,
  connectionId: string,
): MetaCloudWabaCallbackTarget {
  if (typeof value !== "string" || value.trim() === "") return "none";
  const found = normalizeCallbackUrl(value.trim());
  if (!found) return "other_url";
  const expected = expectedUrl ? normalizeCallbackUrl(expectedUrl) : null;
  if (!expected || expected.origin !== found.origin) return "other_url";
  if (expected.path === found.path) return "this_connection";
  const match = /^\/webhooks\/inbound\/([^/]+)$/.exec(found.path);
  if (!match) return "other_url";
  let id: string;
  try {
    id = decodeURIComponent(match[1] ?? "");
  } catch {
    return "other_url";
  }
  return id === connectionId ? "this_connection" : "other_connection_here";
}

/** Só o domínio do outro endereço; nunca caminho ou parâmetros. */
function callbackHost(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

/**
 * URL de callback desta conexão, a mesma que a tela mostra ao criar a
 * conexão (no Meta Cloud ela não leva token). null sem API_PUBLIC_URL.
 */
function connectionCallbackUrl(env: RuntimeEnv, connectionId: string): string | null {
  try {
    const config = parseInboundWebhooksConfig(env);
    if (!config.enabled || !config.apiPublicUrl) return null;
    return new URL(
      `/webhooks/inbound/${encodeURIComponent(connectionId)}`,
      config.apiPublicUrl,
    ).toString();
  } catch {
    return null;
  }
}

@Injectable()
export class MetaCloudWabaSubscriptionService {
  private readonly logger = new Logger(MetaCloudWabaSubscriptionService.name);
  private readonly timeouts: MetaCloudWabaTimeouts;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv,
    @Inject(RUNTIME_FETCH) private readonly fetchImpl: RuntimeFetch,
    @Optional()
    @Inject(META_CLOUD_WABA_TIMEOUTS)
    timeouts?: MetaCloudWabaTimeouts,
  ) {
    this.timeouts = timeouts ?? defaultTimeouts;
  }

  lookup(input: MetaCloudWabaRequest): Promise<MetaCloudWabaSubscriptionStatusDto> {
    return this.run("lookup", input);
  }

  subscribe(
    input: MetaCloudWabaSubscribeRequest,
  ): Promise<MetaCloudWabaSubscriptionStatusDto> {
    return this.run("subscribe", input);
  }

  private async run(
    operation: Operation,
    input: MetaCloudWabaSubscribeRequest,
  ): Promise<MetaCloudWabaSubscriptionStatusDto> {
    // A consulta nunca muda nada na Meta: o modo só vale na inscrição.
    const mode: MetaCloudWabaSubscriptionMode =
      operation === "subscribe" && input.mode === "agency_central_app"
        ? "agency_central_app"
        : "standard";
    const connection = await this.prisma.inboundWebhookConnection.findFirst({
      where: {
        id: input.connectionId,
        workspaceId: input.workspaceId,
        removedAt: null,
      },
      select: {
        id: true,
        workspaceId: true,
        provider: true,
        metaAppId: true,
        metaAppSecretEncrypted: true,
        secretHash: true,
      },
    });

    if (!connection) {
      throw new NotFoundException(connectionNotFoundMessage);
    }

    if (connection.provider !== "meta_cloud") {
      throw new MetaCloudWabaError(
        "connection_not_meta_cloud",
        messages.connectionNotMetaCloud,
        400,
      );
    }

    const ctx: Ctx = {
      ...input,
      mode,
      expectedUrl: connectionCallbackUrl(this.env, connection.id),
      deadline: Date.now() + this.timeouts.totalMs,
    };
    let status: MetaCloudWabaSubscriptionStatusDto;
    try {
      if (mode === "agency_central_app") {
        // Antes de qualquer chamada à Meta: a Meta confere a URL com este
        // token (GET hub.verify_token); se não for o da conexão, o nosso
        // handshake recusaria e a Meta também.
        if (!matchesInboundWebhookSecret(connection.secretHash, input.verifyToken)) {
          throw new MetaCloudWabaError(
            "verify_token_mismatch",
            messages.verifyTokenMismatch,
            422,
          );
        }
        if (!ctx.expectedUrl || !ctx.expectedUrl.startsWith("https://")) {
          throw new MetaCloudWabaError(
            "callback_url_unavailable",
            messages.callbackUrlUnavailable,
            422,
          );
        }
      }
      // App da conexão (App ID + App Secret salvos nela); sem eles, o app da
      // instalação (META_APP_ID + META_APP_SECRET). Nunca mistura os dois.
      const app = resolveMetaCloudAppSecret(connection, this.env);
      status = await this.execute(operation, ctx, app);
    } catch (error) {
      await this.safeAudit(operation, input, {
        resultStatus: "failed",
        summary: {
          mode,
          errorCode:
            error instanceof MetaCloudWabaError ? error.code : "unexpected",
        },
      });
      throw error;
    }

    // Fora do try: falha ao auditar um sucesso não vira erro nem "failed".
    await this.safeAudit(operation, input, {
      resultStatus: status.thisAppSubscribed ? "subscribed" : "not_subscribed",
      summary: {
        mode,
        outcome: status.outcome,
        callbackEffective: status.callback.effective,
        wabaOverride: status.callback.wabaOverride,
        thisAppSubscribed: status.thisAppSubscribed,
        subscribedAppsCount: status.apps.length,
        otherAppsCount: status.apps.filter((app) => !app.isThisApp).length,
        channelCheck: status.channelCheck.status,
      },
    });
    return status;
  }

  /** Nunca derruba a operação; loga só o nome do erro (sem dados). */
  private async safeAudit(
    operation: Operation,
    input: MetaCloudWabaRequest,
    result: { resultStatus: string; summary: Prisma.InputJsonObject },
  ): Promise<void> {
    try {
      await this.audit(operation, input, result);
    } catch (error) {
      this.logger.warn(
        `audit_failed operation=${operation} error=${error instanceof Error ? error.name : "unknown"}`,
      );
    }
  }

  private async execute(
    operation: Operation,
    input: Ctx,
    app: ResolvedMetaCloudAppSecret,
  ): Promise<MetaCloudWabaSubscriptionStatusDto> {
    const appId = app.appId;
    const appSecret = app.secret;

    if (!appId || !appSecret) {
      throw new MetaCloudWabaError(
        "meta_app_not_configured",
        app.source === "connection"
          ? messages.connectionAppUnreadable
          : messages.appNotConfigured,
        503,
      );
    }

    await this.validateToken(input, appId, appSecret, app.source);
    const phoneNumbers = await this.readPhoneNumbers(input);
    const channelCheck = await this.checkChannels(input, phoneNumbers);

    let read = await this.readSubscribedApps(input, appId);
    let outcome: MetaCloudWabaSubscriptionStatusDto["outcome"] = "lookup";
    let confirmationPending = false;
    const subscribed = () => read.apps.some((app) => app.isThisApp);
    const overrideTarget = () =>
      classifyMetaCloudCallbackUrl(
        read.thisAppOverride,
        input.expectedUrl,
        input.connectionId,
      );

    if (operation === "subscribe" && input.mode === "standard") {
      // Padrão: só inscreve quem ainda não está inscrito. Um POST sem corpo
      // apagaria um desvio existente, então um app já inscrito fica intacto.
      if (subscribed()) {
        outcome = "already_subscribed";
      } else {
        await this.subscribeThisApp(input);
        // Reconsulta: a tela mostra o estado real da Meta, não a suposição.
        read = await this.readSubscribedApps(input, appId);
        outcome = subscribed() ? "subscribed" : "subscribe_unconfirmed";
      }
    } else if (operation === "subscribe") {
      // App central da agência: inscreve (ou reinscreve) o app com o desvio
      // da WABA para a URL desta conexão. Já apontando para cá, nada muda.
      if (subscribed() && overrideTarget() === "this_connection") {
        outcome = "already_subscribed";
      } else {
        await this.subscribeThisApp(input, {
          overrideCallbackUri: input.expectedUrl as string,
          verifyToken: input.verifyToken as string,
        });
        try {
          read = await this.readSubscribedApps(input, appId);
          outcome =
            subscribed() && overrideTarget() === "this_connection"
              ? "override_set"
              : "override_unconfirmed";
        } catch {
          // A Meta aceitou o POST, mas a reconsulta falhou: o desvio foi
          // pedido e a confirmação fica pendente ("Consultar" mostra o real).
          outcome = "override_unconfirmed";
          confirmationPending = true;
        }
      }
    }

    const callback = await this.readCallbackStatus(input, {
      appId,
      appSecret,
      subscribed: subscribed(),
      thisAppOverride: read.thisAppOverride,
      phoneNumbers,
      confirmationPending,
    });

    return {
      connectionId: input.connectionId,
      wabaId: input.wabaId,
      thisAppId: appId,
      thisAppSubscribed: subscribed(),
      apps: read.apps,
      phoneNumbers,
      channelCheck,
      outcome,
      mode: input.mode,
      callback,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Para onde a Meta entrega as mensagens desta WABA para este app, pela
   * ordem da Meta: desvio do número > desvio da WABA > URL do app. As
   * leituras do app e dos números são só para mostrar na tela: se falharem,
   * viram "unknown" e nunca derrubam a consulta nem a inscrição.
   */
  private async readCallbackStatus(
    input: Ctx,
    options: {
      appId: string;
      appSecret: string;
      subscribed: boolean;
      thisAppOverride: string | null;
      phoneNumbers: MetaCloudWabaPhoneNumberDto[];
      /** O POST foi aceito, mas a reconsulta falhou: estado ainda incerto. */
      confirmationPending?: boolean;
    },
  ): Promise<MetaCloudWabaCallbackStatusDto> {
    const classify = (value: unknown) =>
      classifyMetaCloudCallbackUrl(value, input.expectedUrl, input.connectionId);
    const wabaOverride = options.subscribed
      ? classify(options.thisAppOverride)
      : "none";
    const app = await this.readAppCallback(input, options.appId, options.appSecret);
    const appCallback =
      app.callbackUrl === undefined ? "unknown" : classify(app.callbackUrl);

    const phoneOverrides: MetaCloudWabaCallbackStatusDto["phoneOverrides"] = [];
    if (options.subscribed) {
      for (const phone of options.phoneNumbers.slice(0, maxPhoneOverrideChecks)) {
        phoneOverrides.push({
          phoneNumberId: phone.id,
          target: await this.readPhoneOverride(input, phone.id, classify),
        });
      }
    }

    const resolve = (phoneTarget: MetaCloudWabaCallbackTarget) => {
      if (phoneTarget !== "none" && phoneTarget !== "unknown") return phoneTarget;
      if (wabaOverride !== "none" && wabaOverride !== "unknown") return wabaOverride;
      return appCallback;
    };
    const phoneOverridesNotChecked = options.subscribed
      ? Math.max(0, options.phoneNumbers.length - maxPhoneOverrideChecks)
      : 0;
    let effective: MetaCloudWabaCallbackStatusDto["effective"];
    if (options.confirmationPending) {
      effective = "unknown";
    } else if (!options.subscribed) {
      effective = "not_subscribed";
    } else if (app.messagesField === false) {
      // Sem o campo messages assinado no app, a Meta não entrega nada,
      // nem para a URL do app nem para um desvio.
      effective = "app_messages_off";
    } else {
      const targets = (phoneOverrides.length > 0
        ? phoneOverrides.map((phone) => phone.target)
        : ["none" as const]
      ).map(resolve);
      const someUnchecked =
        phoneOverridesNotChecked > 0 ||
        phoneOverrides.some((phone) => phone.target === "unknown");
      if (targets.some((target) => target === "other_url" || target === "other_connection_here")) {
        effective = "elsewhere";
      } else if (someUnchecked) {
        // Número que não deu para conferir pode ter desvio próprio: nunca
        // afirmar que tudo chega aqui.
        effective = "unknown";
      } else if (targets.every((target) => target === "this_connection")) {
        effective = "this_connection";
      } else {
        effective = "unknown";
      }
    }

    return {
      expectedUrl: input.expectedUrl,
      wabaOverride,
      wabaOverrideHost:
        wabaOverride === "other_url" ? callbackHost(options.thisAppOverride) : null,
      appCallback,
      appMessagesField: app.messagesField,
      phoneOverrides,
      phoneOverridesNotChecked,
      effective,
    };
  }

  /**
   * GET /{app-id}/subscriptions com o app token (montado só aqui): URL de
   * callback do app e se o campo messages está assinado. undefined = não
   * deu para ler.
   */
  private async readAppCallback(
    input: Ctx,
    appId: string,
    appSecret: string,
  ): Promise<{ callbackUrl: string | null | undefined; messagesField: boolean | null }> {
    try {
      const result = await this.graph(
        "GET",
        `/${encodeURIComponent(appId)}/subscriptions`,
        { bearer: `${appId}|${appSecret}`, deadline: input.deadline },
      );
      if (result.body.error) return { callbackUrl: undefined, messagesField: null };
      const data = Array.isArray(result.body.data) ? result.body.data : [];
      const entry = data
        .map((raw) => (raw ?? {}) as Record<string, unknown>)
        .find((item) => item.object === "whatsapp_business_account");
      if (!entry) return { callbackUrl: null, messagesField: false };
      const fields = Array.isArray(entry.fields) ? entry.fields : [];
      const messagesField = fields.some((field) =>
        typeof field === "string"
          ? field === "messages"
          : (field as { name?: unknown } | null)?.name === "messages",
      );
      return {
        callbackUrl:
          typeof entry.callback_url === "string" && entry.active !== false
            ? entry.callback_url
            : null,
        messagesField,
      };
    } catch {
      return { callbackUrl: undefined, messagesField: null };
    }
  }

  /** GET /{PHONE_ID}?fields=webhook_configuration (desvio por número). */
  private async readPhoneOverride(
    input: Ctx,
    phoneNumberId: string,
    classify: (value: unknown) => MetaCloudWabaCallbackTarget,
  ): Promise<MetaCloudWabaCallbackTarget> {
    try {
      const result = await this.graph(
        "GET",
        `/${encodeURIComponent(phoneNumberId)}`,
        {
          bearer: input.accessToken,
          deadline: input.deadline,
          query: { fields: "webhook_configuration" },
        },
      );
      if (result.body.error) return "unknown";
      const config = result.body.webhook_configuration;
      if (!config || typeof config !== "object") return "none";
      const { phone_number: phone, whatsapp_business_account: waba, application } =
        config as Record<string, unknown>;
      // Se a Meta repetir no número a URL da WABA ou do app, não é desvio
      // próprio do número.
      if (typeof phone !== "string" || !phone.trim() || phone === waba || phone === application) {
        return "none";
      }
      return classify(phone);
    } catch {
      return "unknown";
    }
  }

  /**
   * debug_token com o app token (App ID|App Secret da conexão ou, sem eles,
   * META_APP_ID|META_APP_SECRET), montado só aqui no servidor. Aceita token
   * de usuário (temporário do painel do app ou do Graph API Explorer) e de
   * system user.
   */
  private async validateToken(
    input: Ctx,
    appId: string,
    appSecret: string,
    source: ResolvedMetaCloudAppSecret["source"],
  ): Promise<void> {
    const result = await this.graph("GET", "/debug_token", {
      bearer: `${appId}|${appSecret}`,
      query: { input_token: input.accessToken },
      deadline: input.deadline,
    });

    if (result.body.error) {
      const code = result.body.error.code;
      // Erro no nível de cima do debug_token é da credencial da instalação
      // (app token), não do token do aluno, que vem em data.is_valid.
      if (code === 190 || code === 100 || code === 101 || code === 102) {
        throw new MetaCloudWabaError(
          "meta_app_not_configured",
          source === "connection"
            ? messages.connectionAppCredentialsRejected
            : messages.appCredentialsRejected,
          503,
        );
      }
      throw this.mapGraphError(result.body.error, "token");
    }

    const data = (result.body.data ?? {}) as {
      app_id?: unknown;
      type?: unknown;
      is_valid?: unknown;
      expires_at?: unknown;
      scopes?: unknown;
      granular_scopes?: unknown;
    };
    const expiresAt = typeof data.expires_at === "number" ? data.expires_at : 0;

    if (
      data.is_valid !== true ||
      (expiresAt > 0 && expiresAt * 1000 <= Date.now())
    ) {
      throw new MetaCloudWabaError("token_invalid", messages.tokenInvalid, 422);
    }

    if (String(data.app_id ?? "") !== appId) {
      throw new MetaCloudWabaError(
        "token_app_mismatch",
        messages.tokenAppMismatch,
        422,
      );
    }

    if (typeof data.type !== "string" || !acceptedTokenTypes.has(data.type)) {
      throw new MetaCloudWabaError(
        "token_type_not_supported",
        messages.tokenType,
        422,
      );
    }

    const scopes = Array.isArray(data.scopes) ? data.scopes : [];
    if (!scopes.includes(requiredScope)) {
      throw new MetaCloudWabaError(
        "token_missing_scope",
        messages.tokenMissingScope,
        422,
      );
    }

    const granular = Array.isArray(data.granular_scopes)
      ? (data.granular_scopes as Array<{ scope?: unknown; target_ids?: unknown }>)
      : [];
    const entry = granular.find((item) => item?.scope === requiredScope);

    // Sem target_ids o escopo vale para todas as contas do usuário: a
    // confirmação final fica com phone_numbers/subscribed_apps.
    if (entry && Array.isArray(entry.target_ids)) {
      const targets = entry.target_ids.map((id) => String(id));
      if (!targets.includes(input.wabaId)) {
        if (await this.looksLikePhoneNumberId(input)) {
          throw new MetaCloudWabaError(
            "waba_id_is_phone_number",
            messages.wabaIdIsPhoneNumber,
            422,
          );
        }
        throw new MetaCloudWabaError(
          "token_waba_not_granted",
          messages.tokenWabaNotGranted,
          422,
        );
      }
    }
  }

  private async readPhoneNumbers(
    input: Ctx,
  ): Promise<MetaCloudWabaPhoneNumberDto[]> {
    const result = await this.graph(
      "GET",
      `/${encodeURIComponent(input.wabaId)}/phone_numbers`,
      {
        bearer: input.accessToken,
        deadline: input.deadline,
        query: { fields: "id,display_phone_number,verified_name", limit: "100" },
      },
    );

    if (result.body.error) {
      if (
        result.body.error.code === 100 &&
        (await this.looksLikePhoneNumberId(input))
      ) {
        throw new MetaCloudWabaError(
          "waba_id_is_phone_number",
          messages.wabaIdIsPhoneNumber,
          422,
        );
      }
      throw this.mapGraphError(result.body.error, "waba_read");
    }

    const data = Array.isArray(result.body.data) ? result.body.data : [];
    return data
      .map((item) => item as Record<string, unknown>)
      .filter((item) => typeof item.id === "string" || typeof item.id === "number")
      .map((item) => ({
        id: String(item.id),
        displayPhoneNumber:
          typeof item.display_phone_number === "string"
            ? item.display_phone_number
            : null,
        verifiedName:
          typeof item.verified_name === "string" ? item.verified_name : null,
      }));
  }

  /**
   * Detecta o phone number ID colado no lugar do WABA ID: pelo canal real da
   * própria conexão ou perguntando à Graph se o nó tem display_phone_number.
   */
  private async looksLikePhoneNumberId(
    input: Ctx,
  ): Promise<boolean> {
    const knownChannel = await this.prisma.inboundWebhookChannel.findFirst({
      where: {
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        providerChannelId: input.wabaId,
      },
      select: { id: true },
    });
    if (knownChannel) return true;

    try {
      const probe = await this.graph(
        "GET",
        `/${encodeURIComponent(input.wabaId)}`,
        {
          bearer: input.accessToken,
        deadline: input.deadline,
          query: { fields: "id,display_phone_number" },
        },
      );
      return (
        !probe.body.error && typeof probe.body.display_phone_number === "string"
      );
    } catch {
      return false;
    }
  }

  private async checkChannels(
    input: Ctx,
    phoneNumbers: MetaCloudWabaPhoneNumberDto[],
  ): Promise<MetaCloudWabaSubscriptionStatusDto["channelCheck"]> {
    const channels = await this.prisma.inboundWebhookChannel.findMany({
      where: { workspaceId: input.workspaceId, connectionId: input.connectionId },
      select: { organizationId: true, providerChannelId: true },
    });
    const real = channels.filter(
      (channel) => !isProvisionalProviderChannelId(channel.providerChannelId),
    );

    if (real.length === 0) {
      return { status: "no_real_channel", mismatchedChannels: 0 };
    }

    const ids = new Set(phoneNumbers.map((phone) => phone.id));
    const mismatched = real.filter(
      (channel) =>
        !ids.has(channel.providerChannelId) ||
        (!channel.organizationId.startsWith("provisional:") &&
          channel.organizationId !== input.wabaId),
    ).length;

    return {
      status: mismatched > 0 ? "mismatch" : "all_match",
      mismatchedChannels: mismatched,
    };
  }

  private async readSubscribedApps(
    input: Ctx,
    appId: string,
  ): Promise<SubscribedAppsRead> {
    const result = await this.graph(
      "GET",
      `/${encodeURIComponent(input.wabaId)}/subscribed_apps`,
      { bearer: input.accessToken, deadline: input.deadline },
    );

    if (result.body.error) {
      throw this.mapGraphError(result.body.error, "waba_read");
    }

    const data = Array.isArray(result.body.data) ? result.body.data : [];
    const apps: MetaCloudWabaSubscribedAppDto[] = [];
    let thisAppOverride: string | null = null;
    for (const raw of data) {
      const item = (raw ?? {}) as Record<string, unknown>;
      // v17+ devolve whatsapp_business_api_data; versões antigas, id/name.
      const node = (
        item.whatsapp_business_api_data &&
        typeof item.whatsapp_business_api_data === "object"
          ? item.whatsapp_business_api_data
          : item
      ) as Record<string, unknown>;
      const id =
        typeof node.id === "string" || typeof node.id === "number"
          ? String(node.id)
          : null;
      if (!id) continue;
      apps.push({
        appId: id,
        name: typeof node.name === "string" ? node.name : null,
        isThisApp: id === appId,
      });
      // O desvio fica no item (fora de whatsapp_business_api_data).
      if (id === appId && typeof item.override_callback_uri === "string") {
        thisAppOverride = item.override_callback_uri.trim() || null;
      }
    }
    return { apps, thisAppOverride };
  }

  /**
   * Só POST; nunca DELETE nem outros apps. Sem `override`, vai sem corpo
   * (modo padrão). Com `override`, leva override_callback_uri e verify_token
   * (modo App central): a Meta confere a URL com um GET de verificação antes
   * de aceitar.
   */
  private async subscribeThisApp(
    input: Ctx,
    override?: { overrideCallbackUri: string; verifyToken: string },
  ): Promise<void> {
    const result = await this.graph(
      "POST",
      `/${encodeURIComponent(input.wabaId)}/subscribed_apps`,
      {
        bearer: input.accessToken,
        deadline: input.deadline,
        ...(override
          ? {
              json: {
                override_callback_uri: override.overrideCallbackUri,
                verify_token: override.verifyToken,
              },
            }
          : {}),
      },
    );

    if (result.body.error) {
      throw this.mapGraphError(
        result.body.error,
        override ? "override_post" : "subscribe_post",
      );
    }

    if (result.body.success !== true) {
      throw new MetaCloudWabaError(
        "subscribe_failed",
        messages.subscribeFailed,
        502,
      );
    }
  }

  private mapGraphError(error: GraphError, step: GraphStep): MetaCloudWabaError {
    const code = error.code;

    if (code === 190) {
      return new MetaCloudWabaError("token_invalid", messages.tokenInvalid, 422);
    }
    if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80007) {
      return new MetaCloudWabaError("rate_limited", messages.rateLimited, 429);
    }
    if (code === 10 || code === 200 || (typeof code === "number" && code > 200 && code < 300)) {
      return new MetaCloudWabaError(
        "permission_denied",
        messages.permissionDenied,
        422,
      );
    }
    // App central: só a falha de verificação da URL vira a mensagem sobre
    // API_PUBLIC_URL e token de verificação (2200, ou 100 cuja mensagem da
    // Meta fala da verificação/callback). PENDENTE: confirmar o código com
    // uma WABA real. Qualquer outro erro do POST com desvio cai no genérico.
    if (step === "override_post") {
      if (isCallbackVerificationError(error)) {
        return new MetaCloudWabaError(
          "override_verification_failed",
          messages.overrideVerificationFailed,
          422,
        );
      }
      if (code === 1 || code === 2) {
        return new MetaCloudWabaError(
          "graph_unavailable",
          messages.graphUnavailable,
          502,
        );
      }
      return new MetaCloudWabaError("subscribe_failed", messages.subscribeFailed, 502);
    }
    if (code === 100) {
      return step === "token"
        ? new MetaCloudWabaError("token_invalid", messages.tokenInvalid, 422)
        : new MetaCloudWabaError("waba_not_found", messages.wabaNotFound, 422);
    }
    if (code === 1 || code === 2) {
      return new MetaCloudWabaError(
        "graph_unavailable",
        messages.graphUnavailable,
        502,
      );
    }
    // Código desconhecido: só o POST de inscrição fala em "não confirmou".
    return step === "subscribe_post"
      ? new MetaCloudWabaError("subscribe_failed", messages.subscribeFailed, 502)
      : new MetaCloudWabaError("graph_unavailable", messages.graphUnexpected, 502);
  }

  private async graph(
    method: "GET" | "POST",
    path: string,
    options: {
      bearer: string;
      deadline: number;
      query?: Record<string, string>;
      /** Corpo JSON (só o POST com desvio). Nunca logado. */
      json?: Record<string, string>;
    },
  ): Promise<GraphResult> {
    const version = this.env.META_GRAPH_API_VERSION?.trim() || defaultGraphApiVersion;
    const url = new URL(`https://graph.facebook.com/${version}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const remaining = options.deadline - Date.now();
    if (remaining <= 0) {
      throw new MetaCloudWabaError("graph_unavailable", messages.graphTimeout, 504);
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.min(this.timeouts.callMs, remaining));

    try {
      const response = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${options.bearer}`,
          ...(options.json ? { "Content-Type": "application/json" } : {}),
        },
        ...(options.json ? { body: JSON.stringify(options.json) } : {}),
        signal: controller.signal,
      });
      let body: GraphResult["body"] = {};
      try {
        const parsed = (await response.json()) as unknown;
        if (parsed && typeof parsed === "object") {
          body = parsed as GraphResult["body"];
        }
      } catch {
        body = {};
      }
      if (!response.ok && !body.error) {
        body = { error: { code: response.status >= 500 ? 2 : undefined } };
      }
      return { status: response.status, body };
    } catch {
      // Sem detalhes do erro: a mensagem de rede pode carregar a URL.
      throw new MetaCloudWabaError(
        "graph_unavailable",
        timedOut ? messages.graphTimeout : messages.graphUnavailable,
        504,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async audit(
    operation: Operation,
    input: MetaCloudWabaRequest,
    result: { resultStatus: string; summary: Prisma.InputJsonObject },
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        actorType: "user",
        action:
          operation === "lookup"
            ? "inbound_webhook.meta_cloud_waba_lookup"
            : "inbound_webhook.meta_cloud_waba_subscribe",
        targetType: "InboundWebhookConnection",
        targetId: input.connectionId,
        reason: null,
        sourceIp: input.sourceIp ? input.sourceIp.slice(0, 64) : null,
        resultStatus: result.resultStatus,
        beforeSummary: undefined,
        afterSummary: {
          wabaId: input.wabaId,
          operation,
          ...result.summary,
        },
      },
    });
  }
}

