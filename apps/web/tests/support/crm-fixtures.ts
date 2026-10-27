import type {
  CrmBoardDto,
  CrmColumnDto,
  CrmLeadCardDto,
  LeadDetailDto,
  ManualConversionPreviewDto,
} from "@wpptrack/shared";

/** Realistic CRM Kanban fixtures (tests and screenshots only). */

export const CRM_FIXTURE_NOW = new Date("2026-10-24T15:00:00.000Z");
const DAY = 24 * 3600_000;
const ago = (days: number) =>
  new Date(CRM_FIXTURE_NOW.getTime() - days * DAY).toISOString();

const people: Array<[string, string]> = [
  ["Mariana Alves", "+55 11 99999-0101"],
  ["João Pedro Santos", "+55 11 99999-0102"],
  ["Ana Beatriz Lima", "+55 11 99999-0103"],
  ["Carlos Eduardo Rocha", "+55 11 99999-0104"],
  ["Fernanda Oliveira", "+55 11 99999-0105"],
  ["Rafael Costa", "+55 11 99999-0106"],
  ["Juliana Martins", "+55 11 99999-0107"],
  ["Lucas Ferreira", "+55 11 99999-0108"],
  ["Patrícia Gomes", "+55 11 99999-0109"],
  ["Thiago Ribeiro", "+55 11 99999-0110"],
  ["Camila Souza", "+55 11 99999-0111"],
  ["Bruno Carvalho", "+55 11 99999-0112"],
  ["Larissa Mendes", "+55 11 99999-0113"],
  ["Gustavo Almeida", "+55 11 99999-0114"],
  ["Beatriz Nunes", "+55 11 99999-0115"],
  ["Diego Barbosa", "+55 11 99999-0116"],
  ["Aline Pereira", "+55 11 99999-0117"],
  ["Rodrigo Teixeira", "+55 11 99999-0118"],
  ["Vanessa Castro", "+55 11 99999-0119"],
  ["Felipe Araújo", "+55 11 99999-0120"],
  ["Gabriela Moreira", "+55 11 99999-0121"],
  ["Marcelo Dias", "+55 11 99999-0122"],
  ["Renata Cardoso", "+55 11 99999-0123"],
  ["Eduardo Pinto", "+55 11 99999-0124"],
  ["Sabrina Freitas", "+55 11 99999-0125"],
];

const campaigns: Array<[string, string, string]> = [
  ["cmp_bf", "Black Friday WhatsApp", "Carrossel 40% OFF"],
  ["cmp_lanc", "Lançamento Coleção Verão", "Vídeo provador"],
  ["cmp_remkt", "Remarketing Carrinho", "Depoimento cliente"],
];

export function crmCard(
  index: number,
  overrides: Partial<CrmLeadCardDto> = {},
): CrmLeadCardDto {
  const [name, phone] = people[index % people.length]!;
  const [campaignId, campaignName, adName] = campaigns[index % campaigns.length]!;
  return {
    leadId: `lead_${String(index).padStart(3, "0")}`,
    name,
    phoneDisplay: phone,
    origin: "ctwa",
    campaignId,
    campaignName,
    adId: `ad_${campaignId}`,
    adName,
    creative: { thumbnailUrl: null, thumbnailVersion: null },
    enteredStageAt: ago(0.3 + index * 0.6),
    arrivedAt: ago(1 + index * 0.6),
    valueCents: null,
    currency: null,
    whatsappInstance:
      index % 2 === 0
        ? { id: "inst_1", name: "Comercial SP" }
        : { id: "inst_2", name: "Atendimento RJ" },
    ...overrides,
  };
}

export function crmColumn(
  overrides: Partial<CrmColumnDto> & Pick<CrmColumnDto, "key" | "label" | "rank">,
): CrmColumnDto {
  return {
    kind: "stage",
    eventName: overrides.key as CrmColumnDto["eventName"],
    readOnly: false,
    requiresValue: false,
    defaultValueCents: null,
    defaultCurrency: null,
    defaultContentName: null,
    total: overrides.cards?.length ?? 0,
    cards: [],
    nextCursor: null,
    ...overrides,
  };
}

