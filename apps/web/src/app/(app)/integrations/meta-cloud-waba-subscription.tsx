"use client";

import type {
  MetaCloudWabaCallbackStatusDto,
  MetaCloudWabaCallbackTarget,
  MetaCloudWabaSubscriptionMode,
  MetaCloudWabaSubscriptionStatusDto,
} from "@wpptrack/shared";
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
  override_set:
    "Inscrição feita com a URL desta conexão e confirmada na Meta (reconsultado agora).",
  override_unconfirmed:
    "A Meta aceitou o pedido, mas a reconsulta ainda não mostra a URL desta conexão nesta WABA. Consulte de novo em alguns minutos.",
};

/** Frase simples para cada destino lido na Meta. */
const targetLabels: Record<MetaCloudWabaCallbackTarget, string> = {
  this_connection: "a URL desta conexão",
  other_connection_here: "a URL de outra conexão deste painel",
  other_url: "outro endereço, fora deste painel",
  none: "nenhuma",
  unknown: "não deu para ler",
};

/** Erros que não são falha da Meta: o guia manual não ajuda. */
const noManualGuideCodes = new Set<string>([
  "invalid_input",
  "verify_token_mismatch",
  "callback_url_unavailable",
]);

/** Erros em que o guia manual ajuda (falhas da Meta, não de sessão/licença). */
function showsManualGuide(failure: Failure): boolean {
  return (
    failure.status !== 403 &&
    failure.status !== 423 &&
    !(failure.code && noManualGuideCodes.has(failure.code))
  );
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
  const [mode, setMode] = useState<MetaCloudWabaSubscriptionMode>("standard");
  const [verifyToken, setVerifyToken] = useState("");
  const central = mode === "agency_central_app";
  const verifyFieldId = `waba-verify-${connectionId}`;
  const [busy, setBusy] = useState<"lookup" | "subscribe" | null>(null);
  const [status, setStatus] = useState<MetaCloudWabaSubscriptionStatusDto | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const tokenFieldId = `waba-token-${connectionId}`;
  const wabaFieldId = `waba-id-${connectionId}`;
  const disabled = !canManage || licenseLocked || busy !== null;
  const ready = wabaId.trim().length > 0 && accessToken.trim().length > 0;
  const subscribeReady = ready && (!central || verifyToken.trim().length > 0);

  async function run(kind: "lookup" | "subscribe") {
    if (disabled || !ready) return;
    if (kind === "subscribe" && !subscribeReady) return;
    if (
      kind === "subscribe" &&
      !window.confirm(
        central
          ? "Inscrever o app central da agência na WABA informada, apontando esta WABA para a URL desta conexão? A Meta confere a URL antes de aceitar. Outros apps inscritos não são removidos."
          : "Inscrever o app Meta desta conexão na WABA informada? A Meta passa a entregar as mensagens dessa WABA para este app. Outros apps inscritos não são removidos.",
      )
    ) {
      return;
    }

    const input = { wabaId: wabaId.trim(), accessToken: accessToken.trim() };
    const centralVerifyToken = verifyToken.trim();
    // Os tokens saem da tela já: nunca são reexibidos nem guardados no navegador.
    setAccessToken("");
    setVerifyToken("");
    setBusy(kind);
    setFailure(null);
    try {
      const result =
        kind === "lookup"
          ? await lookupMetaCloudWabaAction(connectionId, input)
          : await subscribeMetaCloudWabaAction(
              connectionId,
              central
                ? {
                    ...input,
                    confirm: true,
                    mode: "agency_central_app",
                    verifyToken: centralVerifyToken,
                  }
                : { ...input, confirm: true },
            );
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

      <fieldset className="meta-waba-mode" disabled={disabled}>
        <legend className="field-label">Qual app Meta entrega as mensagens desta conexão?</legend>
        <label>
          <input
            type="radio"
            name={`waba-mode-${connectionId}`}
            value="standard"
            checked={!central}
            onChange={() => setMode("standard")}
          />
          <span>
            <strong>App desta conexão (padrão)</strong>
            <span className="muted">
              {" "}
              A Meta entrega na URL configurada no próprio app (Webhooks). Serve para um app por
              cliente ou um app só na instalação.
            </span>
          </span>
        </label>
        <label>
          <input
            type="radio"
            name={`waba-mode-${connectionId}`}
            value="agency_central_app"
            checked={central}
            onChange={() => setMode("agency_central_app")}
          />
          <span>
            <strong>App central da agência</strong>
            <span className="muted">
              {" "}
              Um único app da agência para todos os clientes. A inscrição aponta esta WABA para a URL
              desta conexão, sem mexer na URL do app.
            </span>
          </span>
        </label>
      </fieldset>

      <ol className="meta-waba-steps">
        {central ? (
          <li>
            <strong>Preparar o app central (uma vez só):</strong> o cliente compartilha a WABA com o
            Business Manager da agência como parceiro, e um usuário do sistema da agência recebe acesso
            a essa WABA. A URL de Webhooks do app pode ser qualquer uma sua: esta inscrição aponta só
            esta WABA para esta conexão.
          </li>
        ) : (
          <li>
            <strong>Confirmar a URL (handshake):</strong> no app Meta, em Webhooks, cole a URL de
            callback e o verify token e clique em verificar e salvar.
          </li>
        )}
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
            Também serve um do Graph API Explorer ou de system user, desde que seja do mesmo app desta
            conexão (o salvo em “App do Meta desta conexão” ou, sem ele, o configurado na instalação),
            com whatsapp_business_management e gerado por quem é admin da WABA. Ele é usado só nesta consulta e descartado: não é salvo, não volta para a tela e precisa
            ser colado de novo a cada ação.
          </span>
        </div>
        {central ? (
          <div className="meta-waba-field">
            <label htmlFor={verifyFieldId} className="field-label">
              Token de verificação desta conexão
            </label>
            <input
              id={verifyFieldId}
              name="metaVerifyToken"
              type="password"
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              spellCheck={false}
              value={verifyToken}
              onChange={(event) => setVerifyToken(event.target.value)}
              placeholder="Cole a cada inscrição"
              disabled={disabled}
              aria-describedby={`${verifyFieldId}-help`}
              data-presentation-sensitive-field="true"
            />
            <span id={`${verifyFieldId}-help`} className="field-help muted">
              O verify token mostrado quando esta conexão foi criada. A Meta usa esse token para conferir
              a URL desta conexão antes de aceitar. Se você não tem mais, use “Gerar nova URL” nesta
              conexão: no Meta Cloud o endereço continua o mesmo e só este token muda. No app central, o
              token do app Meta acima é o do usuário do sistema da agência, com acesso a esta WABA. O
              token de verificação é usado só nesta inscrição: não é salvo e não volta para a tela.
            </span>
          </div>
        ) : null}
        <div className="meta-waba-actions">
          <button className="button" type="submit" disabled={disabled || !ready}>
            <Search size={15} aria-hidden="true" />
            {busy === "lookup" ? "Consultando..." : "Consultar"}
          </button>
          <button
            className="button primary"
            type="button"
            disabled={disabled || !subscribeReady}
            onClick={() => void run("subscribe")}
          >
            <Link2 size={15} aria-hidden="true" />
            {busy === "subscribe"
              ? "Inscrevendo..."
              : central
                ? "Inscrever com a URL desta conexão"
                : "Inscrever este app"}
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

      <MetaCloudWabaCallbackView callback={status.callback} />

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

/**
 * Para onde a Meta entrega as mensagens desta WABA, em palavras simples,
 * pela ordem da Meta: desvio do número > desvio da WABA > URL do app.
 */
export function MetaCloudWabaCallbackView({
  callback,
}: {
  callback: MetaCloudWabaCallbackStatusDto;
}) {
  const headline: Record<MetaCloudWabaCallbackStatusDto["effective"], string> = {
    this_connection: "As mensagens desta WABA chegam nesta conexão.",
    elsewhere: "As mensagens desta WABA estão indo para outro lugar, não para esta conexão.",
    unknown: "Não deu para confirmar para onde vão as mensagens desta WABA.",
    not_subscribed: "Sem a inscrição do app, a Meta não entrega as mensagens desta WABA.",
  };
  const wabaLine =
    callback.wabaOverride === "this_connection"
      ? "aponta para a URL desta conexão (App central da agência ativo)."
      : callback.wabaOverride === "none"
        ? "nenhum; vale a URL configurada no app."
        : callback.wabaOverride === "other_url" && callback.wabaOverrideHost
          ? `aponta para outro endereço (${callback.wabaOverrideHost}).`
          : `aponta para ${targetLabels[callback.wabaOverride]}.`;
  const phonesElsewhere = callback.phoneOverrides.filter(
    (phone) => phone.target === "other_url" || phone.target === "other_connection_here",
  ).length;

  return (
    <div className="meta-waba-callback">
      <span className="micro-label">Para onde a Meta entrega</span>
      <p
        className={`action-note${callback.effective === "this_connection" ? "" : " warn"}`}
        data-callback-effective={callback.effective}
      >
        {headline[callback.effective]}
      </p>
      <ul>
        <li>
          <strong>Desvio desta WABA:</strong> {wabaLine}
        </li>
        <li>
          <strong>URL configurada no app:</strong>{" "}
          {callback.appCallback === "none" ? "nenhuma." : `${targetLabels[callback.appCallback]}.`}
          {callback.appMessagesField === true ? " Campo messages assinado." : null}
          {callback.appMessagesField === false
            ? " Campo messages não assinado no app: assine em Webhooks do app."
            : null}
        </li>
        {phonesElsewhere > 0 ? (
          <li>
            <strong>Números com desvio próprio:</strong>{" "}
            {phonesElsewhere === 1
              ? "1 número desta WABA aponta para outro lugar (o desvio do número vence o da WABA)."
              : `${phonesElsewhere} números desta WABA apontam para outro lugar (o desvio do número vence o da WABA).`}
          </li>
        ) : null}
      </ul>
      {callback.expectedUrl ? (
        <p className="muted">
          URL desta conexão: <code>{callback.expectedUrl}</code>
        </p>
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
          Abra o Graph API Explorer (developers.facebook.com/tools/explorer) e escolha o app desta
          conexão (o de “App do Meta desta conexão” ou, sem ele, o configurado na instalação).
        </li>
        <li>Gere um token de usuário com a permissão whatsapp_business_management e selecione a sua WABA.</li>
        <li>
          Faça um POST em <code>&lt;WABA ID&gt;/subscribed_apps</code>, sem parâmetros. A resposta esperada
          é <code>success: true</code>.
        </li>
        <li>
          App central da agência: no mesmo POST, envie <code>override_callback_uri</code> com a URL desta
          conexão e <code>verify_token</code> com o token de verificação desta conexão. Atenção: um POST
          sem parâmetros apaga o desvio desta WABA.
        </li>
        <li>
          Confira com um GET no mesmo caminho: o app da instalação precisa aparecer na lista (no App
          central, com <code>override_callback_uri</code> igual à URL desta conexão). Não apague outros
          apps.
        </li>
        <li>
          O WABA ID fica no Gerenciador do WhatsApp (configurações da conta) e em WhatsApp → Configuração da
          API no app.
        </li>
      </ol>
    </details>
  );
}
