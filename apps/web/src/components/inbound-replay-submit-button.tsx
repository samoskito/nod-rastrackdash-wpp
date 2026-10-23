"use client";

import {
  LifeBuoy,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useFormStatus } from "react-dom";

export function InboundReplaySubmitButton({
  mode,
}: {
  mode: "certify" | "parser" | "recovery" | "replay" | "retry";
}) {
  const { pending } = useFormStatus();
  const Icon =
    mode === "certify"
      ? ShieldCheck
      : mode === "parser"
        ? RefreshCw
        : mode === "recovery"
          ? LifeBuoy
          : mode === "retry"
            ? RotateCcw
            : PlayCircle;
  const label =
    mode === "certify"
      ? pending
        ? "Certificando..."
        : "Certificar parser"
      : mode === "parser"
        ? pending
          ? "Recuperando parser..."
          : "Recuperar lote"
        : mode === "recovery"
          ? pending
            ? "Recuperando..."
            : "Autorizar recuperação"
          : mode === "retry"
            ? pending
              ? "Recuperando..."
              : "Recuperar falhas"
            : pending
              ? "Autorizando..."
              : "Autorizar lote";

  return (
    <button className="button" type="submit" disabled={pending}>
      <Icon aria-hidden="true" size={17} strokeWidth={2} />
      {label}
    </button>
  );
}
