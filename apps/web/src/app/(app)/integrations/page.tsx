import type {
  InboundWebhookCapabilitiesDto,
  InboundWebhookChannelDto,
  InboundWebhookConnectionDto,
  InboundWebhookConnectionOverviewDto,
  IntegrationHealthSummaryDto,
  IntegrationPipelineOverviewDto,
  MetaAssetsDto,
  MetaConnectionCapabilitiesDto,
  MetaConnectionDto,
  MetaManualConfigurationDto,
  ProviderConversionRuleDto,
  CurrentWorkspaceDto,
  WhatsappConnectionDto,
  WhatsappWebhookReceiptStatusDto,
} from "@wpptrack/shared";
import {
  metaAssetsSchema,
  whatsappConnectionsSchema,
  whatsappWebhookReceiptStatusSchema,
} from "@wpptrack/shared";
import {
  Activity,
  Database,
  Megaphone,
  MessageCircle,
  Route,
  Webhook,
} from "lucide-react";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SubmitButton } from "../../../components/submit-button";
import { PresentationMask } from "../../../components/presentation-mask";
import { displayTimeZone } from "../../../lib/date-time";
import { serverApiFetch } from "../../../lib/server-api";
import { getCurrentWorkspace } from "../../../lib/current-workspace";
import { MetaConversionDestinationForm } from "./meta-conversion-destination-form";
import {
  createInboundWebhookConnectionAction,
  removeInboundWebhookConnectionAction,
  rotateInboundWebhookSecretAction,
  saveInboundWebhookChannelRoutesAction,
  setInboundWebhookChannelStatusAction,
  setInboundWebhookConnectionStatusAction,
} from "./inbound-webhook-actions";
import {
  InboundWebhookPanel,
  type InboundWebhookConnectionView,
} from "./inbound-webhook-panel";
import {
  createWhatsappConnectionAction,
  rotateWhatsappWebhookTokenAction,
  testWhatsappConnectionAction,
} from "./whatsapp-provider-actions";
import { WhatsappProviderPanel } from "./whatsapp-provider-panel";
import {
  createMetaManualConnectionAction,
  createMetaManualCredentialAction,
  createMetaOAuthAdvancedConnectionAction,
  disconnectMetaOAuthAction,
  discoverMetaManualAssetsAction,
  discoverMetaOAuthAdvancedAssetsAction,
  getMetaManualAdRoutingAction,
  getMetaOAuthAdvancedAdRoutingAction,
  prepareMetaOAuthAdvancedCredentialAction,
  removeMetaManualConnectionAction,
  removeMetaOAuthAdvancedConnectionAction,
  rotateMetaManualCredentialAction,
  setMetaManualAccountDestinationAction,
  setMetaManualAdDestinationAction,
  setMetaManualConnectionStatusAction,
  setMetaOAuthAdvancedAccountDestinationAction,
  setMetaOAuthAdvancedAdDestinationAction,
  setMetaOAuthAdvancedConnectionStatusAction,
  setMetaOAuthAdvancedRoutingAction,
  testMetaManualConnectionAction,
  testMetaOAuthAdvancedConnectionAction,
  syncMetaManualHistoryAction,
} from "./meta-manual-actions";
import { MetaManualConnectionPanel } from "./meta-manual-connection-panel";
import {
  metaAssetsRefreshSucceeded,
  resolveMetaStatus,
} from "./meta-connection-state";
import { MetaReportingAccountsForm } from "./meta-reporting-accounts-form";

type ResourceResult<T> = {
  data: T;
  state: "real" | "empty" | "error";
};

type IntegrationsSearchParams = {
  meta?: string;
  notice?: string;
};

type IntegrationsPageProps = {
  searchParams?: Promise<IntegrationsSearchParams>;
};

type PageNotice = {
  tone: "success" | "warn";
  title: string;
  message: string;
};

type LegacyWhatsappInstance = {
  id: string;
  name: string;
  provider: string;
  billingStatus: string;
  providerInstanceId: string | null;
  checkoutUrl: string | null;
  createdAt: string;
};

async function getHealth(): Promise<
  ResourceResult<IntegrationHealthSummaryDto | null>
> {
  try {
    const health = await serverApiFetch<IntegrationHealthSummaryDto>(
      "/integrations/health",
    );

    return {
      data: health,
      state: health.providers.length > 0 ? "real" : "empty",
    };
  } catch {
    return {
      data: null,
      state: "error",
    };
  }
}

async function getIntegrationPipeline(): Promise<
  ResourceResult<IntegrationPipelineOverviewDto | null>
> {
  try {
    const pipeline = await serverApiFetch<IntegrationPipelineOverviewDto>(
      "/integrations/pipeline",
    );

    return {
      data: pipeline,
      state: pipeline.stages.length > 0 ? "real" : "empty",
    };
  } catch {
    return {
      data: null,
      state: "error",
    };
  }
}

async function getCurrentWorkspaceResource(): Promise<
  ResourceResult<CurrentWorkspaceDto | null>
> {
  try {
    return {
      data: await getCurrentWorkspace(),
      state: "real",
    };
  } catch {
    return {
      data: null,
      state: "error",
    };
  }
}

async function getMetaConnection(): Promise<
  ResourceResult<MetaConnectionDto | null>
> {
  try {
    return {
      data: await serverApiFetch<MetaConnectionDto>(
        "/integrations/meta/connection",
      ),
      state: "real",
    };
  } catch {
    return {
      data: null,
      state: "error",
    };
  }
}

async function getMetaAssets(): Promise<ResourceResult<MetaAssetsDto | null>> {
  try {
    const response = await serverApiFetch<unknown>("/integrations/meta/assets");
    const parsed = metaAssetsSchema.safeParse(response);

    if (!parsed.success) {
      return { data: null, state: "error" };
    }

    return {
      data: parsed.data,
      state: "real",
    };
  } catch {
    return {
      data: null,
      state: "error",
    };
  }
}

async function getLegacyWhatsappInstances(): Promise<
  ResourceResult<LegacyWhatsappInstance[]>
> {
  try {
    const instances = await serverApiFetch<LegacyWhatsappInstance[]>(
      "/integrations/whatsapp/instances",
    );
    return {
      data: instances,
      state: instances.length > 0 ? "real" : "empty",
    };
  } catch {
    return { data: [], state: "error" };
  }
}

async function getMetaCapabilities(): Promise<
  ResourceResult<MetaConnectionCapabilitiesDto>
