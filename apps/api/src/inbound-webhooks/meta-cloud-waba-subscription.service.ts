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
  MetaCloudWabaErrorCode,
  MetaCloudWabaPhoneNumberDto,
  MetaCloudWabaSubscribedAppDto,
  MetaCloudWabaSubscriptionStatusDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  RUNTIME_ENV,
  RUNTIME_FETCH,
  type RuntimeEnv,
  type RuntimeFetch,
} from "../common/runtime/runtime.module";
import { connectionNotFoundMessage } from "./inbound-webhook-production-activation";
import { isProvisionalProviderChannelId } from "./inbound-webhook-provisional-channel";

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
type GraphStep = "token" | "waba_read" | "subscribe_post";

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

type Ctx = MetaCloudWabaRequest & { deadline: number };

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
    "Esta instalação ainda não tem META_APP_ID e META_APP_SECRET configurados na API. Configure as duas variáveis do seu próprio app Meta (o mesmo que entrega os webhooks) e reinicie a API antes de consultar ou inscrever a WABA.",
  appCredentialsRejected:
    "A Meta recusou as credenciais do app desta instalação ao validar o token. Confira META_APP_ID e META_APP_SECRET na API (do seu próprio app Meta).",
  connectionNotMetaCloud:
    "A inscrição na WABA só existe para conexões Meta WhatsApp (Cloud API).",
  tokenInvalid:
    "A Meta informou que este token é inválido, expirou ou foi revogado. Gere um novo token no app da instalação (WhatsApp → Configuração da API) e tente de novo.",
  tokenType:
    "Este tipo de token não serve. Use o token temporário do painel do app (WhatsApp → Configuração da API), um token do Graph API Explorer ou um token de system user — sempre do app configurado nesta instalação.",
  tokenAppMismatch:
    "Este token foi gerado para outro app Meta. Gere o token no mesmo app configurado nesta instalação (META_APP_ID): é com o segredo dele que a assinatura dos webhooks é conferida.",
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
} as const;

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
    input: MetaCloudWabaRequest,
  ): Promise<MetaCloudWabaSubscriptionStatusDto> {
    return this.run("subscribe", input);
  }

  private async run(
    operation: Operation,
    input: MetaCloudWabaRequest,
  ): Promise<MetaCloudWabaSubscriptionStatusDto> {
    const connection = await this.prisma.inboundWebhookConnection.findFirst({
      where: {
        id: input.connectionId,
        workspaceId: input.workspaceId,
        removedAt: null,
      },
      select: { id: true, provider: true },
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

    const ctx: Ctx = { ...input, deadline: Date.now() + this.timeouts.totalMs };
    let status: MetaCloudWabaSubscriptionStatusDto;
    try {
      status = await this.execute(operation, ctx);
    } catch (error) {
      await this.safeAudit(operation, input, {
        resultStatus: "failed",
        summary: {
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
        outcome: status.outcome,
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
  ): Promise<MetaCloudWabaSubscriptionStatusDto> {
    const appId = this.env.META_APP_ID?.trim();
    const appSecret = this.env.META_APP_SECRET?.trim();

    if (!appId || !appSecret) {
      throw new MetaCloudWabaError(
        "meta_app_not_configured",
        messages.appNotConfigured,
        503,
      );
    }

    await this.validateToken(input, appId, appSecret);
    const phoneNumbers = await this.readPhoneNumbers(input);
    const channelCheck = await this.checkChannels(input, phoneNumbers);

    let apps = await this.readSubscribedApps(input, appId);
    let outcome: MetaCloudWabaSubscriptionStatusDto["outcome"] = "lookup";

    if (operation === "subscribe") {
      if (apps.some((app) => app.isThisApp)) {
        outcome = "already_subscribed";
      } else {
        await this.subscribeThisApp(input);
        // Reconsulta: a tela mostra o estado real da Meta, não a suposição.
        apps = await this.readSubscribedApps(input, appId);
        outcome = apps.some((app) => app.isThisApp)
          ? "subscribed"
          : "subscribe_unconfirmed";
      }
    }

    return {
      connectionId: input.connectionId,
      wabaId: input.wabaId,
      thisAppId: appId,
      thisAppSubscribed: apps.some((app) => app.isThisApp),
      apps,
      phoneNumbers,
      channelCheck,
      outcome,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * debug_token com o app token (META_APP_ID|META_APP_SECRET), montado só
   * aqui no servidor. Aceita token de usuário (temporário do painel do app ou
   * do Graph API Explorer) e de system user.
   */
  private async validateToken(
    input: Ctx,
    appId: string,
    appSecret: string,
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
          messages.appCredentialsRejected,
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
  ): Promise<MetaCloudWabaSubscribedAppDto[]> {
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
    }
    return apps;
  }

  /** Só POST, sem override_callback_uri; nunca DELETE nem outros apps. */
  private async subscribeThisApp(input: Ctx): Promise<void> {
    const result = await this.graph(
      "POST",
      `/${encodeURIComponent(input.wabaId)}/subscribed_apps`,
      { bearer: input.accessToken, deadline: input.deadline },
    );

    if (result.body.error) {
      throw this.mapGraphError(result.body.error, "subscribe_post");
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
    options: { bearer: string; deadline: number; query?: Record<string, string> },
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
        headers: { Authorization: `Bearer ${options.bearer}` },
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

