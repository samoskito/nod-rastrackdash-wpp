import { type LeadDetailDto } from "@wpptrack/shared";
import { ArrowLeft, UserRoundX } from "lucide-react";
import Link from "next/link";
import { PageBar } from "../../../../components/page-bar";
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
        <PageBar title="Lead">
          <span className="status-chip warn">API indisponível</span>
          <Link className="button" href="/leads">
            <ArrowLeft aria-hidden="true" size={17} strokeWidth={2.2} />
            Voltar
          </Link>
        </PageBar>
        <div className="lead-empty-state error" role="alert">
          <UserRoundX aria-hidden="true" size={28} strokeWidth={1.8} />
          <div>
            <strong>Não foi possível carregar o lead</strong>
            <span>Confira a API antes de analisar a jornada deste contato.</span>
          </div>
        </div>
      </section>
    );
  }

  const { lead } = detail;
  const manualAccess = await getManualConversionAccess();

  return (
    <section className="page-stack page-wide lead-detail-page">
      <PageBar
        className="lead-detail-bar"
        title={
          <PresentationMask placeholder="Lead oculto">
            {lead.name ?? "Lead sem nome"}
          </PresentationMask>
        }
      >
        <span className="lead-detail-phone">
          <PresentationMask placeholder="(00) 00000-0000">
            {lead.phoneDisplay ?? lead.phoneHash}
          </PresentationMask>
        </span>
        <span className="status-chip">{leadStatusLabel(lead.status)}</span>
        <Link className="button" href="/leads">
          <ArrowLeft aria-hidden="true" size={17} strokeWidth={2.2} />
          Voltar
        </Link>
      </PageBar>

      <LeadDetailView detail={detail} manualAccess={manualAccess} />
    </section>
  );
}