> {
  try {
    return {
      data: await serverApiFetch<MetaConnectionCapabilitiesDto>(
        "/integrations/meta/capabilities",
      ),
      state: "real",
    };
  } catch {
    return {
      data: {
        enabledModes: [],
        oauthEnabled: false,
        manualEnabled: false,
      },
      state: "error",
    };
  }
}

async function getMetaManualConfiguration(): Promise<
  ResourceResult<MetaManualConfigurationDto | null>
> {
  try {
    return {
      data: await serverApiFetch<MetaManualConfigurationDto>(
        "/integrations/meta/manual",
      ),
      state: "real",
    };
  } catch {
    return { data: null, state: "error" };
  }
}

async function getMetaOAuthAdvancedConfiguration(): Promise<
  ResourceResult<MetaManualConfigurationDto | null>
> {
  try {
    return {
      data: await serverApiFetch<MetaManualConfigurationDto>(
        "/integrations/meta/oauth/advanced",
      ),
      state: "real",
    };
  } catch {
    return { data: null, state: "error" };
  }
}

type InboundWebhookPageData = {
  capabilities: InboundWebhookCapabilitiesDto;
  connections: InboundWebhookConnectionView[];
  providerRules: ProviderConversionRuleDto[];
  providerRulesEnabled: boolean;
};

async function getInboundWebhookData(): Promise<
  ResourceResult<InboundWebhookPageData | null>
> {
  try {
    const [capabilities, connections, providerRulesResult] = await Promise.all([
      serverApiFetch<InboundWebhookCapabilitiesDto>(
        "/integrations/inbound-webhooks/capabilities",
      ),
      serverApiFetch<InboundWebhookConnectionDto[]>(
        "/integrations/inbound-webhooks",
      ),
      serverApiFetch<ProviderConversionRuleDto[]>(
        "/conversion-rules/providers",
      ).then(
        (providerRules) => ({ enabled: true as const, providerRules }),
        () => ({ enabled: false as const, providerRules: [] }),
      ),
    ]);
    let detailError = false;
    const views = await Promise.all(
      connections.map(async (connection) => {
        const [overviewResult, channelsResult] = await Promise.allSettled([
          serverApiFetch<InboundWebhookConnectionOverviewDto>(
            `/integrations/inbound-webhooks/${encodeURIComponent(connection.id)}/overview`,
          ),
          serverApiFetch<InboundWebhookChannelDto[]>(
            `/integrations/inbound-webhooks/${encodeURIComponent(connection.id)}/channels`,
          ),
        ]);

        if (
          overviewResult.status === "rejected" ||
          channelsResult.status === "rejected"
        ) {
          detailError = true;
        }

        return {
          overview:
            overviewResult.status === "fulfilled"
              ? overviewResult.value
              : {
                  connection,
                  counters: {
                    eligibleRouted: 0,
                    eligibleUnresolved: 0,
                    ignoredNoCtwa: 0,
                    duplicate: 0,
                    invalid: 0,
                  },
                },
          channels:
            channelsResult.status === "fulfilled" ? channelsResult.value : [],
          detailState:
            overviewResult.status === "fulfilled" &&
            channelsResult.status === "fulfilled"
              ? ("real" as const)
              : ("error" as const),
        };
      }),
    );

    return {
      data: {
        capabilities,
        connections: views,
        providerRules: providerRulesResult.providerRules,
        providerRulesEnabled: providerRulesResult.enabled,
      },
      state: detailError ? "error" : connections.length > 0 ? "real" : "empty",
    };
  } catch {
    return {
      data: null,
      state: "error",
    };
  }
}

async function getWhatsappConnections(): Promise<
  ResourceResult<WhatsappConnectionDto[]>
> {
  try {
    const connections = await serverApiFetch<unknown>(
      "/integrations/whatsapp-connections",
    );
    const parsed = whatsappConnectionsSchema.safeParse(connections);
    if (!parsed.success) {
      return { data: [], state: "error" };
    }
    return {
      data: parsed.data,
      state: "real",
    };
  } catch {
    return { data: [], state: "error" };
  }
}

async function getWhatsappWebhookReceiptStatus(): Promise<
  ResourceResult<WhatsappWebhookReceiptStatusDto | null>
> {
  try {
    const status = await serverApiFetch<unknown>(
      "/integrations/whatsapp/webhook-status",
    );
    const parsed = whatsappWebhookReceiptStatusSchema.safeParse(status);
    if (!parsed.success) {
      return { data: null, state: "error" };
    }
    return {
      data: parsed.data,
      state: parsed.data.hasReceipts ? "real" : "empty",
    };
  } catch {
    return { data: null, state: "error" };
  }
}

async function refreshMetaAssets(formData: FormData) {
  "use server";

  const businessId = nullableFormText(formData, "businessId");
  let target = "/integrations?notice=meta-assets-refresh-error";

  try {
    const assets = await serverApiFetch<MetaAssetsDto>(
      "/integrations/meta/assets/refresh",
      {
        method: "POST",
        body: JSON.stringify({ businessId }),
      },
    );

    if (!metaAssetsRefreshSucceeded(assets)) {
      throw new Error("MetaAssetsRefreshNotConnected");
    }

    revalidatePath("/integrations");
    target = "/integrations?notice=meta-assets-refreshed";
  } catch {
    target = "/integrations?notice=meta-assets-refresh-error";
  }

  redirect(target);
}

async function saveMetaConversionDestination(formData: FormData) {
  "use server";

  const businessId = formText(formData, "businessId");
  const pixelId = formText(formData, "pixelId");
  const pixelName = formText(formData, "pixelName");
  const pageId = formText(formData, "pageId");
  const pageName = formText(formData, "pageName");

  if (!businessId || !pixelId || !pixelName || !pageId || !pageName) {
    redirect("/integrations?notice=meta-destination-missing");
  }

  let target = "/integrations?notice=meta-destination-error";

  try {
    await serverApiFetch("/integrations/meta/conversion-destination", {
      method: "PUT",
      body: JSON.stringify({
        pixelId,
        pixelName,
        pageId,
        pageName,
      }),
    });
    revalidatePath("/integrations");
    target = "/integrations?notice=meta-destination-saved";
  } catch {
    target = "/integrations?notice=meta-destination-error";
  }

  redirect(target);
}

