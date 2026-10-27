"use client";

import type { WhatsappConnectionDto } from "@wpptrack/shared";
import {
  Copy,
  KeyRound,
  Pencil,
  RefreshCw,
  Stethoscope,
  Trash2,
  Webhook,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import {
  wahaSessionGuidance,
  type WahaSessionGuidance,
} from "./waha-session-guidance";
import type {
  WahaManualSetup,
  WahaWebhookOutcome,
  WhatsappConnectionEditData,
  WhatsappConnectionEditResult,
  WhatsappProviderActionResult,
  WhatsappReceiverSecret,
} from "./whatsapp-provider-actions";
import { whatsappDisconnectAlertText } from "./whatsapp-disconnect-alert";
import {
  WhatsappInstanceActivitySummary,
  type WhatsappInstanceActivities,
} from "./whatsapp-instance-activity";

type WhatsappProviderAction = (
  formData: FormData,
) => Promise<WhatsappProviderActionResult>;

type WhatsappProviderLoadEditAction = (
  connectionId: string,
) => Promise<WhatsappConnectionEditResult>;

type ProviderId = "uazapi_byo" | "nod_api" | "waha" | "zapi";

const secretFieldLabel: Record<ProviderId, string> = {
  uazapi_byo: "Token",
  waha: "API key",
  zapi: "Token",
  nod_api: "Instance token",
};

const receiverInstructionText: Record<ProviderId, string> = {
  uazapi_byo: "Cole esta URL completa no campo URL do webhook da Uazapi",
  waha: "Cole esta URL completa no campo de Webhook da WAHA",
  zapi: "Cole esta URL completa no campo de webhook da Z-API",
  nod_api: "Cole esta URL completa no campo de webhook do NOD API",
};

const providerCards: Array<{
  id: ProviderId;
  title: string;
  ingestion: string;
  pending: boolean;
}> = [
  {
    id: "uazapi_byo",
    title: "Uazapi (BYO)",
    ingestion: "Receptor e parser da Uazapi disponíveis para configuração.",
    pending: false,
  },
  {
    id: "nod_api",
    title: "NOD API",
    ingestion:
      "Em breve: novas conexões ainda não estão disponíveis; as existentes continuam gerenciáveis.",
    pending: true,
  },
  {
    id: "waha",
    title: "WAHA",
    ingestion:
      "WAHA própria, motor GoWS: a entrada de lead de anúncio (CTWA) e as regras de frase da equipe (Conversões) já funcionam.",
    pending: false,
  },
  {
    id: "zapi",
    title: "Z-API",
    ingestion:
      "Em breve: novas conexões ainda não estão disponíveis; as existentes continuam gerenciáveis.",
    pending: true,
  },
];

export type WhatsappProviderId = ProviderId;

export function WhatsappProviderPanel({
  connections: allConnections,
  provider: scopedProvider,
  canManage,
  createAction,
  testAction,
  rotateAction,
  editAction,
  loadEditAction,
  deleteAction,
  configureWebhookAction,
  licenseLocked = false,
  allowCreate = true,
  activities = {},
}: {
  connections: WhatsappConnectionDto[];
  /**
   * Scopes the panel to one provider (Integrations hub modal): only its
   * connections and status are shown and the create form is fixed to it.
   */
  provider?: ProviderId;
  canManage: boolean;
  createAction: WhatsappProviderAction;
  testAction: WhatsappProviderAction;
  rotateAction: WhatsappProviderAction;
  editAction: WhatsappProviderAction;
  loadEditAction: WhatsappProviderLoadEditAction;
  deleteAction: WhatsappProviderAction;
  /** Só WAHA: grava o webhook direto na WAHA do aluno. */
  configureWebhookAction?: WhatsappProviderAction;
  /**
   * Client-side hint only (the API stays the authority with HTTP 423): while
   * the license is locked every write control is disabled.
   */
  licenseLocked?: boolean;
  /** False for "Em breve" providers: existing connections stay manageable. */
  allowCreate?: boolean;
  /**
   * Fase 6.3b (porte do SaaS #126): atividade de cada conexão Uazapi BYO ou
   * WAHA (leads de anúncio e último webhook), lida pela página. Só leitura.
   */
  activities?: WhatsappInstanceActivities;
}) {
  const titleId = useId();
  const router = useRouter();
  const [provider, setProvider] = useState<ProviderId>(
    scopedProvider ?? "uazapi_byo",
  );
  const connections = scopedProvider
    ? allConnections.filter(
        (connection) => connection.provider === scopedProvider,
      )
    : allConnections;
  const visibleCards = scopedProvider
    ? providerCards.filter((card) => card.id === scopedProvider)
    : providerCards;
  const scopedTitle = visibleCards[0]?.title;
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<WhatsappProviderActionResult | null>(
    null,
  );
  const [receiver, setReceiver] = useState<WhatsappReceiverSecret | null>(null);
  const [receiverProvider, setReceiverProvider] = useState<ProviderId | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editData, setEditData] = useState<WhatsappConnectionEditData | null>(
    null,
  );
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [wahaStates, setWahaStates] = useState<
    Record<string, WahaConnectionState>
  >({});
  const [rotateConfirmId, setRotateConfirmId] = useState<string | null>(null);
  const [configureConfirmId, setConfigureConfirmId] = useState<
    string | null
  >(null);
  const [manualCopied, setManualCopied] = useState<string | null>(null);

  function patchWaha(
    connectionId: string,
    patch: Partial<WahaConnectionState>,
  ) {
    setWahaStates((current) => ({
      ...current,
      [connectionId]: { ...current[connectionId], ...patch },
    }));
  }

  async function runWahaAction(
    kind: "test" | "configure" | "manual",
    connectionId: string,
  ) {
    if (pending) return;
    const action =
      kind === "test"
        ? testAction
        : kind === "configure"
          ? configureWebhookAction
          : rotateAction;
    if (!action) return;
    setPending(`waha-${kind}-${connectionId}`);
    setNotice(null);
    const formData = new FormData();
    formData.set("connectionId", connectionId);
    try {
      const result = await action(formData);
      if (kind === "test") {
        patchWaha(connectionId, {
          status: {
            ok: result.ok,
            providerStatus: result.providerStatus ?? null,
            message: result.message,
          },
        });
      } else if (kind === "configure") {
        patchWaha(connectionId, {
          webhook: result.wahaWebhook
            ? { ...result.wahaWebhook, message: result.message, ok: result.ok }
            : undefined,
        });
        if (result.providerStatus) {
          patchWaha(connectionId, {
            status: {
              ok: result.providerStatus === "WORKING",
              providerStatus: result.providerStatus,
              message:
                wahaSessionGuidance(result.providerStatus)?.instruction ?? "",
            },
          });
        }
        if (!result.wahaWebhook) setNotice(result);
      } else if (result.wahaManualSetup) {
        patchWaha(connectionId, { manual: result.wahaManualSetup });
        setManualCopied(null);
        setNotice(result);
      } else {
        setNotice(result);
      }
      if (result.ok) router.refresh();
    } catch {
      setNotice({
        ok: false,
        message: "Não foi possível concluir a ação da conexão WAHA.",
      });
    } finally {
      setPending(null);
      setRotateConfirmId(null);
      setConfigureConfirmId(null);
    }
  }

  async function copyManual(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setManualCopied(key);
    } catch {
      setNotice({
        ok: false,
        message: "Não foi possível copiar automaticamente.",
      });
    }
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const createData = new FormData(form);
    if (createData.get("provider") === "waha") {
      const problem = validateWahaCreate(createData);
      if (problem) {
        clearCredentials(form);
        setNotice({ ok: false, message: problem });
        return;
      }
    }
    setPending("create");
    setNotice(null);

    try {
      const result = await createAction(createData);
      setNotice(result);
      if (result.ok) {
        form.reset();
        router.refresh();
      } else {
        clearCredentials(form);
      }
    } catch {
      clearCredentials(form);
      setNotice({
        ok: false,
        message: "Não foi possível salvar a conexão WhatsApp.",
      });
    } finally {
      setPending(null);
    }
  }

  async function runAction(
    key: string,
    action: WhatsappProviderAction,
    connectionId: string,
  ) {
    if (pending) return;
    setPending(key);
    setNotice(null);
    const formData = new FormData();
    formData.set("connectionId", connectionId);
    try {
      const result = await action(formData);
      setNotice(result);
      if (result.receiverSecret) {
        setReceiver(result.receiverSecret);
        setReceiverProvider(
          connections.find((connection) => connection.id === connectionId)
            ?.provider ?? null,
        );
        setCopied(false);
      }
      if (result.ok) router.refresh();
    } catch {
      setNotice({
        ok: false,
        message: "Não foi possível concluir a ação da conexão WhatsApp.",
      });
    } finally {
      setPending(null);
    }
  }

  async function openEdit(connectionId: string) {
    if (pending) return;
    if (editing === connectionId) {
      closeEdit();
      return;
    }
    setPending(`edit-load-${connectionId}`);
    setNotice(null);
    try {
      const result = await loadEditAction(connectionId);
      if (result.ok) {
        setEditData(result.data);
        setEditing(connectionId);
      } else {
        setNotice(result);
      }
    } catch {
      setNotice({
        ok: false,
        message: "Não foi possível carregar os dados da conexão.",
      });
    } finally {
      setPending(null);
    }
  }

  function closeEdit() {
    setEditing(null);
    setEditData(null);
  }

  async function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !editing) return;
    const form = event.currentTarget;
    const connectionId = editing;
    setPending(`edit-${connectionId}`);
    setNotice(null);

    try {
      const result = await editAction(new FormData(form));
      setNotice(result);
      clearCredentials(form);
      if (result.ok) {
        closeEdit();
        router.refresh();
      }
    } catch {
      clearCredentials(form);
      setNotice({
        ok: false,
        message: "Não foi possível atualizar a conexão WhatsApp.",
      });
    } finally {
      setPending(null);
    }
  }

  function openDeleteConfirm(connectionId: string) {
    if (pending) return;
    if (deleteConfirmId === connectionId) {
      closeDeleteConfirm();
      return;
    }
    closeEdit();
    setNotice(null);
    setDeleteConfirmId(connectionId);
    setDeleteConfirmText("");
  }

  function closeDeleteConfirm() {
    setDeleteConfirmId(null);
    setDeleteConfirmText("");
  }

  async function confirmDelete(connection: WhatsappConnectionDto) {
    if (pending) return;
    const key = `delete-${connection.id}`;
    setPending(key);
    setNotice(null);
    const formData = new FormData();
    formData.set("connectionId", connection.id);
    try {
      const result = await deleteAction(formData);
      setNotice(result);
      if (result.ok) {
        closeDeleteConfirm();
        router.refresh();
      }
    } catch {
      setNotice({
        ok: false,
        message: "Não foi possível excluir a conexão WhatsApp.",
      });
    } finally {
      setPending(null);
    }
  }

  async function copyWebhookUrl() {
    try {
      if (!receiver) return;
      await navigator.clipboard.writeText(receiver.webhookUrl);
      setCopied(true);
    } catch {
      setNotice({
        ok: false,
        message: "Não foi possível copiar automaticamente.",
      });
    }
  }

  return (
    <section
      className="surface-panel"
      aria-labelledby={titleId}
    >
      <div className="inbound-webhook-heading">
        <div>
          <span className="eyebrow">Conexões WhatsApp</span>
          <h2 id={titleId}>
            {scopedProvider
              ? `Conexões ${scopedTitle ?? scopedProvider}`
              : "Provedores e receivers"}
          </h2>
          <p className="muted">
            As credenciais ficam somente na API. O token do receiver e salvo
            apenas como hash no servidor.
          </p>
        </div>
      </div>

      <fieldset className="license-lock-scope" disabled={licenseLocked}>
      {licenseLocked && canManage ? (
        <p className="action-note warn" role="status">
          Licença bloqueada: criar, testar, editar e excluir conexões está
          indisponível. Verifique /backoffice/license.
        </p>
      ) : null}
      {scopedProvider ? null : (
        <p className="muted">
          Usa Umbler Talk ou Gupshup? Essas plataformas são configuradas no
          bloco de webhooks logo abaixo, e não nesta lista.
        </p>
      )}

      <div
        className={
          scopedProvider === "waha"
            ? "inbound-counter-grid waha-counter"
            : "inbound-counter-grid"
        }
        data-testid="whatsapp-provider-statuses"
      >
        {visibleCards.map((card) => (
          <div className="inbound-counter" key={card.id}>
            <strong>{card.title}</strong>
            <p className={card.pending ? "muted action-note warn" : "muted"}>
              {card.ingestion}
            </p>
          </div>
        ))}
      </div>

      {scopedProvider === "waha" ? (
        <div className="waha-intro" data-testid="waha-intro">
          <p>
            A WAHA é <strong>sua</strong>: você hospeda o servidor (motor
            GoWS), cria a sessão e lê o QR no painel da sua WAHA. O
            RastrackDash não fornece servidor e não mostra QR.
          </p>
          <ol>
            <li>No painel da sua WAHA, crie a sessão e leia o QR.</li>
            <li>Aqui, informe nome, URL do servidor, API key e sessão.</li>
            <li>Teste a conexão e configure o webhook.</li>
          </ol>
        </div>
      ) : null}

      {!allowCreate ? (
        <p className="action-note" role="status">
          Novas conexões deste provedor estão em breve. As conexões que você já
          tem continuam disponíveis para testar, editar e excluir.
        </p>
      ) : null}

      {canManage && allowCreate ? (
        <form
          className={
            provider === "waha"
              ? "inbound-webhook-create waha-create"
              : "inbound-webhook-create"
          }
          onSubmit={submitCreate}
          onInvalid={(event) => clearCredentials(event.currentTarget)}
        >
          {scopedProvider ? (
            <input type="hidden" name="provider" value={scopedProvider} />
          ) : (
            <label>
              <span className="field-label">Provedor</span>
              <select
                name="provider"
                value={provider}
                onChange={(event) =>
                  setProvider(event.target.value as ProviderId)
                }
              >
                {providerCards.map((card) => (
                  <option key={card.id} value={card.id}>
                    {card.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span className="field-label">Nome</span>
            <input name="name" required minLength={1} maxLength={120} />
          </label>
          {provider !== "waha" ? (
            <label>
              <span className="field-label">Nome exibido</span>
              <input name="displayName" maxLength={120} />
            </label>
          ) : null}
          {provider !== "nod_api" ? (
            <label>
              <span className="field-label">URL da API</span>
              <input
                name="baseUrl"
                type="url"
                required
                placeholder={
                  provider === "waha" ? "https://waha.seudominio.com" : undefined
                }
              />
              {provider === "waha" ? (
                <small className="muted">
                  URL do seu servidor WAHA, sem /api no fim.
                </small>
              ) : null}
            </label>
          ) : null}
          {provider === "waha" ? (
            <label>
              <span className="field-label">API key</span>
              <input
                name="apiKey"
                type="password"
                autoComplete="new-password"
                required
              />
              <small className="muted">
                A chave do seu servidor WAHA. Fica guardada só na API e não
                aparece de novo na tela.
              </small>
            </label>
          ) : null}
          {provider === "uazapi_byo" || provider === "zapi" ? (
            <label>
              <span className="field-label">Token</span>
              <input name="token" type="password" required />
            </label>
          ) : null}
          {provider === "uazapi_byo" ||
          provider === "zapi" ||
          provider === "nod_api" ? (
            <label>
              <span className="field-label">Instance ID</span>
              <input name="instanceId" required={provider !== "uazapi_byo"} />
            </label>
          ) : null}
          {provider === "nod_api" ? (
            <label>
              <span className="field-label">Instance token</span>
              <input name="instanceToken" type="password" required />
            </label>
          ) : null}
          {provider === "waha" ? (
            <label>
              <span className="field-label">Sessão</span>
              <input
                name="session"
                required
                maxLength={200}
                placeholder="default"
              />
              <small className="muted">
                O nome exato da sessão criada no painel da sua WAHA.
              </small>
            </label>
          ) : null}
          <button
            className="button primary"
            type="submit"
            disabled={pending === "create"}
          >
            <Webhook size={16} aria-hidden="true" />
            {pending === "create" ? "Salvando..." : "Salvar conexão"}
          </button>
        </form>
      ) : null}

      {receiver ? (
        <div
          className="inbound-webhook-secret"
          data-presentation-sensitive-action="true"
        >
          <div>
            <span className="micro-label">Exibido uma única vez</span>
            <strong>
              {receiverProvider
                ? receiverInstructionText[receiverProvider]
                : "Cole esta URL completa no campo de webhook do provider"}
            </strong>
          </div>
          <input
            readOnly
            value={receiver.webhookUrl}
            aria-label="URL completa do receiver WhatsApp"
            data-presentation-sensitive-field="true"
          />
          <button
            className="button"
            type="button"
            onClick={() => void copyWebhookUrl()}
          >
            <Copy size={16} aria-hidden="true" />
            {copied ? "Copiada" : "Copiar URL completa"}
          </button>
        </div>
      ) : null}
      {notice ? (
        <div
          className={`feedback-banner ${notice.ok ? "success" : "warn"}`}
          role={notice.ok ? "status" : "alert"}
        >
          {notice.message}
        </div>
      ) : null}

      <div className="inbound-connection-list">
        {connections.length === 0 ? (
          <p className="muted">Nenhuma conexão de provider configurada.</p>
        ) : (
          connections.map((connection) => (
            <div className="inbound-connection-body" key={connection.id}>
              <strong>{connection.displayName ?? connection.name}</strong>
              <span>
                {providerCards.find((card) => card.id === connection.provider)
                  ?.title ?? connection.provider}
              </span>
              {whatsappDisconnectAlertText(connection) ? (
                <p
                  className="action-note warn whatsapp-disconnect-alert"
                  role="alert"
                >
                  {whatsappDisconnectAlertText(connection)}
                </p>
              ) : null}
              {connection.provider === "uazapi_byo" ||
              connection.provider === "waha" ? (
                <section
                  className="inbound-instance-activity"
                  aria-label="Atividade do número WhatsApp"
                >
                  <span className="micro-label">Atividade do número</span>
                  <WhatsappInstanceActivitySummary
                    view={activities[connection.id]}
                    whatsappInstanceId={connection.id}
                  />
                </section>
              ) : null}
              {canManage ? (
                <div className="inbound-connection-actions">
                  <button
                    className="button"
                    type="button"
                    disabled={Boolean(pending)}
                    onClick={() =>
                      connection.provider === "waha"
                        ? void runWahaAction("test", connection.id)
                        : void runAction(
                            `test-${connection.id}`,
                            testAction,
                            connection.id,
                          )
                    }
                  >
                    <Stethoscope size={15} aria-hidden="true" />
                    {pending === `test-${connection.id}` ||
                    pending === `waha-test-${connection.id}`
                      ? "Testando..."
                      : connection.provider === "waha"
                        ? "Testar conexão"
                        : "Testar"}
                  </button>
                  {connection.provider === "waha" ? (
                    <>
                      {configureWebhookAction ? (
                        <button
                          className="button"
                          type="button"
                          disabled={Boolean(pending)}
                          onClick={() => {
                            setRotateConfirmId(null);
                            setConfigureConfirmId(
                              configureConfirmId === connection.id
                                ? null
                                : connection.id,
                            );
                          }}
                        >
                          <Webhook size={15} aria-hidden="true" />
                          {pending === `waha-configure-${connection.id}`
                            ? "Configurando..."
                            : "Configurar webhook"}
                        </button>
                      ) : null}
                      <button
                        className="button"
                        type="button"
                        disabled={Boolean(pending)}
                        onClick={() => {
                          setConfigureConfirmId(null);
                          setRotateConfirmId(
                            rotateConfirmId === connection.id
                              ? null
                              : connection.id,
                          );
                        }}
                      >
                        <KeyRound size={15} aria-hidden="true" />
                        Configuração manual
                      </button>
                    </>
                  ) : (
                    <button
                      className="button"
                      type="button"
                      disabled={Boolean(pending)}
                      onClick={() =>
                        void runAction(
                          `rotate-${connection.id}`,
                          rotateAction,
                          connection.id,
                        )
                      }
                    >
                      <RefreshCw size={15} aria-hidden="true" />
                      Gerar receiver
                    </button>
                  )}
                  <button
                    className="button"
                    type="button"
                    disabled={Boolean(pending) && editing !== connection.id}
                    onClick={() => void openEdit(connection.id)}
                  >
                    <Pencil size={15} aria-hidden="true" />
                    {pending === `edit-load-${connection.id}`
                      ? "Carregando..."
                      : "Editar"}
                  </button>
                  <button
                    className="button danger"
                    type="button"
                    disabled={
                      Boolean(pending) && deleteConfirmId !== connection.id
                    }
                    onClick={() => openDeleteConfirm(connection.id)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                    Excluir
                  </button>
                </div>
              ) : null}

              {connection.provider === "waha" ? (
                <WahaConnectionDetails
                  connectionId={connection.id}
                  state={wahaStates[connection.id]}
                  canManage={canManage}
                  confirmingRotate={rotateConfirmId === connection.id}
                  confirmingConfigure={configureConfirmId === connection.id}
                  configuring={pending === `waha-configure-${connection.id}`}
                  onConfirmConfigure={() =>
                    void runWahaAction("configure", connection.id)
                  }
                  onCancelConfigure={() => setConfigureConfirmId(null)}
                  busy={Boolean(pending)}
                  rotating={pending === `waha-manual-${connection.id}`}
                  copiedKey={manualCopied}
                  onConfirmRotate={() =>
                    void runWahaAction("manual", connection.id)
                  }
                  onCancelRotate={() => setRotateConfirmId(null)}
                  onCopy={(key, value) => void copyManual(key, value)}
                  onHideManual={() => {
                    patchWaha(connection.id, { manual: undefined });
                    setManualCopied(null);
                  }}
                />
              ) : null}

              {canManage && deleteConfirmId === connection.id ? (
                <div
                  className="inbound-connection-delete-confirm"
                  data-testid={`whatsapp-connection-delete-confirm-${connection.id}`}
                >
                  <p className="action-note warn">
                    Isso desativa a conexão e ela deixa de aparecer na lista.
                    Para confirmar, digite o nome{" "}
                    <strong>{connection.name}</strong> abaixo.
                  </p>
                  <label>
                    <span className="field-label">Nome da conexão</span>
                    <input
                      autoComplete="off"
                      value={deleteConfirmText}
                      onChange={(event) =>
                        setDeleteConfirmText(event.target.value)
                      }
                      aria-label={`Confirmar exclusão da conexão ${connection.name} digitando o nome`}
                    />
                  </label>
                  <div className="inbound-connection-actions">
                    <button
                      className="button danger"
                      type="button"
                      disabled={
                        pending === `delete-${connection.id}` ||
                        deleteConfirmText.trim() !== connection.name
                      }
                      onClick={() => void confirmDelete(connection)}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                      {pending === `delete-${connection.id}`
                        ? "Excluindo..."
                        : "Confirmar exclusão"}
                    </button>
                    <button
                      className="button"
                      type="button"
                      disabled={Boolean(pending)}
                      onClick={closeDeleteConfirm}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : null}

              {canManage && editing === connection.id && editData ? (
                <form
                  className="inbound-webhook-create"
                  data-testid={`whatsapp-connection-edit-${connection.id}`}
                  onSubmit={submitEdit}
                  onInvalid={(event) => clearCredentials(event.currentTarget)}
                >
                  <input
                    type="hidden"
                    name="connectionId"
                    value={connection.id}
                  />
                  <input
                    type="hidden"
                    name="provider"
                    value={connection.provider}
                  />
                  <label>
                    <span className="field-label">Provedor</span>
                    <input
                      value={
                        providerCards.find(
                          (card) => card.id === connection.provider,
                        )?.title ?? connection.provider
                      }
                      disabled
                      readOnly
                    />
                  </label>
                  <label>
                    <span className="field-label">Nome</span>
                    <input
                      name="name"
                      defaultValue={editData.name}
                      required
                      minLength={1}
                      maxLength={120}
                    />
                  </label>
                  <label>
                    <span className="field-label">Nome exibido</span>
                    <input
                      name="displayName"
                      defaultValue={editData.displayName ?? ""}
                      maxLength={120}
                    />
                  </label>
                  {connection.provider !== "nod_api" ? (
                    <label>
                      <span className="field-label">URL da API</span>
                      <input
                        name="baseUrl"
                        type="url"
                        defaultValue={editData.baseUrl ?? ""}
                        required
                      />
                    </label>
                  ) : null}
                  {connection.provider === "uazapi_byo" ||
                  connection.provider === "zapi" ||
                  connection.provider === "nod_api" ? (
                    <label>
                      <span className="field-label">Instance ID</span>
                      <input
                        name="instanceId"
                        defaultValue={editData.instanceId ?? ""}
                        required={connection.provider !== "uazapi_byo"}
                      />
                    </label>
                  ) : null}
                  {connection.provider === "waha" ? (
                    <label>
                      <span className="field-label">Sessão</span>
                      <input
                        name="session"
                        defaultValue={editData.session ?? ""}
                        required
                      />
                    </label>
                  ) : null}
                  <label>
                    <span className="field-label">
                      {secretFieldLabel[connection.provider]}
                    </span>
                    <input
                      name="secret"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Deixe em branco para manter atual"
                    />
                  </label>
                  <div className="inbound-connection-actions">
                    <button
                      className="button primary"
                      type="submit"
                      disabled={pending === `edit-${connection.id}`}
                    >
                      {pending === `edit-${connection.id}`
                        ? "Salvando..."
                        : "Salvar alterações"}
                    </button>
                    <button
                      className="button"
                      type="button"
                      disabled={Boolean(pending)}
                      onClick={closeEdit}
                    >
                      Cancelar
                    </button>
                  </div>
                </form>
              ) : null}
            </div>
          ))
        )}
      </div>
      </fieldset>
    </section>
  );
}

function clearCredentials(form: HTMLFormElement) {
  form
    .querySelectorAll<HTMLInputElement>('input[type="password"]')
    .forEach((input) => {
      input.value = "";
    });
}

type WahaConnectionState = {
  status?: {
    ok: boolean;
    providerStatus: string | null;
    message: string;
  };
  webhook?: WahaWebhookOutcome & { ok: boolean; message: string };
  manual?: WahaManualSetup;
};

function validateWahaCreate(formData: FormData): string | null {
  const text = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
  };
  if (!text("name")) return "Informe o nome da conexão.";
  const baseUrl = text("baseUrl");
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    return "Informe a URL do servidor WAHA começando com http:// ou https://.";
  }
  if (!text("apiKey")) return "Informe a API key da sua WAHA.";
  if (!text("session")) {
    return "Informe o nome da sessão criada no painel da sua WAHA.";
  }
  return null;
}

function WahaConnectionDetails({
  connectionId,
  state,
  canManage,
  confirmingRotate,
  confirmingConfigure = false,
  configuring = false,
  busy,
  rotating,
  copiedKey,
  onConfirmRotate,
  onCancelRotate,
  onConfirmConfigure,
  onCancelConfigure,
  onCopy,
  onHideManual,
}: {
  connectionId: string;
  state?: WahaConnectionState;
  canManage: boolean;
  confirmingRotate: boolean;
  confirmingConfigure?: boolean;
  configuring?: boolean;
  onConfirmConfigure?: () => void;
  onCancelConfigure?: () => void;
  busy: boolean;
  rotating: boolean;
  copiedKey: string | null;
  onConfirmRotate: () => void;
  onCancelRotate: () => void;
  onCopy: (key: string, value: string) => void;
  onHideManual: () => void;
}) {
  const guidance: WahaSessionGuidance | null = state?.status
    ? wahaSessionGuidance(state.status.providerStatus)
    : null;
  const manual = state?.manual;

  return (
    <div className="waha-details" data-testid={`waha-details-${connectionId}`}>
      {state?.status ? (
        <div
          className={`waha-status ${guidance?.tone ?? "error"}`}
          data-testid="waha-session-status"
          role="status"
        >
          <span className="micro-label">Status da sessão</span>
          <strong>{guidance?.label ?? "Sem resposta"}</strong>
          <p>{guidance?.instruction ?? state.status.message}</p>
        </div>
      ) : null}

      {state?.webhook ? (
        <div
          className={`waha-status ${state.webhook.ok ? "ok" : "error"}`}
          data-testid="waha-webhook-result"
          role="status"
        >
          <span className="micro-label">Webhook</span>
          <strong>
            {state.webhook.configured
              ? "Webhook configurado"
              : "Webhook não configurado"}
          </strong>
          <p>{state.webhook.message}</p>
          {state.webhook.configured ? (
            <p className="muted">
              Eventos assinados: {state.webhook.events.join(", ")}.
            </p>
          ) : (
            <p className="muted">
              Nada mudou no app nem na sua WAHA. Corrija o ponto acima ou use a
              configuração manual.
            </p>
          )}
        </div>
      ) : null}

      {canManage && confirmingConfigure && onConfirmConfigure ? (
        <div className="waha-confirm" data-testid="waha-configure-confirm">
          <p className="action-note warn">
            Ao salvar o webhook, a sua WAHA reinicia a sessão. Ela volta em
            alguns segundos, sem ler o QR de novo, mas mensagens podem atrasar
            nesse intervalo. O token anterior deixa de valer.
          </p>
          <div className="inbound-connection-actions">
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={onConfirmConfigure}
            >
              {configuring ? "Configurando..." : "Reiniciar e configurar"}
            </button>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={onCancelConfigure}
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : null}

      {canManage && confirmingRotate ? (
        <div className="waha-confirm" data-testid="waha-rotate-confirm">
          <p className="action-note warn">
            Isso gera um novo token e o webhook atual deixa de valer até você
            colar a nova configuração na sua WAHA. O token aparece uma única
            vez.
          </p>
          <div className="inbound-connection-actions">
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={onConfirmRotate}
            >
              {rotating ? "Gerando..." : "Gerar novo token e mostrar"}
            </button>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={onCancelRotate}
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : null}

      {manual ? (
        <div
          className="inbound-webhook-secret waha-manual"
          data-testid="waha-manual-setup"
          data-presentation-sensitive-action="true"
        >
          <div>
            <span className="micro-label">Exibido uma única vez</span>
            <strong>Configuração manual na sua WAHA</strong>
            <p className="muted">
              No painel da sua WAHA, abra os Webhooks da sessão, cole a URL
              abaixo e adicione o cabeçalho <code>{manual.tokenHeaderName}</code>{" "}
              com o token. Marque os eventos listados.
            </p>
          </div>
          <input readOnly value={manual.webhookUrl} aria-label="URL do webhook" />
          <button
            className="button"
            type="button"
            onClick={() => onCopy("url", manual.webhookUrl)}
          >
            <Copy size={16} aria-hidden="true" />
            {copiedKey === "url" ? "Copiada" : "Copiar URL"}
          </button>
          <p>
            Cabeçalho: <strong>{manual.tokenHeaderName}</strong>
          </p>
          <input
            readOnly
            value={manual.webhookToken}
            aria-label="Token do webhook"
            data-presentation-sensitive-field="true"
          />
          <button
            className="button"
            type="button"
            onClick={() => onCopy("token", manual.webhookToken)}
          >
            <Copy size={16} aria-hidden="true" />
            {copiedKey === "token" ? "Copiado" : "Copiar token"}
          </button>
          <p>
            Eventos: <strong>{manual.events.join(", ")}</strong>
          </p>
          <p className="muted">
            Alternativa, se a sua WAHA não aceitar cabeçalho: a URL com{" "}
            <code>?token=</code>. Ela pode aparecer nos logs da WAHA e do
            proxy; prefira o cabeçalho.
          </p>
          <input
            readOnly
            value={manual.webhookUrlWithToken}
            aria-label="URL do webhook com token"
            data-presentation-sensitive-field="true"
          />
          <button
            className="button"
            type="button"
            onClick={() => onCopy("url-token", manual.webhookUrlWithToken)}
          >
            <Copy size={16} aria-hidden="true" />
            {copiedKey === "url-token" ? "Copiada" : "Copiar URL com token"}
          </button>
          <button className="button" type="button" onClick={onHideManual}>
            Ocultar
          </button>
        </div>
      ) : null}
    </div>
  );
}
