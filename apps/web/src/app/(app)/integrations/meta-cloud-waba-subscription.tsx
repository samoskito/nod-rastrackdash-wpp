"use client";

import type { MetaCloudWabaSubscriptionStatusDto } from "@wpptrack/shared";
import { AlertTriangle, Check, Link2, Search } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { PresentationMask } from "../../../components/presentation-mask";
import {
  lookupMetaCloudWabaAction,
  subscribeMetaCloudWabaAction,
  type MetaCloudWabaActionResult,
} from "./meta-cloud-waba-actions";

type Failure = Extract<MetaCloudWabaActionResult, { ok: false }>;

const outcomeLabels: Record<MetaCloudWabaSubscriptionStatusDto["outcome"], string> = {
  lookup: "Consulta feita agora na Meta.",
  subscribed: "Inscrição feita e confirmada na Meta (reconsultado agora).",
  already_subscribed: "Este app já estava inscrito; nada foi alterado.",
  subscribe_unconfirmed:
    "A Meta aceitou o pedido, mas a reconsulta ainda não mostra este app. Consulte de novo em alguns minutos.",
};

/** Erros em que o guia manual ajuda (falhas da Meta, não de sessão/licença). */
function showsManualGuide(failure: Failure): boolean {
  return failure.status !== 403 && failure.status !== 423 && failure.code !== "invalid_input";
}

