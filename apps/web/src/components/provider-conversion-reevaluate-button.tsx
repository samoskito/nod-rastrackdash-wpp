"use client";

import { ScanSearch } from "lucide-react";
import { useFormStatus } from "react-dom";

export function ProviderConversionReevaluateButton() {
  const { pending } = useFormStatus();

  return (
    <button
      className="button ghost compact-button"
      type="submit"
      disabled={pending}
      title="Recalcular esta decisão com as regras e o catálogo atuais"
    >
      <ScanSearch aria-hidden="true" size={16} strokeWidth={2} />
      {pending ? "Reavaliando..." : "Reavaliar decisão"}
    </button>
  );
}
