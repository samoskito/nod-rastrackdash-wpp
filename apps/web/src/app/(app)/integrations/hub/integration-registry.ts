/**
 * Catalog of the integrations shown in the Integrations hub.
 *
 * Only providers the student backend implements end to end appear here.
 * Adding a provider later (Payt, Unnichat, Pipedrive, ...) is one entry:
 *   1. add its id to `integrationProviderIds`;
 *   2. add a logo file in `public/integrations/` and a row in `logoAssets`
 *      (and in SOURCES.md);
 *   3. add its definition to `integrationProviders` with a `gate` the cards
 *      builder already understands (or a new gate kind + decision);
 *   4. give the page a modal panel for that id.
 * Logos live in `apps/web/public/integrations/`; replacing a file with the
 * same name needs no code change.
 */

export const integrationCategories = [
  "whatsapp_number",
  "whatsapp_official",
  "attendance",
  "ads",
  "crm",
] as const;

export type IntegrationCategory = (typeof integrationCategories)[number];

export const integrationTabIds = ["whatsapp", "conversions", "crm"] as const;

export type IntegrationTabId = (typeof integrationTabIds)[number];

export type IntegrationTabDefinition = {
  id: IntegrationTabId;
  label: string;
  /** Value accepted in `?aba=` deep links. */
  query: string;
  /** Extra `?aba=` values that also select this tab. */
  aliases: readonly string[];
  /** Hash that selects the tab (`#integracao-whatsapp`, ...). */
  hash: string;
  description: string;
  categories: readonly IntegrationCategory[];
};

export const integrationTabs: readonly IntegrationTabDefinition[] = [
  {
    id: "whatsapp",
    label: "WhatsApp",
    query: "whatsapp",
    aliases: [],
    hash: "integracao-whatsapp",
    description:
      "Os números que recebem as conversas dos anúncios: pela sua instância (Uazapi, NOD API, WAHA, Z-API) ou pela API oficial da Meta.",
    categories: ["whatsapp_number", "whatsapp_official"],
  },
  {
    id: "conversions",
    label: "Conversões e vendas",
    query: "conversoes",
    aliases: ["vendas", "anuncios"],
    hash: "integracao-conversoes",
    description:
      "As plataformas de atendimento que entregam as mensagens dos anúncios e a conta Meta que recebe as conversões.",
    categories: ["attendance", "ads"],
  },
  {
    id: "crm",
    label: "CRM",
    query: "crm",
    aliases: [],
    hash: "integracao-crm",
    description:
      "Quando o lead avança no funil do CRM, a conversão chega à Meta. Conectado uma vez para a conta inteira.",
    categories: ["crm"],
  },
];

export const integrationCategoryLabels: Record<IntegrationCategory, string> = {
  whatsapp_number: "Instância WhatsApp",
  whatsapp_official: "API oficial",
  attendance: "Plataforma de atendimento",
  ads: "Anúncios",
  crm: "CRM",
};

export const integrationProviderIds = [
  "uazapi_byo",
  "nod_api",
  "waha",
  "zapi",
  "meta_cloud",
  "umbler",
  "gupshup",
  "data_crazy",
  "kommo",
  "meta",
] as const;

export type IntegrationProviderId = (typeof integrationProviderIds)[number];

/** WhatsApp instance providers managed by `WhatsappProviderPanel`. */
export type WhatsappIntegrationProvider =
  "uazapi_byo" | "nod_api" | "waha" | "zapi";

/** Inbound webhook providers (`InboundWebhookPanel`, scoped to one). */
export type InboundIntegrationProvider =
  "meta_cloud" | "umbler" | "gupshup" | "data_crazy";

export type CrmIntegrationProvider = "kommo";

/**
 * Decides when a card is offered at all. Every gate reads data the API
 * already returns — no gate is a hardcoded allowlist.
 */
