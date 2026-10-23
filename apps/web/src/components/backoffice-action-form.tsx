"use client";

import type { ReactNode } from "react";
import { useActionState, useEffect, useRef, useState } from "react";

export type BackofficeActionState = {
  status: "idle" | "success" | "error";
  message: string;
  nonce: number;
  whatsappClassification?:
    | "auto_whatsapp"
    | "creative_whatsapp"
    | "detected_by_leads"
    | "manual_include"
    | "manual_exclude"
    | "needs_review"
    | "not_whatsapp";
  whatsappClassificationReset?: boolean;
  syncRequest?: {
    connectorId: string;
    requestedAt: number;
  };
  activationUrl?: string;
  acceptUrl?: string;
};

export type BackofficeFormAction = (
  previousState: BackofficeActionState,
  formData: FormData,
) => Promise<BackofficeActionState>;

export const initialBackofficeActionState: BackofficeActionState = {
  status: "idle",
  message: "",
  nonce: 0,
};

type BackofficeActionFormProps = {
  id?: string;
  action: BackofficeFormAction;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  onSuccess?: (state: BackofficeActionState) => void;
};

export function BackofficeActionForm({
  id,
  action,
  children,
  className,
  resetOnSuccess = false,
  onSuccess,
}: BackofficeActionFormProps) {
  const [state, formAction] = useActionState(
    action,
    initialBackofficeActionState,
  );
  const [noticeVisible, setNoticeVisible] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const handledNonceRef = useRef(0);

  useEffect(() => {
    if (!state.nonce || handledNonceRef.current === state.nonce) {
      return;
    }

    handledNonceRef.current = state.nonce;
    setNoticeVisible(true);

    if (state.status === "success") {
      if (resetOnSuccess) {
        formRef.current?.reset();
      }
      onSuccess?.(state);
    }

    const timeout = window.setTimeout(() => setNoticeVisible(false), 6_000);
    return () => window.clearTimeout(timeout);
  }, [onSuccess, resetOnSuccess, state]);

  return (
    <>
      <form id={id} ref={formRef} className={className} action={formAction}>
        {children}
      </form>
      {noticeVisible ? (
        <div
          className={`action-toast${state.status === "error" ? " error" : ""}`}
          role="status"
          aria-live="polite"
        >
          <strong>
            {state.status === "error" ? "Ação não concluída" : "Concluído"}
          </strong>
          <span>{state.message}</span>
        </div>
      ) : null}
    </>
  );
}