export function crmBoardFixture(
  options: { override?: boolean; canMoveCards?: boolean; showWhatsappNumber?: boolean } = {},
): CrmBoardDto {
  const novos = Array.from({ length: 20 }, (_, i) => crmCard(i));
  const qualified = Array.from({ length: 4 }, (_, i) =>
    crmCard(20 + i, { enteredStageAt: ago(0.5 + i * 1.3) }),
  );
  const buyers = [
    crmCard(24, { valueCents: 49_700, currency: "BRL", enteredStageAt: ago(0.8) }),
    crmCard(5, {
      leadId: "lead_buyer_2",
      valueCents: 129_990,
      currency: "BRL",
      enteredStageAt: ago(3.2),
    }),
  ];
  const columns: CrmColumnDto[] = [
    crmColumn({
      key: "LeadSubmitted",
      label: "Leads novos",
      rank: 1,
      total: 46,
      cards: novos,
      nextCursor: "cursor_novos_20",
    }),
    crmColumn({ key: "QualifiedLead", label: "Lead qualificado", rank: 2, cards: qualified }),
    crmColumn({
      key: "Purchase",
      label: "Compra",
      rank: 3,
      requiresValue: true,
      defaultValueCents: 49_700,
      defaultCurrency: "BRL",
      cards: buyers,
    }),
  ];
  if (options.override)
    columns.unshift(
      crmColumn({
        key: "conversations",
        kind: "conversations",
        eventName: null,
        label: "Conversas iniciadas",
        rank: 0,
        readOnly: true,
        cards: [
          crmCard(7, { leadId: "lead_conv_1", enteredStageAt: ago(0.2) }),
          crmCard(11, { leadId: "lead_conv_2", enteredStageAt: ago(1.1) }),
          crmCard(16, { leadId: "lead_conv_3", enteredStageAt: ago(2.4) }),
        ],
      }),
    );
  return {
    mode: options.override ? "rule_override" : "default",
    range: { since: "2026-09-25", until: "2026-10-24" },
    journeyConfigured: true,
    columns,
    canMoveCards: options.canMoveCards ?? true,
    showWhatsappNumber: options.showWhatsappNumber ?? true,
    generatedAt: CRM_FIXTURE_NOW.toISOString(),
  };
}

export function crmLeadDetailFixture(card: CrmLeadCardDto = crmCard(20)): LeadDetailDto {
  return {
    lead: {
      id: card.leadId,
      workspaceId: "workspace_1",
      name: card.name,
      phoneDisplay: card.phoneDisplay,
      phoneHash: "phone_hash_1",
      status: "qualified",
      source: "umbler_talk",
      labels: [],
      campaignId: card.campaignId,
      campaignName: card.campaignName,
      adSetId: "adset_1",
      adId: card.adId,
      lastEventName: "QualifiedLead",
      firstMessageAt: card.arrivedAt,
      lastMessageAt: card.enteredStageAt,
      createdAt: card.arrivedAt,
      updatedAt: card.enteredStageAt,
    },
    attribution: {
      campaignName: card.campaignName,
      adSetName: "Público quente 25-45",
      adName: card.adName,
      creative: { thumbnailUrl: null, destinationUrl: null },
    },
    conversionEvents: [
      {
        id: "log_qualified",
        eventName: "QualifiedLead",
        status: "sent",
        sourceTrigger: "manual_conversion",
        pixelId: "1234567890",
        campaignId: card.campaignId,
        adSetId: "adset_1",
        adId: card.adId,
        errorCode: null,
        errorMessage: null,
        occurredAt: card.enteredStageAt,
        sentAt: card.enteredStageAt,
        createdAt: card.enteredStageAt,
        manual: {
          createdByName: "Samuel",
          note: null,
          orderRef: null,
          canCancel: false,
          origin: "kanban",
        },
      },
      {
        id: "log_lead",
        eventName: "LeadSubmitted",
        status: "sent",
        sourceTrigger: "auto_lead",
        pixelId: "1234567890",
        campaignId: card.campaignId,
        adSetId: "adset_1",
        adId: card.adId,
        errorCode: null,
        errorMessage: null,
        occurredAt: card.arrivedAt,
        sentAt: card.arrivedAt,
        createdAt: card.arrivedAt,
        manual: null,
      },
    ],
    webhookEvents: [],
  };
}

export const crmPurchasePreviewFixture: ManualConversionPreviewDto = {
  eventName: "Purchase",
  eventLabel: "Compra realizada",
  willSendToMeta: true,
  notSentReason: null,
  notSentReasonLabel: null,
  destination: {
    kind: "ad",
    pixelId: "1234567890",
    destinationName: "Pixel Loja Principal",
  },
  attribution: {
    campaignId: "cmp_bf",
    campaignName: "Black Friday WhatsApp",
    adId: "ad_cmp_bf",
    adName: "Carrossel 40% OFF",
  },
  duplicate: null,
  recentDuplicate: null,
  mayExpireBeforeSend: false,
};