async function loadMetaBusinessDestinationAssets(
  businessId: string,
): Promise<Pick<MetaAssetsDto, "pixels" | "pages">> {
  "use server";

  const normalizedBusinessId = businessId.trim();

  if (!normalizedBusinessId) {
    return { pixels: [], pages: [] };
  }

  try {
    const assets = await serverApiFetch<MetaAssetsDto>(
      "/integrations/meta/assets/refresh",
      {
        method: "POST",
        body: JSON.stringify({ businessId: normalizedBusinessId }),
      },
    );
    return {
      pixels: assets.pixels,
      pages: assets.pages ?? [],
    };
  } catch {
    return { pixels: [], pages: [] };
  }
}

async function saveMetaReportingAccount(formData: FormData) {
  "use server";

  const businessId = formText(formData, "businessId");
  const businessName = formText(formData, "businessName");
  const adAccountId = formText(formData, "adAccountId");
  const adAccountName = formText(formData, "adAccountName");
  const currency = nullableFormText(formData, "currency");
  const timezoneName = nullableFormText(formData, "timezoneName");

  if (!businessId || !businessName || !adAccountId || !adAccountName) {
    redirect("/integrations?notice=meta-reporting-missing");
  }

  let target = "/integrations?notice=meta-reporting-error";

  try {
    await serverApiFetch("/integrations/meta/reporting-accounts", {
      method: "POST",
      body: JSON.stringify({
        businessId,
        businessName,
        adAccountId,
        adAccountName,
        currency,
        timezoneName,
      }),
    });
    revalidatePath("/integrations");
    target = "/integrations?notice=meta-reporting-saved";
  } catch {
    target = "/integrations?notice=meta-reporting-error";
  }

  redirect(target);
}

async function loadMetaBusinessReportingAssets(
  businessId: string,
): Promise<Pick<MetaAssetsDto, "adAccounts">> {
  "use server";

  const normalizedBusinessId = businessId.trim();

  if (!normalizedBusinessId) {
    return { adAccounts: [] };
  }

  try {
    const assets = await serverApiFetch<MetaAssetsDto>(
      "/integrations/meta/assets/refresh",
      {
        method: "POST",
        body: JSON.stringify({ businessId: normalizedBusinessId }),
      },
    );
    return {
      adAccounts: assets.adAccounts,
    };
  } catch {
    return { adAccounts: [] };
  }
}

async function setMetaReportingAccountStatus(formData: FormData) {
  "use server";

  const id = formText(formData, "id");
  const active = formText(formData, "active") === "true";

  if (!id) {
    redirect("/integrations?notice=meta-reporting-status-error");
  }

  let target = "/integrations?notice=meta-reporting-status-error";

  try {
    await serverApiFetch(
      `/integrations/meta/reporting-accounts/${encodeURIComponent(id)}/status`,
      {
        method: "PUT",
        body: JSON.stringify({ active }),
      },
    );
    revalidatePath("/integrations");
    target = "/integrations?notice=meta-reporting-status-saved";
  } catch {
    target = "/integrations?notice=meta-reporting-status-error";
  }

  redirect(target);
}

function money(cents: number | null | undefined) {
  if (!cents) {
    return "Aguardando preco";
  }

  return (cents / 100).toLocaleString("pt-BR", {
    currency: "BRL",
    style: "currency",
  });
}

function providerTitle(provider: string) {
  const titles: Record<string, string> = {
    // F5.2: health summary now reports the WhatsappProviderRegistry id
    // "uazapi_byo" instead of "uazapi" — keep the old key too in case an
    // older API build is still serving traffic during a rolling deploy.
    uazapi_byo: "WhatsApp (Uazapi BYO)",
    nod_api: "WhatsApp (NOD API / PalmUP)",
    waha: "WhatsApp (WAHA)",
    zapi: "WhatsApp (Z-API)",
    uazapi: "WhatsApp / NOD API",
    meta: "Meta OAuth",
    asaas: "Asaas",
  };

  return titles[provider] ?? "Provedor desconhecido";
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    connected: "Configurado",
    disconnected: "Configurar",
    not_connected: "Nao conectado",
    error: "Erro",
    pending_payment: "Pagamento pendente",
    active: "Ativa",
    needs_reconnect: "Reconectar",
    not_configured: "Nao configurado",
    pending: "Aguardando",
    qr_required: "QR pendente",
    syncing: "Sincronizando",
    completed: "Sincronizado",
    failed: "Falha na sincronizacao",
    configured: "Configurado",
    needs_configuration: "Configurar",
  };

  return labels[status] ?? "Status desconhecido";
}

function sourceSyncLabel(value: string | null | undefined) {
  if (!value) {
    return "Aguardando primeira sincronizacao";
  }

  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: displayTimeZone,
  });
}

function formText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function nullableFormText(formData: FormData, key: string): string | null {
  const value = formText(formData, key);

  return value || null;
}

