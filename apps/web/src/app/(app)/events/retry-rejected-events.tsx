"use client";

import { RotateCcw } from "lucide-react";
import { useFormStatus } from "react-dom";
import { BackofficeActionForm } from "../../../components/backoffice-action-form";
import { retryRejectedMetaEventsAction } from "./actions";
import type { RetryBlockedFilters } from "./retry-blocked-events";

/** Aviso mostrado antes do botão, no lote e em cada evento. */
export const RETRY_REJECTED_WARNING =
  "Corrija a causa mostrada no motivo da recusa antes de reenviar. Se a Meta recusar de novo, o evento volta a Falhou com o novo motivo.";

function RetryRejectedSubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();

  return (
    <button
      className="button ghost compact-button audit-retry-button"
      disabled={disabled || pending}
      title={
        disabled
          ? "Nenhum evento recusado pela Meta por causa corrigível neste período"
          : "Envia de novo, com o mesmo identificador, os eventos que a Meta recusou por configuração, parâmetro ou permissão, pelo destino atual (do anúncio, do número, da conta ou da conexão): o destino, o pixel e a página da tentativa recusada não são reaproveitados. Ficam de fora os com mais de 7 dias e os cuja rota atual ainda não está pronta."
      }
      type="submit"
    >
      <RotateCcw aria-hidden="true" size={16} />
      {pending ? "Enviando..." : "Reenviar recusados"}
    </button>
  );
}

/**
 * 1.3.1: "Reenviar recusados" em lote, com os filtros da tela (até 500).
 * Só para recusas que o aluno corrige no painel (código 100, 10, 200-299 ou
 * recusa antiga sem código). Owner ou admin.
 */
export function RetryRejectedEvents({
  rejectedCount,
  filters,
}: {
  rejectedCount: number;
  filters: RetryBlockedFilters;
}) {
  return (
    <div className="audit-retry-rejected" data-rejected-retryable={rejectedCount}>
      <small className="muted">{RETRY_REJECTED_WARNING}</small>
      <BackofficeActionForm
        action={retryRejectedMetaEventsAction}
        className="audit-retry-blocked-form"
      >
        {Object.entries(filters).map(([name, value]) => (
          <input key={name} name={name} type="hidden" value={value} />
        ))}
        <RetryRejectedSubmitButton disabled={rejectedCount === 0} />
      </BackofficeActionForm>
    </div>
  );
}
