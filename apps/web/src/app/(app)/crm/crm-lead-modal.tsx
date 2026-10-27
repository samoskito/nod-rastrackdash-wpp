"use client";

import type { LeadDetailDto } from "@wpptrack/shared";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../../../components/modal";
import { PresentationMask } from "../../../components/presentation-mask";
import type { ManualConversionAccess } from "../../../lib/manual-conversion-access";
import {
  LeadDetailView,
  leadStatusLabel,
} from "../leads/[leadId]/lead-detail-view";
import { loadCrmLeadDetailAction } from "./actions";

/**
 * Lead detail in a modal (design §6): the same content as the lead page
 * (LeadDetailView). The board stays mounted behind it, so closing returns to
 * the same scroll and loaded pages. `onClose(changed)` tells the board a
 * manual conversion was registered or canceled here (the card moves).
 */
export function CrmLeadModal({
  leadId,
  manualAccess,
  onClose,
  initialDetail = null,
}: {
  leadId: string;
  manualAccess: ManualConversionAccess;
  onClose: (changed: boolean) => void;
  /** Tests/screenshots: render without loading. */
  initialDetail?: LeadDetailDto | null;
}) {
  const [detail, setDetail] = useState<LeadDetailDto | null>(initialDetail);
  const [state, setState] = useState<"loading" | "ready" | "error">(
    initialDetail ? "ready" : "loading",
  );
  const changed = useRef(false);

  const load = useCallback(async () => {
    const response = await loadCrmLeadDetailAction(leadId).catch(() => null);
    if (response?.ok) {
      setDetail(response.detail);
      setState("ready");
    } else {
      setState((current) => (current === "ready" ? current : "error"));
    }
  }, [leadId]);

  useEffect(() => {
    if (!initialDetail) void load();
  }, [initialDetail, load]);

  const onChanged = useCallback(() => {
    changed.current = true;
    void load();
  }, [load]);

  const lead = detail?.lead;

  return (
    <Modal
      open
      onClose={() => onClose(changed.current)}
      title="Detalhe do lead"
      description={
        lead ? (
          <span className="crm-lead-modal-identity">
            <strong>
              <PresentationMask placeholder="Lead oculto">
                {lead.name ?? "Lead sem nome"}
              </PresentationMask>
            </strong>
            <PresentationMask placeholder="(00) 00000-0000">
              {lead.phoneDisplay ?? lead.phoneHash}
            </PresentationMask>
          </span>
        ) : undefined
      }
      size="wide"
      className="crm-lead-modal"
    >
      {state === "loading" ? (
        <p className="crm-lead-modal-status" role="status">
          Carregando o lead...
        </p>
      ) : null}
      {state === "error" ? (
        <div className="feedback-banner warn" role="alert">
          <strong>Não foi possível carregar o lead</strong>
          <span>Feche e tente de novo em instantes.</span>
        </div>
      ) : null}
      {detail && lead ? (
        <div className="crm-lead-modal-body lead-detail-page">
          <div className="crm-lead-modal-actions">
            <span className="status-chip">{leadStatusLabel(lead.status)}</span>
            <Link className="button ghost" href={`/leads/${lead.id}`}>
              <ExternalLink aria-hidden="true" size={15} strokeWidth={2} />
              Abrir página do lead
            </Link>
          </div>
          <LeadDetailView
            detail={detail}
            manualAccess={manualAccess}
            onChanged={onChanged}
          />
        </div>
      ) : null}
    </Modal>
  );
}
