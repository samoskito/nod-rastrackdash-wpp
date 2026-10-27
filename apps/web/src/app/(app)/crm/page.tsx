import {
  crmBoardSchema,
  type CrmBoardDto,
  type MetaStructureReportDto,
  type WhatsappConnectionDto,
} from "@wpptrack/shared";
import { getManualConversionAccess } from "../../../lib/manual-conversion-access";
import { serverApiFetch } from "../../../lib/server-api";
import {
  CrmBoard,
  type CrmCampaignOption,
  type CrmWhatsappInstanceOption,
} from "./crm-board";
import {
  crmFiltersFromSearchParams,
  crmFiltersHref,
  crmQueryString,
  type CrmFilterValues,
} from "./crm-filter-params";

type CrmSearchParams = Record<string, string | string[] | undefined>;

async function getBoard(filters: CrmFilterValues): Promise<CrmBoardDto | null> {
  try {
    return crmBoardSchema.parse(
      await serverApiFetch<unknown>(`/crm/board?${crmQueryString(filters)}`),
    );
  } catch {
    return null;
  }
}

/**
 * Campaigns synced from Meta (nod: the period-scoped campaign options of the
 * Visão Geral arrive with Fase 6.3b). null disables the filter.
 */
async function getCampaignOptions(): Promise<CrmCampaignOption[] | null> {
  try {
    const response =
      await serverApiFetch<MetaStructureReportDto>("/reports/meta/structure");
    return Array.isArray(response?.campaigns)
      ? response.campaigns.map((campaign) => ({
          id: campaign.id,
          name: campaign.name,
        }))
      : null;
  } catch {
    return null;
  }
}

/**
 * Active connections only (nod: one number per connection; "vaga paga" in
 * the SaaS = active connection here).
 */
async function getWhatsappInstances(): Promise<CrmWhatsappInstanceOption[]> {
  try {
    const connections = await serverApiFetch<WhatsappConnectionDto[]>(
      "/integrations/whatsapp-connections",
    );
    return connections
      .filter((connection) => connection.status === "active")
      .map((connection) => ({
        id: connection.id,
        name: connection.displayName ?? connection.name,
        phone: connection.connectedPhone ?? null,
      }));
  } catch {
    return [];
  }
}

/**
 * CRM Kanban (docs/plans/2026-10-24-crm-kanban-design.md): leads by stage of
 * the Jornada. Filters live in the URL; the board (client) keeps scroll and
 * loaded pages while the lead modal is open.
 */
export default async function CrmPage({
  searchParams,
}: {
  searchParams?: Promise<CrmSearchParams>;
}) {
  const filters = crmFiltersFromSearchParams(
    searchParams ? await searchParams : {},
  );
  const [board, manualAccess, whatsappInstances, campaignOptions] =
    await Promise.all([
      getBoard(filters),
      getManualConversionAccess(),
      getWhatsappInstances(),
      getCampaignOptions(),
    ]);

  if (!board) {
    return (
      <section className="crm-page" aria-labelledby="crm-title">
        <header className="crm-header">
          <div className="crm-header-title">
            <span className="eyebrow">Operação</span>
            <h1 id="crm-title">CRM</h1>
          </div>
        </header>
        <div className="crm-empty-state surface-panel" role="alert">
          <strong>Não foi possível carregar o quadro</strong>
          <span>Confira a conexão com a API e atualize a página.</span>
        </div>
      </section>
    );
  }

  return (
    <CrmBoard
      // New filters (URL) start a new board; the modal never changes them.
      key={crmFiltersHref(filters)}
      initialBoard={board}
      filters={filters}
      manualAccess={manualAccess}
      whatsappInstances={whatsappInstances}
      campaignOptions={campaignOptions}
    />
  );
}