function integrationsNotice(
  searchParams: IntegrationsSearchParams,
): PageNotice | null {
  const notice = searchParams.notice;
  const meta = searchParams.meta;

  if (meta === "connected") {
    return {
      tone: "success",
      title: "Meta conectada",
      message:
        "A conexao foi salva. Selecione BM, Pixel, pagina e contas de relatorio.",
    };
  }

  if (meta === "error") {
    return {
      tone: "warn",
      title: "Falha ao conectar Meta",
      message:
        "Tente conectar novamente ou revise o retorno do OAuth no diagnostico.",
    };
  }

  const notices: Record<string, PageNotice> = {
    "meta-destination-saved": {
      tone: "success",
      title: "Destino salvo",
      message:
        "Pixel e pagina principal foram salvos para o envio de conversoes.",
    },
    "meta-destination-error": {
      tone: "warn",
      title: "Destino nao salvo",
      message: "Nao foi possivel salvar Pixel e pagina agora. Tente novamente.",
    },
    "meta-destination-missing": {
      tone: "warn",
      title: "Destino incompleto",
      message: "Selecione BM, Pixel e pagina antes de salvar.",
    },
    "meta-assets-refreshed": {
      tone: "success",
      title: "Ativos Meta atualizados",
      message:
        "BMs, contas, Pixels e paginas foram salvos para carregamento rapido.",
    },
    "meta-assets-refresh-error": {
      tone: "warn",
      title: "Ativos nao atualizados",
      message:
        "Nao foi possivel sincronizar ativos Meta agora. Tente novamente.",
    },
    "meta-reporting-saved": {
      tone: "success",
      title: "Conta adicionada",
      message: "A conta de anuncio foi adicionada aos relatorios.",
    },
    "meta-reporting-error": {
      tone: "warn",
      title: "Conta nao adicionada",
      message: "Nao foi possivel adicionar a conta aos relatorios agora.",
    },
    "meta-reporting-missing": {
      tone: "warn",
      title: "Conta incompleta",
      message: "Selecione BM e conta de anuncio antes de adicionar.",
    },
    "meta-reporting-status-saved": {
      tone: "success",
      title: "Status atualizado",
      message: "A conta de anuncio foi atualizada nos relatorios.",
    },
    "meta-reporting-status-error": {
      tone: "warn",
      title: "Status nao atualizado",
      message: "Nao foi possivel alterar o status da conta agora.",
    },
    "whatsapp-connect-requested": {
      tone: "success",
      title: "Conexao solicitada",
      message: "A solicitacao de conexao do WhatsApp foi enviada ao provedor.",
    },
    "whatsapp-connect-error": {
      tone: "warn",
      title: "Conexao nao iniciada",
      message: "Nao foi possivel solicitar a conexao do WhatsApp agora.",
    },
    "whatsapp-checkout-missing": {
      tone: "warn",
      title: "Instancia sem nome",
      message: "Informe um nome para gerar a cobranca da instancia.",
    },
    "whatsapp-checkout-created": {
      tone: "success",
      title: "Cobranca criada",
      message: "A instancia foi criada como pendente de pagamento.",
    },
    "whatsapp-checkout-error": {
      tone: "warn",
      title: "Cobranca nao criada",
      message: "Nao foi possivel gerar a cobranca da instancia agora.",
    },
  };

  return notice ? (notices[notice] ?? null) : null;
}

function metaConnectionTitle(
  status?: MetaAssetsDto["status"] | MetaConnectionDto["status"],
) {
  if (status === "connected") {
    return "Meta conectado";
  }

  if (status === "needs_reconnect") {
    return "Meta precisa reconectar";
  }

  if (status === "error") {
    return "Meta com erro";
  }

  if (status && status !== "not_connected") {
    return "Meta com status desconhecido";
  }

  return "Meta nao conectado";
}

function metaAssetsDetail(
  metaAssets: MetaAssetsDto | null,
  state: ResourceResult<MetaAssetsDto | null>["state"],
) {
  if (!metaAssets) {
    return state === "error"
      ? "Nao foi possivel ler os ativos Meta agora."
      : "Conecte a conta Meta para carregar os ativos.";
  }

  if (metaAssets.status === "not_connected") {
    return "Conecte a conta Meta para carregar BMs, contas de anuncio e Pixels.";
  }

  if (metaAssets.syncError) {
    return metaAssets.syncError;
  }

  if (
    metaAssets.lastSyncedAt &&
    metaAssets.status === "connected" &&
    metaAssets.businesses.length === 0
  ) {
    return "A Meta nao retornou nenhum BM para este usuario. Confirme o acesso ao Business Manager e conecte novamente.";
  }

  if (
    metaAssets.lastSyncedAt &&
    metaAssets.businesses.length > 0 &&
    metaAssets.adAccounts.length === 0 &&
    metaAssets.pixels.length === 0 &&
    (metaAssets.pages ?? []).length === 0
  ) {
    return "Os BMs foram carregados, mas o BM selecionado nao retornou conta de anuncio, Pixel ou Pagina. Selecione outro BM ou revise as permissoes Meta.";
  }

  if (
    metaAssets.businesses.length === 0 &&
    metaAssets.adAccounts.length === 0 &&
    metaAssets.pixels.length === 0
  ) {
    return "Conta conectada. Clique em Atualizar ativos Meta para buscar BMs, contas, Pixels e paginas.";
  }

  return "Ativos disponiveis para selecionar no proximo passo do fluxo operacional.";
}

function metaLastSyncedAt(metaAssets: MetaAssetsDto | null) {
  if (!metaAssets?.lastSyncedAt) {
    return "Ativos ainda nao sincronizados neste workspace.";
  }

  return `Ativos atualizados em ${new Date(
    metaAssets.lastSyncedAt,
  ).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  })}.`;
}

function pipelineWidth(value: number, maxValue: number) {
  if (maxValue <= 0 || value <= 0) {
    return "0%";
  }

  return `${Math.max(8, Math.round((value / maxValue) * 100))}%`;
}