export type IntegrationGate =
  /** WhatsApp instance providers: always offered; active with connections. */
  | { kind: "whatsapp_provider"; provider: WhatsappIntegrationProvider }
  /** Shown when the API offers creation for it or a connection exists. */
  | { kind: "inbound_provider"; provider: InboundIntegrationProvider }
  | { kind: "crm"; provider: CrmIntegrationProvider }
  | { kind: "always" };

export type IntegrationProviderDefinition = {
  id: IntegrationProviderId;
  name: string;
  category: IntegrationCategory;
  /** Public path of the logo (swap the file to change the artwork). */
  logo: string;
  /** Short initials shown if the logo file is missing or fails to load. */
  initials: string;
  /**
   * Background the logo needs: official artwork with dark ink sits on a
   * light tile, light/colored artwork on the dark card.
   */
  logoSurface: "dark" | "light";
  description: string;
  gate: IntegrationGate;
};

type LogoAsset = { file: string; surface: "dark" | "light" };

/** Official logos where available; plain wordmark fallbacks otherwise. */
const logoAssets: Record<IntegrationProviderId, LogoAsset> = {
  uazapi_byo: { file: "uazapi.svg", surface: "dark" },
  nod_api: { file: "nod-api.svg", surface: "dark" },
  waha: { file: "waha.svg", surface: "dark" },
  zapi: { file: "zapi.svg", surface: "dark" },
  meta_cloud: { file: "meta-cloud.svg", surface: "dark" },
  umbler: { file: "umbler.svg", surface: "light" },
  gupshup: { file: "gupshup.svg", surface: "light" },
  data_crazy: { file: "datacrazy.svg", surface: "dark" },
  kommo: { file: "kommo.png", surface: "light" },
  meta: { file: "meta.svg", surface: "dark" },
};

export function integrationLogoPath(id: IntegrationProviderId): string {
  return `/integrations/${logoAssets[id].file}`;
}

function logoSurface(id: IntegrationProviderId): "dark" | "light" {
  return logoAssets[id].surface;
}

export const integrationProviders: readonly IntegrationProviderDefinition[] = [
  {
    id: "uazapi_byo",
    name: "Uazapi",
    category: "whatsapp_number",
    logo: integrationLogoPath("uazapi_byo"),
    initials: "Uz",
    logoSurface: logoSurface("uazapi_byo"),
    description:
      "Conecte a sua instância Uazapi (leia o QR code no celular) e receba as conversas dos anúncios.",
    gate: { kind: "whatsapp_provider", provider: "uazapi_byo" },
  },
  {
    id: "nod_api",
    name: "NOD API",
    category: "whatsapp_number",
    logo: integrationLogoPath("nod_api"),
    initials: "NOD",
    logoSurface: logoSurface("nod_api"),
    description: "Conecte a instância NOD API (PalmUP) do seu WhatsApp.",
    gate: { kind: "whatsapp_provider", provider: "nod_api" },
  },
  {
    id: "waha",
    name: "WAHA",
    category: "whatsapp_number",
    logo: integrationLogoPath("waha"),
    initials: "WA",
    logoSurface: logoSurface("waha"),
    description: "Conecte a sua instalação WAHA (WhatsApp HTTP API).",
    gate: { kind: "whatsapp_provider", provider: "waha" },
  },
  {
    id: "zapi",
    name: "Z-API",
    category: "whatsapp_number",
    logo: integrationLogoPath("zapi"),
    initials: "Z",
    logoSurface: logoSurface("zapi"),
    description: "Conecte a sua instância Z-API.",
    gate: { kind: "whatsapp_provider", provider: "zapi" },
  },
  {
    id: "meta_cloud",
    name: "WhatsApp Cloud API",
    category: "whatsapp_official",
    logo: integrationLogoPath("meta_cloud"),
    initials: "WA",
    logoSurface: logoSurface("meta_cloud"),
    description:
      "Receba as conversas dos anúncios direto pelo app da Meta, sem instância intermediária.",
    gate: { kind: "inbound_provider", provider: "meta_cloud" },
  },
  {
    id: "umbler",
    name: "Umbler Talk",
    category: "attendance",
    logo: integrationLogoPath("umbler"),
    initials: "Um",
    logoSurface: logoSurface("umbler"),
    description: "Receba as conversas de anúncio que chegam no Umbler Talk.",
    gate: { kind: "inbound_provider", provider: "umbler" },
  },
  {
    id: "gupshup",
    name: "Gupshup",
    category: "attendance",
    logo: integrationLogoPath("gupshup"),
    initials: "Gs",
    logoSurface: logoSurface("gupshup"),
    description: "Receba as conversas de anúncio que chegam na Gupshup.",
    gate: { kind: "inbound_provider", provider: "gupshup" },
  },
  {
    id: "data_crazy",
    name: "Data Crazy",
    category: "attendance",
    logo: integrationLogoPath("data_crazy"),
    initials: "DC",
    logoSurface: logoSurface("data_crazy"),
    description: "Receba as conversas de anúncio que chegam na Data Crazy.",
    gate: { kind: "inbound_provider", provider: "data_crazy" },
  },
  {
    id: "meta",
    name: "Meta Ads",
    category: "ads",
    logo: integrationLogoPath("meta"),
    initials: "Mt",
    logoSurface: logoSurface("meta"),
    description:
      "Conecte a conta de anúncios, o Pixel e a página que recebem as conversões.",
    gate: { kind: "always" },
  },
  {
    id: "kommo",
    name: "Kommo",
    category: "crm",
    logo: integrationLogoPath("kommo"),
    initials: "Ko",
    logoSurface: logoSurface("kommo"),
    description: "Envie conversões quando o lead muda de etapa no Kommo.",
    gate: { kind: "crm", provider: "kommo" },
  },
];

