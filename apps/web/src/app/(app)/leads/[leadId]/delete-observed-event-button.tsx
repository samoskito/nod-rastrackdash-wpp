"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteObservedEventAction } from "./observed-event-actions";

/**
 * "Excluir teste" num evento de regra em observação: tira o evento do lead
 * e a etapa que ele dava em Leads e no CRM. Nada disso foi para a Meta.
 */
export function DeleteObservedEventButton({
  leadId,
  executionId,
  onDeleted,
  action = deleteObservedEventAction,
}: {
  leadId: string;
  executionId: string;
  /** Replaces the page refresh (CRM Kanban lead modal). */
  onDeleted?: () => void;
  action?: typeof deleteObservedEventAction;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function remove() {
    if (
      !window.confirm(
        "Excluir este evento de teste? Ele sai do lead, de Leads e do CRM. Nada foi enviado à Meta.",
      )
    )
      return;
    startTransition(async () => {
      const response = await action(leadId, executionId).catch(() => null);
      if (!response || !response.ok) {
        setMessage(response?.message ?? "Não foi possível excluir agora.");
        return;
      }
      if (onDeleted) onDeleted();
      else router.refresh();
    });
  }

  return (
    <span className="manual-conversion-cancel">
      <button
        className="button compact"
        type="button"
        onClick={remove}
        disabled={pending}
      >
        {pending ? "Excluindo..." : "Excluir teste"}
      </button>
      {message ? <span className="form-error">{message}</span> : null}
    </span>
  );
}
