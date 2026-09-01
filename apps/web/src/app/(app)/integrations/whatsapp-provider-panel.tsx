"use client";

import type { WhatsappConnectionDto } from "@wpptrack/shared";
import { Copy, Pencil, RefreshCw, Stethoscope, Webhook } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type {
  WhatsappConnectionEditData,
  WhatsappConnectionEditResult,
  WhatsappProviderActionResult,
  WhatsappReceiverSecret,
} from "./whatsapp-provider-actions";

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
    ingestion: "Receiver e parser Uazapi disponiveis para configuracao.",
    pending: false,
  },
  {
    id: "nod_api",
    title: "NOD API",
    ingestion:
      "Ingestion pendente: o payload do broker ainda nao tem parser compativel comprovado.",
    pending: true,
  },
  {
    id: "waha",
    title: "WAHA",
    ingestion: "Ingestion pendente: receiver e parser WAHA ainda nao existem.",
    pending: true,
  },
  {
    id: "zapi",
    title: "Z-API",
    ingestion: "Ingestion pendente: receiver e parser Z-API ainda nao existem.",
    pending: true,
  },
];

export function WhatsappProviderPanel({
  connections,
  canManage,
  createAction,
  testAction,
  rotateAction,
  editAction,
  loadEditAction,
}: {
  connections: WhatsappConnectionDto[];
  canManage: boolean;
  createAction: WhatsappProviderAction;
  testAction: WhatsappProviderAction;
  rotateAction: WhatsappProviderAction;
  editAction: WhatsappProviderAction;
  loadEditAction: WhatsappProviderLoadEditAction;
}) {
  const router = useRouter();
  const [provider, setProvider] = useState<ProviderId>("uazapi_byo");
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

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    setPending("create");
    setNotice(null);

    try {
      const result = await createAction(new FormData(form));
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
        message: "Nao foi possivel salvar a conexao WhatsApp.",
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
        message: "Nao foi possivel concluir a acao da conexao WhatsApp.",
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
        message: "Nao foi possivel carregar os dados da conexao.",
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
        message: "Nao foi possivel atualizar a conexao WhatsApp.",
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
        message: "Nao foi possivel copiar automaticamente.",
      });
    }
  }

  return (
    <section
      className="surface-panel"
      aria-labelledby="whatsapp-providers-title"
    >
      <div className="inbound-webhook-heading">
        <div>
          <span className="eyebrow">Conexoes WhatsApp</span>
          <h2 id="whatsapp-providers-title">Provedores e receivers</h2>
          <p className="muted">
            As credenciais ficam somente na API. O token do receiver e salvo
            apenas como hash no servidor.
          </p>
        </div>
      </div>

      <div
        className="inbound-counter-grid"
        data-testid="whatsapp-provider-statuses"
      >
        {providerCards.map((card) => (
          <div className="inbound-counter" key={card.id}>
            <strong>{card.title}</strong>
            <span
              className={
                card.pending ? "action-note warn" : "action-note success"
              }
            >
              {card.ingestion}
            </span>
          </div>
        ))}
      </div>

      {canManage ? (
        <form
          className="inbound-webhook-create"
          onSubmit={submitCreate}
          onInvalid={(event) => clearCredentials(event.currentTarget)}
        >
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
          <label>
            <span className="field-label">Nome</span>
            <input name="name" required minLength={1} maxLength={120} />
          </label>
          <label>
            <span className="field-label">Nome exibido</span>
            <input name="displayName" maxLength={120} />
          </label>
          {provider !== "nod_api" ? (
            <label>
              <span className="field-label">URL da API</span>
              <input name="baseUrl" type="url" required />
            </label>
          ) : null}
          {provider === "waha" ? (
            <label>
              <span className="field-label">API key</span>
              <input name="apiKey" type="password" required />
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
              <span className="field-label">Sessao</span>
              <input name="session" />
            </label>
          ) : null}
          <button
            className="button primary"
            type="submit"
            disabled={pending === "create"}
          >
            <Webhook size={16} aria-hidden="true" />
            {pending === "create" ? "Salvando..." : "Salvar conexao"}
          </button>
        </form>
      ) : null}

      {receiver ? (
        <div
          className="inbound-webhook-secret"
          data-presentation-sensitive-action="true"
        >
          <div>
            <span className="micro-label">Exibido uma unica vez</span>
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
          <p className="muted">Nenhuma conexao de provider configurada.</p>
        ) : (
          connections.map((connection) => (
            <div className="inbound-connection-body" key={connection.id}>
              <strong>{connection.displayName ?? connection.name}</strong>
              <span>
                {providerCards.find((card) => card.id === connection.provider)
                  ?.title ?? connection.provider}
              </span>
              {canManage ? (
                <div className="inbound-connection-actions">
                  <button
                    className="button"
                    type="button"
                    disabled={Boolean(pending)}
                    onClick={() =>
                      void runAction(
                        `test-${connection.id}`,
                        testAction,
                        connection.id,
                      )
                    }
                  >
                    <Stethoscope size={15} aria-hidden="true" />
                    {pending === `test-${connection.id}`
                      ? "Testando..."
                      : "Testar"}
                  </button>
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
                </div>
              ) : null}

              {canManage && editing === connection.id && editData ? (
                <form
                  className="inbound-webhook-create"
                  data-testid={`whatsapp-connection-edit-${connection.id}`}
                  onSubmit={submitEdit}
                  onInvalid={(event) => clearCredentials(event.currentTarget)}
                >
                  <input type="hidden" name="connectionId" value={connection.id} />
                  <input type="hidden" name="provider" value={connection.provider} />
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
                      <span className="field-label">Sessao</span>
                      <input
                        name="session"
                        defaultValue={editData.session ?? ""}
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
                        : "Salvar alteracoes"}
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