export default async function IntegrationsPage({
  searchParams,
}: IntegrationsPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const pageNotice = integrationsNotice(resolvedSearchParams);
  const [
    healthResult,
    metaConnectionResult,
    metaAssetsResult,
    pipelineResult,
    workspaceResult,
    metaCapabilitiesResult,
  ] = await Promise.all([
    getHealth(),
    getMetaConnection(),
    getMetaAssets(),
    getIntegrationPipeline(),
    getCurrentWorkspaceResource(),
    getMetaCapabilities(),
  ]);
  const usesExternalWhatsapp =
    pipelineResult.data?.whatsappSource?.mode === "external";
  const health = healthResult.data;
  const metaConnection = metaConnectionResult.data;
  const metaAssets = metaAssetsResult.data;
  const metaCapabilities = metaCapabilitiesResult.data;
  const legacyMetaConnected = metaConnection?.status === "connected";
  const oauthEnabled =
    metaCapabilitiesResult.state === "real" && metaCapabilities.oauthEnabled;
  const manualEnabled =
    metaCapabilitiesResult.state === "real" && metaCapabilities.manualEnabled;
  const oauthConnected = legacyMetaConnected && oauthEnabled;
  const metaManualResult =
    oauthConnected
      ? await getMetaOAuthAdvancedConfiguration()
      : manualEnabled
        ? await getMetaManualConfiguration()
        : ({ data: null, state: "empty" } as const);
  const inboundWebhookResult = await getInboundWebhookData();
  const whatsappConnectionsResult = await getWhatsappConnections();
  const whatsappWebhookReceiptStatusResult =
    await getWhatsappWebhookReceiptStatus();
  const legacyWhatsappInstancesResult = await getLegacyWhatsappInstances();
  const inboundWebhookData = inboundWebhookResult.data;
  const pipeline = pipelineResult.data;
  const workspace = workspaceResult.data;
  const isPlatformOperator = Boolean(workspace?.platformRole);
  const workspacePermissionsUnavailable = workspaceResult.state === "error";
  const canManageIntegrations = Boolean(
    workspace?.permissions?.canManageIntegrations,
  );
  const maxPipelineValue = Math.max(
    ...(pipeline?.stages ?? []).map((stage) => stage.value),
    0,
  );
  const hasIntegrationError = [
    healthResult.state,
    metaConnectionResult.state,
    metaAssetsResult.state,
    pipelineResult.state,
    workspaceResult.state,
    metaCapabilitiesResult.state,
    ...(oauthConnected || manualEnabled
      ? [metaManualResult.state]
      : []),
    ...(inboundWebhookData?.capabilities.enabled
      ? [inboundWebhookResult.state]
      : []),
    whatsappWebhookReceiptStatusResult.state,
  ].includes("error");
  const metaStatus = resolveMetaStatus(
    metaConnection?.status,
    metaAssets?.status,
  );
  const activeReportingAccounts = (metaAssets?.reportingAccounts ?? []).filter(
    (account) => account.active,
  ).length;
  const manualActiveConnections =
    metaManualResult.data?.businessConnections.filter(
      (connection) => connection.status === "active",
    ).length ?? 0;
  const manualActiveReportingAccounts =
    metaManualResult.data?.reportingAccounts.filter((account) => account.active)
      .length ?? 0;
  const manualConfigured = manualActiveConnections > 0;
  const oauthAdvancedEnabled = Boolean(
    oauthConnected && metaManualResult.data?.advancedRoutingEnabled,
  );
  const metaRefreshBusinessId =
    metaAssets?.selection?.businessId &&
    metaAssets.businesses.some(
      (business) => business.id === metaAssets.selection?.businessId,
    )
      ? metaAssets.selection.businessId
      : (metaAssets?.businesses?.[0]?.id ?? "");
  const integrations =
    health?.providers.map((item) => ({
      title: providerTitle(item.provider),
      status: statusLabel(item.status),
      tone: item.status === "connected" ? "" : "warn",
      description:
        item.message ??
        "Credenciais encontradas. Proxima etapa depende do fluxo operacional do provedor.",
      detail: `Verificado em ${new Date(item.checkedAt).toLocaleTimeString(
        "pt-BR",
        {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: displayTimeZone,
        },
      )}`,
    })) ?? [];
  const metaStatusLabel =
    metaAssetsResult.state === "error" && metaConnectionResult.state === "error"
      ? "API indisponivel"
      : manualConfigured && metaManualResult.data?.connectionMode === "manual"
        ? "Conectado por token"
        : oauthAdvancedEnabled
          ? "OAuth com destinos por BM"
          : metaStatus
            ? statusLabel(metaStatus)
            : "Meta nao conectado";
  const metaDestinationCount = manualConfigured
    ? (metaManualResult.data?.destinations.filter(
        (destination) => destination.status === "configured",
      ).length ?? 0)
    : metaAssets?.conversionDestination
      ? 1
      : 0;
  const inboundConnectionCount =
    inboundWebhookData?.connections.filter(
      ({ overview }) => overview.connection.status !== "paused",
    ).length ?? 0;
  const legacyWhatsappInstances = legacyWhatsappInstancesResult.data;
  const whatsappSourceLabel = usesExternalWhatsapp
    ? "MySQL externo"
    : inboundConnectionCount > 0
      ? `${inboundConnectionCount} webhook${inboundConnectionCount === 1 ? "" : "s"}`
      : "Aguardando fonte";
  const whatsappSourceDetail = usesExternalWhatsapp
    ? "Leitura incremental configurada"
    : inboundConnectionCount > 0
      ? "Plataformas WhatsApp em observacao"
      : "Nenhuma origem ativa";
  const finalPipelineStage = pipeline?.stages.at(-1);

  return (
    <section className="page-stack page-standard integrations-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Integracoes</span>
          <h1>Central de integracoes</h1>
          <p>
            {usesExternalWhatsapp
              ? "Acompanhe a origem das conversas, as contas Meta e o caminho dos eventos deste workspace."
              : "Configure Meta, fontes WhatsApp e o destino das conversoes em um unico fluxo operacional."}
          </p>
        </div>
        {isPlatformOperator ? (
          <div className="header-actions">
            <span
              className={`status-chip${hasIntegrationError ? " warn" : ""}`}
            >
              {hasIntegrationError ? "API indisponivel" : "API conectada"}
            </span>
            <span className="status-chip">
              {integrations.length} provedores
            </span>
          </div>
        ) : null}
      </header>

      {pageNotice ? (
        <div className={`feedback-banner ${pageNotice.tone}`} role="status">
          <strong>{pageNotice.title}</strong>
          <span>{pageNotice.message}</span>
        </div>
      ) : null}

      {workspacePermissionsUnavailable ? (
        <div className="feedback-banner warn" role="alert">
          <strong>Permissoes temporariamente indisponiveis</strong>
          <span>
            Nao foi possivel confirmar as permissoes agora. A API validara a
            acao ao continuar.
          </span>
          <a className="button" href="/integrations">
            Tentar novamente
          </a>
        </div>
      ) : null}

      <section
        className="integration-overview"
        aria-labelledby="integration-overview-title"
      >
        <div className="integration-overview-heading">
          <div>
            <span className="eyebrow">Estado do workspace</span>
            <h2 id="integration-overview-title">Mapa das conexoes</h2>
          </div>
          <span className={`status-chip${hasIntegrationError ? " warn" : ""}`}>
            {hasIntegrationError ? "Requer atencao" : "Operacao disponivel"}
          </span>
        </div>
        <div className="integration-overview-rail">
          <article>
            <span className="integration-overview-icon meta" aria-hidden="true">
              <Megaphone size={18} />
            </span>
            <div>
              <span className="micro-label">Meta Ads</span>
              <strong>{metaStatusLabel}</strong>
              <small>
                {manualConfigured
                  ? `${manualActiveReportingAccounts} contas em relatorios`
                  : `${activeReportingAccounts} contas em relatorios`}
              </small>
            </div>
          </article>
          <article>
            <span
              className="integration-overview-icon whatsapp"
              aria-hidden="true"
            >
              <MessageCircle size={18} />
            </span>
            <div>
              <span className="micro-label">Fonte WhatsApp</span>
              <strong>{whatsappSourceLabel}</strong>
              <small>{whatsappSourceDetail}</small>
            </div>
          </article>
          <article>
            <span className="integration-overview-icon capi" aria-hidden="true">
              <Database size={18} />
            </span>
            <div>
              <span className="micro-label">Destino CAPI</span>
              <strong>
                {metaDestinationCount > 0
                  ? `${metaDestinationCount} configurado${metaDestinationCount === 1 ? "" : "s"}`
                  : "Nao configurado"}
              </strong>
              <small>Pixel e Pagina por rota Meta</small>
            </div>
          </article>
          <article>
            <span
              className="integration-overview-icon signal"
              aria-hidden="true"
            >
              <Activity size={18} />
            </span>
            <div>
              <span className="micro-label">Ultima etapa</span>
              <strong>
                {finalPipelineStage
                  ? `${finalPipelineStage.value} ${finalPipelineStage.label}`
                  : "Aguardando sinal"}
              </strong>
              <small>
                {pipeline?.rangeLabel ?? "Pipeline ainda sem eventos"}
              </small>
            </div>
          </article>
        </div>
      </section>

      <nav
        className="integration-domain-nav"
        aria-label="Atalhos das integracoes"
      >
        <a href="#integracao-meta">
          <Megaphone size={16} aria-hidden="true" />
          Meta Ads
        </a>
        <a href="#integracao-whatsapp">
          <Webhook size={16} aria-hidden="true" />
          Fontes WhatsApp
        </a>
        <a href="#integracao-fluxo">
          <Route size={16} aria-hidden="true" />
          Fluxo de dados
        </a>
      </nav>

      {isPlatformOperator ? (
        <details className="integration-technical-health">
          <summary>
            <span>
              <Activity size={17} aria-hidden="true" />
              Saude tecnica dos provedores
            </span>
            <small>{integrations.length} provedores monitorados</small>
          </summary>
          <div className="integration-grid">
            {integrations.length > 0 ? (
              integrations.map((item) => (
                <article className="integration-card" key={item.title}>
                  <span
                    className={`status-chip${item.tone ? ` ${item.tone}` : ""}`}
                  >
                    {item.status}
                  </span>
                  <div>
                    <span className="micro-label">{item.title}</span>
                    <strong>{item.detail}</strong>
                  </div>
                  <p className="muted">{item.description}</p>
                  <button className="button" type="button">
                    Ver diagnostico
                  </button>
                </article>
              ))
            ) : (
              <article className="integration-card">
                <span className="status-chip warn">
                  {healthResult.state === "error"
                    ? "API indisponivel"
                    : "Sem provedores"}
                </span>
                <div>
                  <span className="micro-label">Integracoes</span>
                  <strong>
                    {healthResult.state === "error"
                      ? "Nao foi possivel carregar integracoes"
                      : "Nenhuma integracao retornada"}
                  </strong>
                </div>
                <p className="muted">
                  A lista sera preenchida somente com provedores retornados pelo
                  backend.
                </p>
              </article>
            )}
          </div>
        </details>
      ) : null}

      <section
        className="integration-domain-section integration-meta-domain"
        id="integracao-meta"
        aria-labelledby="integration-meta-title"
      >
        <header className="integration-domain-heading">
          <span className="integration-domain-number">01</span>
          <div>
            <span className="eyebrow">Aquisicao e conversao</span>
            <h2 id="integration-meta-title">Meta Ads</h2>
            <p>
              Autorize a estrutura anunciante, escolha as contas dos relatorios
              e vincule cada rota ao Pixel e a Pagina corretos.
            </p>
          </div>
          <span className="status-chip">{metaStatusLabel}</span>
        </header>

        <div className="integration-domain-content">
          {oauthEnabled ? (
            <div className="connection-callout integration-meta-oauth">
              <div>
                <span className="micro-label">Login social Facebook</span>
                <strong>
                  {metaStatus === "not_connected"
                    ? "Conectar conta Meta"
                    : metaConnectionTitle(metaStatus)}
                </strong>
                <p className="muted">
                  Use o OAuth oficial para autorizar BM, contas de anuncio e
                  Pixels. O token nasce no backend e fica criptografado.
                </p>
              </div>
              {canManageIntegrations || workspacePermissionsUnavailable ? (
                <div className="meta-connection-actions">
                  {canManageIntegrations ? (
                    <form action={refreshMetaAssets}>
                      <input
                        type="hidden"
                        name="businessId"
                        value={metaRefreshBusinessId}
                      />
                      <SubmitButton
                        disabled={metaStatus !== "connected"}
                        pendingLabel="Atualizando..."
                        statusText="Buscando ativos no Meta e salvando snapshot."
                      >
                        Atualizar ativos Meta
                      </SubmitButton>
                    </form>
                  ) : (
                    <span className="action-note warn">
                      Permissoes temporariamente indisponiveis. A API validara
                      a acao ao continuar.
                    </span>
                  )}
                </div>
              ) : (
                <span className="event-chip warn">
                  {workspacePermissionsUnavailable
                    ? "permissoes indisponiveis"
                    : "sem permissao"}
                </span>
              )}
            </div>
          ) : manualEnabled ? (
            <div className="connection-callout integration-meta-manual">
              <div>
                <span className="micro-label">Conexao manual Meta</span>
                <strong>Configure a estrutura Meta manualmente</strong>
                <p className="muted">
                  Use o App ID e o token permanente do usuario do sistema.
                  Depois informe manualmente o BM, Pixel, Pagina e conta de
                  anuncios.
                </p>
              </div>
            </div>
          ) : (
            <div className="connection-callout integration-meta-unavailable">
              <div>
                <span className="micro-label">Configuracao Meta indisponivel</span>
                <strong>Nao foi possivel confirmar os modos de conexao</strong>
                <p className="muted">
                  Tente novamente quando a configuracao da Meta estiver
                  disponivel.
                </p>
              </div>
            </div>
          )}
          {legacyMetaConnected && workspacePermissionsUnavailable ? (
            <div className="connection-callout">
              <div>
                <span className="micro-label">Conta Meta</span>
                <strong>Trocar conta Meta</strong>
                <p className="muted">
                  Aguarde a confirmacao das permissoes para trocar a conta. A
                  API validara a acao antes de qualquer alteracao.
                </p>
              </div>
            </div>
          ) : null}
          <MetaManualConnectionPanel
            workspaceId={metaConnection?.workspaceId ?? workspace?.id ?? ""}
            capabilities={metaCapabilities}
            initialConfiguration={metaManualResult.data}
            legacyConnected={oauthConnected}
            canManage={canManageIntegrations}
            disconnectOAuthAction={disconnectMetaOAuthAction}
            prepareOAuthCredentialAction={
              prepareMetaOAuthAdvancedCredentialAction
            }
            createCredentialAction={createMetaManualCredentialAction}
            discoverAssetsAction={
              oauthConnected
                ? discoverMetaOAuthAdvancedAssetsAction
                : discoverMetaManualAssetsAction
            }
            createConnectionAction={
              oauthConnected
                ? createMetaOAuthAdvancedConnectionAction
                : createMetaManualConnectionAction
            }
            rotateCredentialAction={rotateMetaManualCredentialAction}
            setConnectionStatusAction={
              oauthConnected
                ? setMetaOAuthAdvancedConnectionStatusAction
                : setMetaManualConnectionStatusAction
            }
            testConnectionAction={
              oauthConnected
                ? testMetaOAuthAdvancedConnectionAction
                : testMetaManualConnectionAction
            }
            removeConnectionAction={
              oauthConnected
                ? removeMetaOAuthAdvancedConnectionAction
                : removeMetaManualConnectionAction
            }
            syncHistoryAction={syncMetaManualHistoryAction}
            setAccountDestinationAction={
              oauthConnected
                ? setMetaOAuthAdvancedAccountDestinationAction
                : setMetaManualAccountDestinationAction
            }
            loadAdRoutingAction={
              oauthConnected
                ? getMetaOAuthAdvancedAdRoutingAction
                : getMetaManualAdRoutingAction
            }
            setAdDestinationAction={
              oauthConnected
                ? setMetaOAuthAdvancedAdDestinationAction
                : setMetaManualAdDestinationAction
            }
            setOAuthRoutingAction={setMetaOAuthAdvancedRoutingAction}
          />
          <div className="metric-grid compact integration-meta-metrics">
            <div className="metric-card">
              <span className="micro-label">Status</span>
              <strong>{metaStatusLabel}</strong>
            </div>
            <div className="metric-card">
              <span className="micro-label">Destino CAPI</span>
              <strong>
                {manualConfigured &&
                metaManualResult.data?.connectionMode === "manual"
                  ? `${metaManualResult.data?.destinations.length ?? 0} configurado(s)`
                  : oauthAdvancedEnabled
                    ? `${metaManualResult.data?.destinations.length ?? 0} por BM`
                    : metaAssets?.conversionDestination
                      ? statusLabel(metaAssets.conversionDestination.status)
                      : "Nao configurado"}
              </strong>
            </div>
            <div className="metric-card">
              <span className="micro-label">Contas em relatorios</span>
              <strong>
                {manualConfigured
                  ? manualActiveReportingAccounts
                  : activeReportingAccounts}
              </strong>
            </div>
          </div>
          {!manualConfigured ? (
            <>
              <p className="muted">
                {metaAssetsDetail(metaAssets, metaAssetsResult.state)}
              </p>
              <p className="muted">{metaLastSyncedAt(metaAssets)}</p>
            </>
          ) : null}
          {metaAssets &&
          (oauthConnected ||
            (!manualEnabled && metaCapabilitiesResult.state !== "error")) ? (
            <>
              <div className="meta-config-section">
                <div>
                  <span className="eyebrow">
                    {oauthAdvancedEnabled
                      ? "Rota de retorno"
                      : "Destino de conversao"}
                  </span>
                  <h2>
                    {oauthAdvancedEnabled
                      ? "Pixel e Pagina do destino principal"
                      : "Pixel e Pagina Facebook principal"}
                  </h2>
                </div>
                <div className="metric-grid compact">
                  <div className="metric-card">
                    <span className="micro-label">Pixel CAPI</span>
                    <strong>
                      <PresentationMask placeholder="Pixel oculto">
                        {metaAssets.conversionDestination?.pixelName ??
                          "Sem Pixel"}
                      </PresentationMask>
                    </strong>
                  </div>
                  <div className="metric-card">
                    <span className="micro-label">
                      Pagina Facebook principal
                    </span>
                    <strong>
                      <PresentationMask placeholder="Pagina oculta">
                        {metaAssets.conversionDestination?.pageName ??
                          "Sem Pagina"}
                      </PresentationMask>
                    </strong>
                  </div>
                  <div className="metric-card">
                    <span className="micro-label">Status destino</span>
                    <strong>
                      {metaAssets.conversionDestination
                        ? statusLabel(metaAssets.conversionDestination.status)
                        : "Nao configurado"}
                    </strong>
                  </div>
                </div>
                {canManageIntegrations && !oauthAdvancedEnabled ? (
                  <MetaConversionDestinationForm
                    assets={metaAssets}
                    action={saveMetaConversionDestination}
                    loadBusinessAssetsAction={loadMetaBusinessDestinationAssets}
                  />
                ) : !oauthAdvancedEnabled ? (
                  <p className="muted">
                    {workspacePermissionsUnavailable
                      ? "Nao foi possivel confirmar as permissoes agora."
                      : "Sem permissao para alterar destino Meta"}
                  </p>
                ) : (
                  <p className="muted">
                    O roteamento por BM esta ativo. Este destino volta a ser
                    usado somente ao escolher Usar destino principal.
                  </p>
                )}
              </div>

              {!oauthAdvancedEnabled ? (
                <div className="meta-config-section">
                  <div>
                    <span className="eyebrow">Contas para relatorios</span>
                    <h2>Contas Meta sincronizadas nos relatorios</h2>
                  </div>
                  {canManageIntegrations ? (
                    <MetaReportingAccountsForm
                      assets={metaAssets}
                      action={saveMetaReportingAccount}
                      loadBusinessAssetsAction={loadMetaBusinessReportingAssets}
                      statusAction={setMetaReportingAccountStatus}
                    />
                  ) : (
                    <p className="muted">
                      {workspacePermissionsUnavailable
                        ? "Nao foi possivel confirmar as permissoes agora."
                        : "Sem permissao para alterar contas de relatorio"}
                    </p>
                  )}
                </div>
              ) : null}
            </>
          ) : null}
          <p className="muted integration-domain-note">
            {oauthAdvancedEnabled
              ? "A conexao Meta fica protegida no backend. Cada conta ativa usa o Pixel e a Pagina vinculados a sua BM."
              : "A conexao Meta fica protegida no backend. Esta tela mostra apenas o destino principal e as contas ativas usadas nos relatorios."}
          </p>
        </div>
      </section>

      <section
        className="integration-domain-section integration-whatsapp-domain"
        id="integracao-whatsapp"
        aria-labelledby="integration-whatsapp-title"
      >
        <header className="integration-domain-heading">
          <span className="integration-domain-number">02</span>
          <div>
            <span className="eyebrow">Origem das conversas</span>
            <h2 id="integration-whatsapp-title">Fontes WhatsApp</h2>
            <p>
              Conecte a plataforma que recebe as mensagens e confira a origem
              antes de liberar qualquer evento para o funil.
            </p>
          </div>
          <span className="status-chip">{whatsappSourceLabel}</span>
        </header>

        <div className="integration-domain-content integration-whatsapp-content">
          <WhatsappProviderPanel
            connections={whatsappConnectionsResult.data}
            canManage={canManageIntegrations}
            createAction={createWhatsappConnectionAction}
            testAction={testWhatsappConnectionAction}
            rotateAction={rotateWhatsappWebhookTokenAction}
            webhookStatus={whatsappWebhookReceiptStatusResult.data}
            webhookStatusState={whatsappWebhookReceiptStatusResult.state}
          />

          {inboundWebhookData &&
          (inboundWebhookData.capabilities.enabled ||
            inboundWebhookData.connections.length > 0) ? (
            <InboundWebhookPanel
              capabilities={inboundWebhookData.capabilities}
              connections={inboundWebhookData.connections}
              providerRules={inboundWebhookData.providerRules}
              providerRulesEnabled={inboundWebhookData.providerRulesEnabled}
              metaConfiguration={metaManualResult.data}
              canManage={canManageIntegrations}
              createAction={createInboundWebhookConnectionAction}
              rotateSecretAction={rotateInboundWebhookSecretAction}
              setConnectionStatusAction={
                setInboundWebhookConnectionStatusAction
              }
              removeConnectionAction={removeInboundWebhookConnectionAction}
              setChannelStatusAction={setInboundWebhookChannelStatusAction}
              saveRoutesAction={saveInboundWebhookChannelRoutesAction}
            />
          ) : null}

          {usesExternalWhatsapp ? (
            <div className="surface-panel whatsapp-instance-panel">
              <span className="eyebrow">Integracao externa MySQL</span>
              <h2>Dados recebidos por integracao externa do MySQL</h2>
              <p className="muted">
                Esta fonte e monitorada pelo conector externo; nao ha instancia
                ou cobranca para configurar neste painel.
              </p>
              <div className="metric-grid compact">
                <div className="metric-card">
                  <span className="micro-label">Ultima sincronizacao</span>
                  <strong>
                    {sourceSyncLabel(
                      pipeline?.whatsappSource?.lastSyncCompletedAt,
                    )}
                  </strong>
                </div>
                <div className="metric-card">
                  <span className="micro-label">Status</span>
                  <strong>
                    {statusLabel(
                      pipeline?.whatsappSource?.lastSyncStatus ?? "pending",
                    )}
                  </strong>
                </div>
              </div>
            </div>
          ) : (
            <div className="surface-panel whatsapp-instance-panel">
              <span className="eyebrow">WhatsApp Business</span>
              <h2>Instancia Uazapi (BYO)</h2>
              <p className="muted">
                Esta edicao conecta uma unica instancia Uazapi configurada por
                variavel de ambiente (UAZAPI_BASE_URL/UAZAPI_TOKEN). Nao ha
                marketplace de instancias nem cobranca dentro do painel.
              </p>
              <div className="metric-grid compact">
                <div className="metric-card">
                  <span className="micro-label">Status Uazapi</span>
                  <strong>
                    {statusLabel(
                      health?.providers.find(
                        (item) => item.provider === "uazapi_byo",
                      )?.status ?? "not_configured",
                    )}
                  </strong>
                </div>
                <div className="metric-card">
                  <span className="micro-label">Webhooks recebidos</span>
                  <strong>
                    {inboundConnectionCount > 0
                      ? `${inboundConnectionCount} webhook${inboundConnectionCount === 1 ? "" : "s"}`
                      : "Nenhum webhook ativo"}
                  </strong>
                </div>
              </div>
              {legacyWhatsappInstancesResult.state === "error" ? (
                <p className="muted">Nao foi possivel carregar instancias.</p>
              ) : legacyWhatsappInstances.length > 0 ? (
                <div className="inbound-connection-list">
                  {legacyWhatsappInstances.map((instance) => (
                    <div className="inbound-connection-body" key={instance.id}>
                      <strong>{instance.name}</strong>
                      <span>{instance.providerInstanceId ?? instance.id}</span>
                      <span>{statusLabel(instance.billingStatus)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </section>

      <section
        className="integration-domain-section integration-flow-domain"
        id="integracao-fluxo"
        aria-labelledby="integration-flow-title"
      >
        <header className="integration-domain-heading">
          <span className="integration-domain-number">03</span>
          <div>
            <span className="eyebrow">Pipeline de sinal</span>
            <h2 id="integration-flow-title">
              Do clique no anuncio ao evento enviado
            </h2>
            <p>
              {pipeline
                ? `${pipeline.rangeLabel} com dados reais do workspace.`
                : "Nao foi possivel carregar o pipeline operacional agora."}
            </p>
          </div>
          <span className="status-chip">
            {pipeline?.stages.length
              ? `${pipeline.stages.length} etapas`
              : "Sem eventos"}
          </span>
        </header>
        <div className="integration-domain-content integration-flow-content">
          <p className="muted integration-flow-note">
            {pipeline
              ? `${pipeline.rangeLabel} com dados reais do workspace.`
              : "Nao foi possivel carregar o pipeline operacional agora."}
          </p>
          <div className="funnel-row" aria-label="Pipeline das integracoes">
            {pipeline?.stages.length ? (
              pipeline.stages.map((stage) => (
                <div className="funnel-step" key={stage.key}>
                  <span>{stage.label}</span>
                  <strong>{stage.value}</strong>
                  <p>{stage.detail}</p>
                  <div className="signal-bar">
                    <i
                      style={{
                        width: pipelineWidth(stage.value, maxPipelineValue),
                      }}
                    />
                  </div>
                </div>
              ))
            ) : (
              <div className="funnel-step">
                <span>Pipeline</span>
                <strong>
                  {pipelineResult.state === "error"
                    ? "API indisponivel"
                    : "Aguardando eventos reais"}
                </strong>
                <div className="signal-bar">
                  <i style={{ width: "0%" }} />
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </section>
  );
}
