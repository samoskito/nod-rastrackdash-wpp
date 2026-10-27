"use client";

import type {
  IntegrationEventParsedSaleDto,
  IntegrationEventPayloadDto,
} from "@wpptrack/shared";
import { isSalesPlatformProvider } from "@wpptrack/shared";
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import type { SingleUrlActionResult } from "./single-url-actions";
import { eventLabel, formatCents, formatWhen } from "./single-url-copy";

/**
 * Fase 6.5 (porte do SaaS #169, só a leitura): "Ver dados recebidos" de uma
 * venda guardada. Mostra o payload com chaves de conta e segredos ocultos ao
 * lado do que o leitor leu. Nada aqui muda o envio: no nod o leitor de uma
 * plataforma validada já entra em uso (produção direta).
 */

type Action = (formData: FormData) => Promise<SingleUrlActionResult>;

export const viewPayloadLabel = "Ver dados recebidos";
export const hidePayloadLabel = "Ocultar dados recebidos";

/** Linhas do que o leitor leu (evento, valor, moeda, produto, data, pedido...). */
export function parsedSaleRows(
  provider: string,
  parsed: IntegrationEventParsedSaleDto,
): Array<[string, string]> {
  const product =
    parsed.productName || parsed.productCode
      ? `${parsed.productName ?? ""}${parsed.productCode ? ` (${parsed.productCode})` : ""}`.trim()
      : "—";
  const offer =
    parsed.offerName || parsed.offerCode
      ? `${parsed.offerName ?? ""}${parsed.offerCode ? ` (${parsed.offerCode})` : ""}`.trim()
      : null;
  const rows: Array<[string, string]> = [
    [
      "Evento",
      isSalesPlatformProvider(provider)
        ? eventLabel(parsed.eventName, provider)
        : parsed.eventName,
    ],
    [
      "Valor",
      parsed.valueCents === null
        ? "—"
        : formatCents(parsed.valueCents, parsed.currency),
    ],
    ["Moeda", parsed.currency ?? "—"],
    ["Produto", product],
  ];
  if (offer) rows.push(["Plano/oferta", offer]);
  rows.push(
    ["Data", parsed.occurredAt ? formatWhen(parsed.occurredAt) : "—"],
    ["Pedido", parsed.orderRef ?? "—"],
    ["Telefone", parsed.phoneMasked ?? "—"],
    ["Status original", parsed.providerStatus ?? "—"],
  );
  // The platform flags its own sample sales (e.g. a Payt test postback).
  if (parsed.test) rows.push(["Venda de exemplo da plataforma", "Sim"]);
  return rows;
}

function ParsedSale({
  provider,
  parsed,
}: {
  provider: string;
  parsed: IntegrationEventParsedSaleDto;
}) {
  return (
    <dl className="unattributed-sale-parsed">
      {parsedSaleRows(provider, parsed).map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Payload (mascarado) ao lado do que foi lido; aviso claro quando expirou. */
export function SalePayloadView({ data }: { data: IntegrationEventPayloadDto }) {
  const sales = isSalesPlatformProvider(data.provider);
  return (
    <div className="conversion-received-payload unattributed-sale-payload">
      {sales ? (
        <div>
          <strong>O que lemos</strong>
          {data.parsed ? (
            <ParsedSale provider={data.provider} parsed={data.parsed} />
          ) : (
            <p className="action-note warn">
              O leitor não reconheceu esta venda
              {data.parseError ? ` (${data.parseError})` : ""}.
            </p>
          )}
        </div>
      ) : null}
      <div>
        <strong>Dados recebidos</strong>
        {data.payloadAvailable ? (
          <>
            <small className="muted">
              Guardado com criptografia até {formatWhen(data.payloadExpiresAt)}.
              Chaves de conta, tokens e segredos aparecem ocultos.
            </small>
            <pre
              className="payload-block"
              data-presentation-sensitive-field="true"
            >
              {typeof data.payload === "string"
                ? data.payload
                : JSON.stringify(data.payload, null, 2)}
            </pre>
          </>
        ) : (
          <p className="action-note warn" role="status">
            {data.payloadMessage ?? "Os dados recebidos já foram apagados."}
          </p>
        )}
      </div>
    </div>
  );
}

/** "Ver dados recebidos" de uma linha (carrega na primeira abertura). */
export function SalePayloadToggle({
  eventId,
  loadPayload,
}: {
  eventId: string;
  loadPayload: Action;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<IntegrationEventPayloadDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    if (data) {
      setOpen(true);
      return;
    }
    setLoading(true);
    setError(null);
    const formData = new FormData();
    formData.set("eventId", eventId);
    const result = await loadPayload(formData).catch(() => null);
    setLoading(false);
    if (result?.ok && result.eventPayload) {
      setData(result.eventPayload);
      setOpen(true);
      return;
    }
    setError(result?.message ?? "Não deu para abrir os dados desta venda.");
  }

  return (
    <>
      <button
        className="button ghost compact-button"
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        disabled={loading}
      >
        {open ? (
          <EyeOff size={14} aria-hidden="true" />
        ) : (
          <Eye size={14} aria-hidden="true" />
        )}
        {loading ? "Abrindo..." : open ? hidePayloadLabel : viewPayloadLabel}
      </button>
      {error ? <small className="action-note warn">{error}</small> : null}
      {open && data ? <SalePayloadView data={data} /> : null}
    </>
  );
}
