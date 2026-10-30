"use client";

import type { InboundWebhookMetaAppDto } from "@wpptrack/shared";
import { AlertTriangle, Check, KeyRound, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import {
  removeMetaCloudAppAction,
  saveMetaCloudAppAction,
} from "./meta-cloud-app-actions";

const sourceLabels: Record<InboundWebhookMetaAppDto["appSecretSource"], string> = {
  connection: "Segredo configurado nesta conexão",
  environment: "Usando o META_APP_SECRET do servidor",
  none: "Nenhum segredo configurado",
};

/**
 * "App do Meta desta conexão": App ID e App Secret do app Meta que entrega os
 * webhooks desta conexão Meta Cloud. Agências com um app por BM de cliente
 * preenchem aqui; instalações com um único app podem seguir só com o
 * META_APP_SECRET do servidor. O segredo nunca volta para a tela.
 */
export function MetaCloudAppCredentialsPanel({
  connectionId,
  metaApp,
  canManage,
  licenseLocked = false,
}: {
  connectionId: string;
  metaApp: InboundWebhookMetaAppDto | null | undefined;
  canManage: boolean;
  licenseLocked?: boolean;
}) {
  const router = useRouter();
  const [appId, setAppId] = useState(metaApp?.appId ?? "");
  const [appSecret, setAppSecret] = useState("");
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [current, setCurrent] = useState<InboundWebhookMetaAppDto | null>(
    metaApp ?? null,
  );
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(
    null,
  );
  // Depois do router.refresh() o servidor manda o estado novo: ele vence.
  useEffect(() => {
    setCurrent(metaApp ?? null);
  }, [
    metaApp?.appId,
    metaApp?.appSecretConfigured,
    metaApp?.appSecretSource,
    metaApp?.appSecretUpdatedAt,
  ]);
  const appIdFieldId = `meta-app-id-${connectionId}`;
  const secretFieldId = `meta-app-secret-${connectionId}`;
  const disabled = !canManage || licenseLocked || busy !== null;
  const ready = appId.trim().length > 0 && appSecret.trim().length > 0;
  const source = current?.appSecretSource ?? "none";
  const hasOwnApp = Boolean(current?.appSecretConfigured || current?.appId);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !ready) return;
    const input = { appId: appId.trim(), appSecret: appSecret.trim() };
    // O segredo sai da tela já: nunca é reexibido nem guardado no navegador.
    setAppSecret("");
    setBusy("save");
    setFeedback(null);
    try {
      const result = await saveMetaCloudAppAction(connectionId, input);
      setFeedback({ ok: result.ok, message: result.message });
      if (result.ok) {
        if (result.metaApp) setCurrent(result.metaApp);
        router.refresh();
      }
    } catch {
      setFeedback({ ok: false, message: "Não foi possível salvar agora. Tente de novo." });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (disabled || !hasOwnApp) return;
    if (
      !window.confirm(
        "Remover o App ID e o App Secret desta conexão? Ela passa a usar o META_APP_SECRET do servidor, se houver. Sem nenhum segredo, a conexão não pode enviar.",
      )
    ) {
      return;
    }
    setBusy("remove");
    setFeedback(null);
    try {
      const result = await removeMetaCloudAppAction(connectionId);
      setFeedback({ ok: result.ok, message: result.message });
      if (result.ok) {
        setCurrent(result.metaApp);
        setAppId("");
        router.refresh();
      }
    } catch {
      setFeedback({ ok: false, message: "Não foi possível remover agora. Tente de novo." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className="meta-waba-subscription meta-cloud-app"
      aria-labelledby={`meta-app-heading-${connectionId}`}
    >
      <div className="meta-waba-heading">
        <span className="eyebrow">Meta Cloud</span>
        <h3 id={`meta-app-heading-${connectionId}`}>App do Meta desta conexão</h3>
      </div>

      <p
        className={`action-note ${source === "none" ? "warn" : ""}`}
        role="status"
        data-meta-app-source={source}
      >
        {source === "none" ? (
          <AlertTriangle size={14} aria-hidden="true" />
        ) : (
          <Check size={14} aria-hidden="true" />
        )}{" "}
        {sourceLabels[source]}
        {current?.appId ? ` · App ID ${current.appId}` : ""}
      </p>
      <p className="muted">
        A Meta assina cada webhook com o App Secret do app que entrega as mensagens. Se cada cliente
        tem o próprio app Meta (agências, um app por BM), preencha aqui o App ID e o App Secret do app
        deste cliente. Se a instalação usa um único app Meta, o META_APP_SECRET do servidor basta. O
        App Secret fica em developers.facebook.com → seu app → Configurações do app → Básico. Use o do
        seu próprio app, nunca o da PalmUP, e não cole segredos no chat.
      </p>

      {!canManage ? (
        <p className="action-note">Só o dono ou um admin do workspace pode alterar o app Meta desta conexão.</p>
      ) : null}
      {licenseLocked && canManage ? (
        <p className="action-note warn" role="status">
          Licença bloqueada: alterar o app Meta desta conexão está indisponível. Verifique /backoffice/license.
        </p>
      ) : null}

      {canManage ? (
        <form className="meta-waba-form" onSubmit={save} autoComplete="off">
          <div className="meta-waba-field">
            <label htmlFor={appIdFieldId} className="field-label">
              App ID
            </label>
            <input
              id={appIdFieldId}
              name="metaAppId"
              inputMode="numeric"
              autoComplete="off"
              value={appId}
              onChange={(event) => setAppId(event.target.value)}
              placeholder="Ex.: 1234567890123456"
              maxLength={25}
              disabled={disabled}
            />
          </div>
          <div className="meta-waba-field">
            <label htmlFor={secretFieldId} className="field-label">
              App Secret
            </label>
            <input
              id={secretFieldId}
              name="metaAppSecret"
              type="password"
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              spellCheck={false}
              value={appSecret}
              onChange={(event) => setAppSecret(event.target.value)}
              placeholder={
                current?.appSecretConfigured
                  ? "Salvo. Cole outro para trocar"
                  : "Cole o App Secret do app Meta"
              }
              maxLength={128}
              disabled={disabled}
              aria-describedby={`${secretFieldId}-help`}
              data-presentation-sensitive-field="true"
            />
            <span id={`${secretFieldId}-help`} className="field-help muted">
              Fica cifrado no servidor e nunca volta para a tela. Para trocar, cole o novo e salve.
            </span>
          </div>
          <div className="meta-waba-actions">
            <button className="button primary" type="submit" disabled={disabled || !ready}>
              <KeyRound size={15} aria-hidden="true" />
              {busy === "save" ? "Salvando..." : "Salvar"}
            </button>
            {hasOwnApp ? (
              <button
                className="button"
                type="button"
                disabled={disabled}
                onClick={() => void remove()}
              >
                <Trash2 size={15} aria-hidden="true" />
                {busy === "remove" ? "Removendo..." : "Remover"}
              </button>
            ) : null}
          </div>
        </form>
      ) : null}

      {feedback ? (
        <div
          className={`feedback-banner ${feedback.ok ? "success" : "error"}`}
          role={feedback.ok ? "status" : "alert"}
        >
          {feedback.ok ? (
            <Check size={16} aria-hidden="true" />
          ) : (
            <AlertTriangle size={16} aria-hidden="true" />
          )}
          <span>{feedback.message}</span>
        </div>
      ) : null}
    </section>
  );
}
