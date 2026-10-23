"use client";

import { RefreshCcw } from "lucide-react";
import { useFormStatus } from "react-dom";

export function ProviderConversionRetryButton() {
  const { pending } = useFormStatus();

  return (
    <button
      className="button ghost compact-button"
      type="submit"
      disabled={pending}
      title="Reenviar somente esta falha transitória para a Meta"
    >
      <RefreshCcw aria-hidden="true" size={16} strokeWidth={2} />
      {pending ? "Enfileirando..." : "Tentar novamente"}
    </button>
  );
}
