"use client";

import type {
  BackofficeIntegrationEventDto,
  IntegrationEventPayloadDto,
} from "@wpptrack/shared";
import { isSalesPlatformProvider } from "@wpptrack/shared";
import { Eye, EyeOff } from "lucide-react";
import { Fragment, useState } from "react";
import type { SingleUrlActionResult } from "../../../../(app)/integrations/single-url/single-url-actions";
import {
  formatCents,
  formatWhen,
  singleUrlPlatformNames,
} from "../../../../(app)/integrations/single-url/single-url-copy";
import {
  hidePayloadLabel,
  SalePayloadView,
  viewPayloadLabel,
} from "../../../../(app)/integrations/single-url/sale-payload-view";
import {
  mappedEventLabel,
  providerStatusLabel,
  statusChip,
} from "./integration-events-copy";

type Action = (formData: FormData) => Promise<SingleUrlActionResult>;

/** Masked payload (or the refusal/expiry message) of any receipt. */
export function ReceiptPayloadView({
  data,
  item,
}: {
  data: IntegrationEventPayloadDto;
  item: BackofficeIntegrationEventDto;
}) {
  // Sales platforms: the same viewer as "Vendas sem atribuição" (never for
  // a refused call: nothing was read from it).
  if (
    isSalesPlatformProvider(data.provider) &&
    data.status !== "rejected" &&
    typeof data.payload !== "string"
  ) {
    return (
      <div className="integration-receipt-payload">
        <p className="muted">
          <strong>Resultado:</strong> {item.resultLabel}
        </p>
        <SalePayloadView data={data} />
      </div>
    );
  }
  return (
    <div className="integration-receipt-payload">
      <p className="muted">
        <strong>Resultado:</strong> {item.resultLabel}
      </p>
      <div className="conversion-received-payload unattributed-sale-payload">
        <div>
          <strong>O que ficou guardado</strong>
          <dl className="unattributed-sale-parsed">
            <div>
              <dt>Evento</dt>
              <dd>{mappedEventLabel(item.provider, item.eventName)}</dd>
            </div>
            <div>
              <dt>Motivo</dt>
              <dd>{data.reasonLabel}</dd>
            </div>
            <div>
              <dt>Recebido em</dt>
              <dd>{formatWhen(data.receivedAt)}</dd>
            </div>
            <div>
              <dt>Tentativas</dt>
              <dd>{item.attemptCount}</dd>
            </div>
          </dl>
        </div>
        <div>
          <strong>Dados recebidos</strong>
          {data.payloadAvailable ? (
            <>
              <small className="muted">
                Guardado com criptografia até{" "}
                {formatWhen(data.payloadExpiresAt)}. Chaves de conta, tokens e
                segredos aparecem ocultos.
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
    </div>
  );
}

function ResultCell({ item }: { item: BackofficeIntegrationEventDto }) {
  const chip = statusChip(item);
  return (
    <span className="integration-receipt-result">
      <span className={`status-chip ${chip.tone}`}>{chip.label}</span>
      <small>{item.resultLabel.replace(/^[^:]+:\s*/u, "")}</small>
      {item.attemptCount > 1 ? (
        <small className="muted">Recebido {item.attemptCount} vezes</small>
      ) : null}
    </span>
  );
}

export function IntegrationEventsTable({
  items,
  loadPayload,
}: {
  items: readonly BackofficeIntegrationEventDto[];
  loadPayload: Action;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [payloads, setPayloads] = useState<
    Record<string, IntegrationEventPayloadDto>
  >({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function toggle(id: string) {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    if (!payloads[id]) {
      setLoadingId(id);
      const formData = new FormData();
      formData.set("eventId", id);
      const result = await loadPayload(formData).catch(() => null);
      setLoadingId(null);
      if (!result?.ok || !result.eventPayload) {
        setErrors((current) => ({
          ...current,
          [id]:
            result?.message ?? "Não deu para abrir os dados deste recebimento.",
        }));
        return;
      }
      const loaded = result.eventPayload;
      setPayloads((current) => ({ ...current, [id]: loaded }));
    }
    setErrors(({ [id]: _removed, ...rest }) => rest);
    setOpenId(id);
  }

  if (items.length === 0) {
    return (
      <p className="muted integration-receipts-empty">
        Nenhum recebimento com estes filtros. Os dados recebidos ficam
        guardados com criptografia por 7 dias; o resumo de cada recebimento,
        por 60 dias (os entregues a uma regra ficam).
      </p>
    );
  }

  return (
    <div className="table-shell integration-receipts-table">
      <table>
        <thead>
          <tr>
            <th>Data/hora</th>
            <th>Cliente</th>
            <th>Plataforma</th>
            <th>Status original</th>
            <th>Evento mapeado</th>
            <th>Resultado</th>
            <th>Valor</th>
            <th>Pedido</th>
            <th>Telefone</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const open = openId === item.id;
            const payload = payloads[item.id];
            return (
              <Fragment key={item.id}>
                <tr className={open ? "open" : undefined}>
                  <td data-label="Data/hora">
                    <span>{formatWhen(item.firstReceivedAt)}</span>
                  </td>
                  <td data-label="Cliente">
                    <span className="integration-receipt-client">
                      <strong>{item.workspaceName ?? "—"}</strong>
                      <small className="single-url-code">
                        {item.workspaceId}
                      </small>
                    </span>
                  </td>
                  <td data-label="Plataforma">
                    <span>{singleUrlPlatformNames[item.provider]}</span>
                  </td>
                  <td data-label="Status original">
                    <span>{providerStatusLabel(item.providerStatus)}</span>
                  </td>
                  <td data-label="Evento mapeado">
                    <span>{mappedEventLabel(item.provider, item.eventName)}</span>
                  </td>
                  <td data-label="Resultado">
                    <ResultCell item={item} />
                  </td>
                  <td data-label="Valor">
                    <span>{formatCents(item.valueCents, item.currency)}</span>
                  </td>
                  <td data-label="Pedido">
                    <span className="single-url-code">
                      {item.orderRef ?? "—"}
                    </span>
                  </td>
                  <td data-label="Telefone">
                    <span>{item.phoneMasked ?? "—"}</span>
                  </td>
                  <td data-label="Ações">
                    <span className="integration-receipt-actions">
                      <button
                        className="button ghost compact-button"
                        type="button"
                        onClick={() => void toggle(item.id)}
                        aria-expanded={open}
                        disabled={loadingId === item.id}
                      >
                        {open ? (
                          <EyeOff size={14} aria-hidden="true" />
                        ) : (
                          <Eye size={14} aria-hidden="true" />
                        )}
                        {loadingId === item.id
                          ? "Abrindo..."
                          : open
                            ? hidePayloadLabel
                            : viewPayloadLabel}
                      </button>
                      {errors[item.id] ? (
                        <small className="action-note warn" role="alert">
                          {errors[item.id]}
                        </small>
                      ) : null}
                    </span>
                  </td>
                </tr>
                {open && payload ? (
                  <tr className="integration-receipt-detail">
                    <td colSpan={10} data-label="Dados recebidos">
                      <ReceiptPayloadView data={payload} item={item} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
