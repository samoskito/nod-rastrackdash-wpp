import { type LeadDetailDto } from "@wpptrack/shared";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { PresentationMask } from "../../../../components/presentation-mask";
import { getManualConversionAccess } from "../../../../lib/manual-conversion-access";
import { serverApiFetch } from "../../../../lib/server-api";
import { LeadDetailView, leadStatusLabel } from "./lead-detail-view";

type LeadDetailParams = {
  leadId: string;
};

type LeadDetailResult = {
  detail: LeadDetailDto | null;
  state: "real" | "error";
};

async function getLeadDetail(leadId: string): Promise<LeadDetailResult> {
  try {
    return {
      detail: await serverApiFetch<LeadDetailDto>(`/leads/${leadId}`),
      state: "real",
    };
  } catch {
    return {
      detail: null,
      state: "error",
    };
  }
}

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<LeadDetailParams>;
}) {
  const { leadId } = await params;
  const result = await getLeadDetail(leadId);
  const detail = result.detail;

  if (!detail) {
    return (
      <section className="page-stack page-standard">
        <header className="page-header">
          <div>
            <span className="eyebrow">Leads</span>
            <h1>Não foi possível carregar o lead</h1>
            <p>Confira a API antes de analisar a jornada deste contato.</p>
          </div>
          <div className="header-actions">
            <span className="status-chip warn">API indisponível</span>
            <Link className="button" href="/leads">
              <ArrowLeft aria-hidden="true" size={17} strokeWidth={2.2} />
              Voltar
            </Link>
          </div>
        </header>
      </section>
    );
  }

  const { lead } = detail;
  const manualAccess = await getManualConversionAccess();

  return (
    <section className="page-stack page-wide lead-detail-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Lead</span>
          <h1>
            <PresentationMask placeholder="Lead oculto">
              {lead.name ?? "Lead sem nome"}
            </PresentationMask>
          </h1>
          <p>
            <PresentationMask placeholder="(00) 00000-0000">
              {lead.phoneDisplay ?? lead.phoneHash}
            </PresentationMask>
          </p>
        </div>
        <div className="header-actions">
          <span className="status-chip">{leadStatusLabel(lead.status)}</span>
          <Link className="button" href="/leads">
            <ArrowLeft aria-hidden="true" size={17} strokeWidth={2.2} />
            Voltar
          </Link>
        </div>
      </header>

      <LeadDetailView detail={detail} manualAccess={manualAccess} />
    </section>
  );
}
