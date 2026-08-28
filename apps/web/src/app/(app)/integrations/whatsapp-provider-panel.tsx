"use client";

import type { WhatsappConnectionDto } from "@wpptrack/shared";
import { Check, Copy, RefreshCw, Stethoscope, Webhook } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type {
  WhatsappProviderActionResult,
  WhatsappReceiverSecret,
} from "./whatsapp-provider-actions";

type WhatsappProviderAction = (
  formData: FormData,
) => Promise<WhatsappProviderActionResult>;

type ProviderId = "uazapi_byo" | "nod_api" | "waha" | "zapi";

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
}: {
  connections: WhatsappConnectionDto[];
  canManage: boolean;
  createAction: WhatsappProviderAction;
  testAction: WhatsappProviderAction;
  rotateAction: WhatsappProviderAction;
}) {
  const router = useRouter();
  const [provider, setProvider] = useState<ProviderId>("uazapi_byo");
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<WhatsappProviderActionResult | null>(
    null,
  );
  const [receiver, setReceiver] = useState<WhatsappReceiverSecret | null>(null);
  const [copied, setCopied] = useState<"endpoint" | "token" | null>(null);

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
        setCopied(null);
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

  async function copy(value: string, kind: "endpoint" | "token") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
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
            As credenciais ficam somente na API. O receiver usa endpoint sem
            token na URL e token hash-only no servidor.
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
            <strong>Configure o endpoint e envie o token em header</strong>
          </div>
          <input
            readOnly
            value={receiver.endpoint}
            aria-label="Endpoint do receiver WhatsApp"
            data-presentation-sensitive-field="true"
          />
          <button
            className="button"
            type="button"
            onClick={() => void copy(receiver.endpoint, "endpoint")}
          >
            <Copy size={16} aria-hidden="true" />
            {copied === "endpoint" ? "Copiado" : "Copiar endpoint"}
          </button>
          <input
            readOnly
            value={receiver.token}
            aria-label="Token do receiver WhatsApp"
            data-presentation-sensitive-field="true"
          />
          <button
            className="button"
            type="button"
            onClick={() => void copy(receiver.token, "token")}
          >
            <Check size={16} aria-hidden="true" />
            {copied === "token" ? "Copiado" : "Copiar token"}
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
                </div>
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
