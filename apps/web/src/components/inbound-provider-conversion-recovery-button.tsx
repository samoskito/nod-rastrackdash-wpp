"use client";

import { RotateCcw } from "lucide-react";
import { useFormStatus } from "react-dom";

export function InboundProviderConversionRecoveryButton() {
  const { pending } = useFormStatus();

  return (
    <button
      className="button ghost compact-button inbound-replay-link"
      type="submit"
      disabled={pending}
      title="Ler novamente este payload e recuperar conversões ausentes"
    >
      <RotateCcw aria-hidden="true" size={16} strokeWidth={2} />
      {pending ? "Reprocessando..." : "Reprocessar conversão"}
    </button>
  );
}