export function integrationProvider(
  id: IntegrationProviderId,
): IntegrationProviderDefinition {
  const provider = integrationProviders.find((item) => item.id === id);

  if (!provider) {
    throw new Error(`Unknown integration provider: ${id}`);
  }

  return provider;
}

export function integrationTabForCategory(
  category: IntegrationCategory,
): IntegrationTabId {
  const tab = integrationTabs.find((item) =>
    item.categories.includes(category),
  );

  return tab?.id ?? "whatsapp";
}

export function integrationTabFromQuery(
  value: string | null | undefined,
): IntegrationTabId | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  const tab = integrationTabs.find(
    (item) =>
      item.query === normalized ||
      item.id === normalized ||
      item.aliases.includes(normalized),
  );

  return tab?.id ?? null;
}

export function isIntegrationProviderId(
  value: string,
): value is IntegrationProviderId {
  return (integrationProviderIds as readonly string[]).includes(value);
}

/** `#integracao-<provider>` opens that provider's modal. */
export function integrationProviderHash(id: IntegrationProviderId): string {
  return `integracao-${id}`;
}

export type IntegrationDeepLink = {
  tab: IntegrationTabId | null;
  provider: IntegrationProviderId | null;
};

/**
 * Maps a location hash to the hub state. Keeps the anchors that existed
 * before the hub (`#integracao-meta`, `#integracao-whatsapp`) and the old
 * Settings Kommo anchor (`#crm-configurado`) working.
 */
export function integrationDeepLinkFromHash(
  hash: string | null | undefined,
): IntegrationDeepLink {
  const value = (hash ?? "").replace(/^#/u, "").trim().toLowerCase();

  if (!value) {
    return { tab: null, provider: null };
  }

  const tab = integrationTabs.find((item) => item.hash === value);
  if (tab) {
    return { tab: tab.id, provider: null };
  }

  if (value.startsWith("integracao-")) {
    const candidate = value.slice("integracao-".length);
    if (isIntegrationProviderId(candidate)) {
      return {
        tab: integrationTabForCategory(integrationProvider(candidate).category),
        provider: candidate,
      };
    }
  }

  // Old Settings anchor for the Kommo CRM block.
  if (value === "crm-configurado") {
    return { tab: "crm", provider: "kommo" };
  }

  return { tab: null, provider: null };
}
