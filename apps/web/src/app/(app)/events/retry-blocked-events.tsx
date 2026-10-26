"use client";

import { RefreshCw } from "lucide-react";
import { useFormStatus } from "react-dom";
import { BackofficeActionForm } from "../../../components/backoffice-action-form";
import { retryBlockedMetaEventsAction } from "./actions";

export type RetryBlockedFilters = {
  since: string;
  until: string;
  eventName: string;
  status: string;
  source: string;
};

function RetryBlockedSubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();

  return (
    <button
      className="button ghost compact-button audit-retry-button"
      disabled={disabled || pending}
      title={
        disabled
          ? "Nenhum evento bloqueado ou com falha de login da Meta neste período"
          : "Envia de novo, com a conexão Meta atual, os eventos bloqueados por configuração e os que a Meta recusou por falha de login (token expirado ou login pendente). Use depois de reconectar a Meta. Eventos com mais de 7 dias ficam de fora, porque a Meta não os aceita mais."
      }
      type="submit"
    >
      <RefreshCw aria-hidden="true" size={16} />
      {pending
        ? "Enviando..."
        : "Reenviar bloqueados e falhas de login da Meta"}
    </button>
  );
}

export function RetryBlockedEvents({
  blockedCount,
  filters,
}: {
  /** Blocked events plus Meta login failures (code 190/102) still resendable. */
  blockedCount: number;
  filters: RetryBlockedFilters;
}) {
  return (
    <BackofficeActionForm
      action={retryBlockedMetaEventsAction}
      className="audit-retry-blocked-form"
    >
      {Object.entries(filters).map(([name, value]) => (
        <input key={name} name={name} type="hidden" value={value} />
      ))}
      <RetryBlockedSubmitButton disabled={blockedCount === 0} />
    </BackofficeActionForm>
  );
}
