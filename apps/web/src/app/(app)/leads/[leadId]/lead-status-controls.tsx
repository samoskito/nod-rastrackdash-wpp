"use client";

import type { LeadStatusDto } from "@wpptrack/shared";
import { useFormStatus } from "react-dom";
import { BackofficeActionForm } from "../../../../components/backoffice-action-form";
import { updateLeadStatusAction } from "./actions";

const OPTIONS: Array<{ status: LeadStatusDto; label: string }> = [
  { status: "new", label: "Novo" },
  { status: "active", label: "Em atendimento" },
  { status: "qualified", label: "Qualificado" },
  { status: "lost", label: "Perdido" },
];

const QUALIFY_CONFIRMATION =
  "Marcar como qualificado envia o evento QualifiedLead para a Meta. Depois do envio o status nao pode voltar. Continuar?";

function StatusButtons({ current }: { current: LeadStatusDto }) {
  const { pending } = useFormStatus();

  return (
    <div className="lead-status-controls" role="group" aria-label="Status">
      {OPTIONS.map((option) => (
        <button
          key={option.status}
          className={`button${option.status === current ? " primary" : ""}`}
          type="submit"
          name="status"
          value={option.status}
          aria-pressed={option.status === current}
          disabled={pending || option.status === current}
          onClick={(event) => {
            if (
              option.status === "qualified" &&
              !window.confirm(QUALIFY_CONFIRMATION)
            ) {
              event.preventDefault();
            }
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Operator status on the lead screen (Dashboard Leads parity). "Qualificado"
 * records QualifiedLead and queues it for Meta; the API refuses going back
 * once the qualification event exists.
 */
export function LeadStatusControls({
  leadId,
  status,
}: {
  leadId: string;
  status: LeadStatusDto;
}) {
  return (
    <BackofficeActionForm action={updateLeadStatusAction}>
      <input name="leadId" type="hidden" value={leadId} />
      <StatusButtons current={status} />
    </BackofficeActionForm>
  );
}
