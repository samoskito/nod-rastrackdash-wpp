"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Modal } from "../../../../components/modal";
import { deleteLeadAction } from "./delete-lead-action";

/** Palavra que o gestor digita para liberar o botão de excluir. */
export const DELETE_LEAD_TYPED_WORD = "EXCLUIR";

/**
 * "Excluir lead" (porte do SaaS #292, gestor do workspace): confirmação
 * digitada, com o aviso de que conversões já enviadas à Meta não são
 * desfeitas. No aluno a API só exclui lead sem nenhum envio (409 nos outros).
 */
export function DeleteLeadButton({
  leadId,
  leadName,
  action = deleteLeadAction,
  defaultOpen = false,
}: {
  leadId: string;
  leadName: string;
  action?: typeof deleteLeadAction;
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const confirmed = typed.trim().toUpperCase() === DELETE_LEAD_TYPED_WORD;

  function close() {
    if (pending) return;
    setOpen(false);
    setTyped("");
    setError(null);
  }

  function submit() {
    if (!confirmed) return;
    setError(null);
    startTransition(async () => {
      const result = await action(leadId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      router.push("/leads");
    });
  }

  return (
    <>
      <button
        className="button danger"
        type="button"
        onClick={() => setOpen(true)}
      >
        <Trash2 aria-hidden="true" size={16} strokeWidth={2} />
        Excluir lead
      </button>
      <Modal
        open={open}
        onClose={close}
        title="Excluir lead?"
        description={`${leadName} sai de Leads, do CRM e dos relatórios. Só dá para excluir lead sem nenhuma conversão enviada ou na fila da Meta.`}
      >
        <div className="feedback-banner warn" role="alert">
          <strong>Conversões já enviadas à Meta não são desfeitas.</strong>
          <span>A exclusão não pode ser desfeita.</span>
        </div>
        <label className="conversion-field">
          <span className="field-label">
            Digite {DELETE_LEAD_TYPED_WORD} para confirmar
          </span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            aria-label={`Digite ${DELETE_LEAD_TYPED_WORD} para confirmar`}
          />
        </label>
        {error ? (
          <p className="action-note warn" role="alert">
            {error}
          </p>
        ) : null}
        <div className="conversion-flow-actions">
          <button
            className="button"
            type="button"
            onClick={close}
            disabled={pending}
          >
            Cancelar
          </button>
          <button
            className="button danger"
            type="button"
            onClick={submit}
            disabled={pending || !confirmed}
            data-pending={pending ? "true" : undefined}
          >
            <Trash2 aria-hidden="true" size={15} />
            {pending ? "Excluindo..." : "Excluir lead"}
          </button>
        </div>
      </Modal>
    </>
  );
}