export function MetaCloudWabaSubscriptionPanel({
  connectionId,
  canManage,
  licenseLocked = false,
}: {
  connectionId: string;
  canManage: boolean;
  licenseLocked?: boolean;
}) {
  const [wabaId, setWabaId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [busy, setBusy] = useState<"lookup" | "subscribe" | null>(null);
  const [status, setStatus] = useState<MetaCloudWabaSubscriptionStatusDto | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const tokenFieldId = `waba-token-${connectionId}`;
  const wabaFieldId = `waba-id-${connectionId}`;
  const disabled = !canManage || licenseLocked || busy !== null;
  const ready = wabaId.trim().length > 0 && accessToken.trim().length > 0;

  async function run(kind: "lookup" | "subscribe") {
    if (disabled || !ready) return;
    if (
      kind === "subscribe" &&
      !window.confirm(
        "Inscrever o app desta instalação na WABA informada? A Meta passa a entregar as mensagens dessa WABA para este app. Outros apps inscritos não são removidos.",
      )
    ) {
      return;
    }

    const input = { wabaId: wabaId.trim(), accessToken: accessToken.trim() };
    // O token sai da tela já: nunca é reexibido nem guardado no navegador.
    setAccessToken("");
    setBusy(kind);
    setFailure(null);
    try {
      const result =
        kind === "lookup"
          ? await lookupMetaCloudWabaAction(connectionId, input)
          : await subscribeMetaCloudWabaAction(connectionId, { ...input, confirm: true });
      if (result.ok) {
        setStatus(result.data);
      } else {
        setFailure(result);
      }
    } catch {
      setFailure({
        ok: false,
        message: "A consulta falhou. Tente de novo em instantes.",
      });
    } finally {
      setBusy(null);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run("lookup");
  }

  return (
    <section className="meta-waba-subscription" aria-labelledby={`waba-heading-${connectionId}`}>
      <div className="meta-waba-heading">
        <span className="eyebrow">Meta Cloud</span>
        <h3 id={`waba-heading-${connectionId}`}>Inscrição do app na sua WABA</h3>
      </div>

      <ol className="meta-waba-steps">
        <li>
          <strong>Confirmar a URL (handshake):</strong> no app Meta, em Webhooks, cole a URL de
          callback e o verify token e clique em verificar e salvar.
        </li>
        <li>
          <strong>Assinar o campo messages no app:</strong> na mesma tela de Webhooks, assine o campo
          <code> messages</code> do objeto WhatsApp Business Account.
        </li>
        <li>
          <strong>Inscrever o app na WABA:</strong> liga a sua conta do WhatsApp Business a este app.
          Sem isso a Meta não entrega nada, mesmo com os passos 1 e 2 prontos. É o que este bloco faz.
        </li>
      </ol>

      {!canManage ? (
        <p className="action-note">Só o dono ou um admin do workspace pode consultar e inscrever a WABA.</p>
      ) : null}
      {licenseLocked && canManage ? (
        <p className="action-note warn" role="status">
          Licença bloqueada: consultar e inscrever a WABA está indisponível. Verifique /backoffice/license.
        </p>
      ) : null}

      <form className="meta-waba-form" onSubmit={onSubmit} autoComplete="off">
        <div className="meta-waba-field">
          <label htmlFor={wabaFieldId} className="field-label">
            WABA ID (ID da conta do WhatsApp Business)
          </label>
          <input
            id={wabaFieldId}
            name="wabaId"
            inputMode="numeric"
            autoComplete="off"
            value={wabaId}
            onChange={(event) => setWabaId(event.target.value)}
            placeholder="Ex.: 102290129340398"
            maxLength={25}
            disabled={disabled}
            aria-describedby={`${wabaFieldId}-help`}
          />
          <span id={`${wabaFieldId}-help`} className="field-help muted">
            Fica em developers.facebook.com → seu app → WhatsApp → Configuração da API, logo acima do
            número, ou no Gerenciador do WhatsApp. Não é o ID do número (phone number ID).
          </span>
        </div>
        <div className="meta-waba-field">
          <label htmlFor={tokenFieldId} className="field-label">
            Token do app Meta
          </label>
          <input
            id={tokenFieldId}
            name="metaAccessToken"
            type="password"
            autoComplete="new-password"
            data-1p-ignore="true"
            data-lpignore="true"
            spellCheck={false}
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
            placeholder="Cole o token a cada consulta"
            disabled={disabled}
            aria-describedby={`${tokenFieldId}-help`}
            data-presentation-sensitive-field="true"
          />
          <span id={`${tokenFieldId}-help`} className="field-help muted">
            O mais simples: o token temporário de WhatsApp → Configuração da API (vale cerca de 24 h).
            Também serve um do Graph API Explorer ou de system user, desde que seja do mesmo app
            configurado nesta instalação, com whatsapp_business_management e gerado por quem é admin da
            WABA. Ele é usado só nesta consulta e descartado: não é salvo, não volta para a tela e precisa
            ser colado de novo a cada ação.
          </span>
        </div>
        <div className="meta-waba-actions">
          <button className="button" type="submit" disabled={disabled || !ready}>
            <Search size={15} aria-hidden="true" />
            {busy === "lookup" ? "Consultando..." : "Consultar"}
          </button>
          <button
            className="button primary"
            type="button"
            disabled={disabled || !ready}
            onClick={() => void run("subscribe")}
          >
            <Link2 size={15} aria-hidden="true" />
            {busy === "subscribe" ? "Inscrevendo..." : "Inscrever este app"}
          </button>
        </div>
      </form>

      {failure ? (
        <div className="meta-waba-failure">
          <div className="feedback-banner error" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{failure.message}</span>
          </div>
          {showsManualGuide(failure) ? <MetaCloudWabaManualGuide /> : null}
        </div>
      ) : null}

      {status ? <MetaCloudWabaStatusView status={status} /> : null}

      <p className="muted meta-waba-scope-note">
        Regras de frase da equipe não funcionam no Meta Cloud: a Meta não entrega as mensagens que o seu
        time envia. Esta inscrição só libera o recebimento das mensagens dos clientes (CTWA).
      </p>
    </section>
  );
}

export function MetaCloudWabaStatusView({
  status,
}: {
  status: MetaCloudWabaSubscriptionStatusDto;
}) {
  return (
    <div className="meta-waba-result" role="status">
      <div className={`feedback-banner ${status.thisAppSubscribed ? "success" : "warn"}`}>
        {status.thisAppSubscribed ? (
          <Check size={16} aria-hidden="true" />
        ) : (
          <AlertTriangle size={16} aria-hidden="true" />
        )}
        <span>
          {status.thisAppSubscribed
            ? "Este app está inscrito na WABA."
            : "Este app ainda não está inscrito na WABA. Use “Inscrever este app”."}{" "}
          {outcomeLabels[status.outcome]}
        </span>
      </div>

      {status.channelCheck.status === "mismatch" ? (
        <p className="action-note warn">
          {status.channelCheck.mismatchedChannels === 1
            ? "1 número desta conexão não pertence a esta WABA."
            : `${status.channelCheck.mismatchedChannels} números desta conexão não pertencem a esta WABA.`}{" "}
          Confira se o WABA ID é o da conta que recebe os webhooks desta conexão.
        </p>
      ) : null}

      <div className="meta-waba-apps">
        <span className="micro-label">Apps inscritos na WABA</span>
        {status.apps.length === 0 ? (
          <p className="muted">Nenhum app inscrito nesta WABA.</p>
        ) : (
          <ul>
            {status.apps.map((app) => (
              <li key={app.appId} className={app.isThisApp ? "this-app" : undefined}>
                <strong>{app.name ?? "App sem nome"}</strong>
                <code>{app.appId}</code>
                {app.isThisApp ? <span className="event-chip success">Este app</span> : null}
              </li>
            ))}
          </ul>
        )}
        {status.apps.some((app) => !app.isThisApp) ? (
          <p className="muted">Outros apps continuam inscritos; o painel nunca remove nenhum.</p>
        ) : null}
      </div>

      {status.phoneNumbers.length > 0 ? (
        <div className="meta-waba-numbers">
          <span className="micro-label">Números nesta WABA</span>
          <ul>
            {status.phoneNumbers.map((phone) => (
              <li key={phone.id}>
                <PresentationMask placeholder="Número oculto">
                  {phone.displayPhoneNumber ?? phone.id}
                </PresentationMask>
                {phone.verifiedName ? <span className="muted"> · {phone.verifiedName}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function MetaCloudWabaManualGuide() {
  return (
    <details className="meta-waba-manual">
      <summary>Fazer a inscrição manualmente</summary>
      <ol>
        <li>
          Abra o Graph API Explorer (developers.facebook.com/tools/explorer) e escolha o app configurado
          nesta instalação.
        </li>
        <li>Gere um token de usuário com a permissão whatsapp_business_management e selecione a sua WABA.</li>
        <li>
          Faça um POST em <code>&lt;WABA ID&gt;/subscribed_apps</code>, sem parâmetros. A resposta esperada
          é <code>success: true</code>.
        </li>
        <li>
          Confira com um GET no mesmo caminho: o app da instalação precisa aparecer na lista. Não apague
          outros apps.
        </li>
        <li>
          O WABA ID fica no Gerenciador do WhatsApp (configurações da conta) e em WhatsApp → Configuração da
          API no app.
        </li>
      </ol>
    </details>
  );
}
