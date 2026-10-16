"use client";

import type {
  ConversionEventCategoryDto,
  ConversionEventNameDto,
  ProviderConversionRuleCapabilitiesDto,
  ProviderConversionRuleOriginDto,
} from "@wpptrack/shared";
import {
  conversionEventCarriesValue,
  conversionEventCatalogOrdered,
  conversionEventMetadata,
  conversionEventRequiresValue,
} from "@wpptrack/shared";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Plus, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PresentationMask } from "../../../components/presentation-mask";
import {
  accentEventCopy,
  paytBetaBadge,
  paytEventExplanations,
  paytEventLabel,
  ruleEventLabelForOrigin,
} from "./event-copy";
import { conversionsLicenseLockedNote } from "./license-lock";
import { NumbersWithoutRules } from "./numbers-without-rules";
import { MessagePhraseFields } from "./message-phrase-fields";
import { PaytSetupPanel } from "./payt-setup";
import { UmblerAutomationPayloadPanel } from "./umbler-automation-payload";
import { UnnichatAutomationSetupPanel } from "../integrations/unnichat-setup";
import { UazapiLabelPicker } from "../integrations/uazapi-label-picker";
import type { ConversionScreenActionResult } from "./actions";
import {
  contactMessageProviders,
  crmManageHref,
  hubProviderForInbound,
  originBetaEvents,
  originEventNames,
  providerLogo,
  ruleOriginDefinition,
  type CrmRuleOrigin,
  type RuleOriginId,
} from "./conversion-origins";
import {
  connectionsForOrigin,
  ineligibleNumbers,
  numbersForOrigin,
  type ConversionConnection,
  type ConversionNumber,
} from "./conversion-rules-view";
import type { ComingSoonNumber } from "./conversions-data";
import {
  buildRulePayload,
  emptyRuleDraft,
  mintRequestKey,
  paytSingleConnectionNote,
  resolveRuleConnectionId,
  scopeIssue,
  type RuleDraft,
} from "./rule-draft";
import { RuleLogo } from "./rule-logo";

type CreateAction = (formData: FormData) => Promise<ConversionScreenActionResult>;
type ConfirmAction = CreateAction;

type Step = "origin" | "event" | "scope" | "details" | "done";

const stepOrder: Array<{ id: Exclude<Step, "done">; label: string }> = [
  { id: "origin", label: "Origem" },
  { id: "event", label: "Evento" },
  { id: "scope", label: "Alcance" },
  { id: "details", label: "Detalhes" },
];

const eventCategoryLabels: Record<ConversionEventCategoryDto, string> = {
  journey: "Jornada",
  conversion: "Conversão",
  operational: "Pedido",
};

export type NewRuleFlowProps = {
  offeredOrigins: RuleOriginId[];
  initialOrigin?: RuleOriginId | null;
  numbers: ConversionNumber[];
  connections: ConversionConnection[];
  capabilities: ProviderConversionRuleCapabilitiesDto | null;
  /** Números de WAHA, Z-API e NOD API: aparecem como “Em breve”. */
  comingSoonNumbers?: ComingSoonNumber[];
  /** Licença bloqueada: o fluxo inteiro fica desabilitado (a API recusaria com 423). */
  licenseLocked?: boolean;
  createAction: CreateAction;
  /** Confere no servidor se uma criação incerta foi aplicada (create-receipt). */
  confirmAction: ConfirmAction;
  onBusyChange?: (busy: boolean) => void;
  onFinished: () => void;
};

const unknownCreateMessage =
  "Não deu para confirmar se a regra foi criada. Use “Conferir e concluir”: repetir este mesmo pedido nunca cria uma regra duplicada.";

function isProviderOrigin(
  origin: RuleOriginId,
): origin is ProviderConversionRuleOriginDto {
  return ruleOriginDefinition(origin).kind === "provider";
}

export function NewRuleFlow({
  offeredOrigins,
  initialOrigin = null,
  numbers,
  connections,
  capabilities,
  comingSoonNumbers = [],
  licenseLocked = false,
  createAction,
  confirmAction,
  onBusyChange,
  onFinished,
}: NewRuleFlowProps) {
  const startOrigin =
    initialOrigin && offeredOrigins.includes(initialOrigin) ? initialOrigin : null;
  const [origin, setOrigin] = useState<RuleOriginId | null>(startOrigin);
  const [step, setStep] = useState<Step>(startOrigin ? "event" : "origin");
  const [draft, setDraft] = useState<RuleDraft | null>(() =>
    startOrigin && isProviderOrigin(startOrigin)
      ? withDefaultConnection(
          emptyRuleDraft(startOrigin),
          connections,
          capabilities,
        )
      : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // An uncertain (or unavailable) create keeps its exact request: resending
  // it never duplicates.
  // "unknown": pode ter sido aplicado (confira antes de repetir);
  // "retry": definitivamente não aplicado (503 ou conferido como ausente).
  const [inFlight, setInFlight] = useState<{
    key: string;
    payload: string;
    state: "unknown" | "retry";
  } | null>(null);
  const [result, setResult] = useState<ConversionScreenActionResult | null>(null);
  const [urlVisible, setUrlVisible] = useState(true);

  const context = useMemo(
    () => ({ numbers, connections, capabilities }),
    [numbers, connections, capabilities],
  );
  const definition = origin ? ruleOriginDefinition(origin) : null;
  const locked = inFlight !== null;
  // Sending or uncertain: the request (key + exact payload) lives only here,
  // so the screen must not close the flow nor the page drop it silently.
  const busy = pending || locked;

  useEffect(() => {
    onBusyChange?.(busy);
    if (!busy) return;
    const keepPage = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", keepPage);
    return () => window.removeEventListener("beforeunload", keepPage);
  }, [busy, onBusyChange]);

  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  function patch(update: Partial<RuleDraft>) {
    setError(null);
    setDraft((current) => (current ? { ...current, ...update } : current));
  }

  function chooseOrigin(next: RuleOriginId) {
    setError(null);
    setOrigin(next);
    setDraft(
      isProviderOrigin(next)
        ? withDefaultConnection(emptyRuleDraft(next), connections, capabilities)
        : null,
    );
  }

  function goNext() {
    setError(null);
    if (step === "origin") {
      if (!origin) {
        setError("Escolha de onde vem a conversão.");
        return;
      }
      setStep("event");
      return;
    }
    if (step === "event") {
      setStep("scope");
      return;
    }
    if (step === "scope" && draft) {
      const issue = scopeIssue(draft, context);
      if (issue) {
        setError(issue);
        return;
      }
      if (!draft.name.trim()) {
        patch({
          name: `${ruleOriginDefinition(draft.origin).label} - ${ruleEventLabelForOrigin(draft.origin, draft.eventName)}`.slice(
            0,
            120,
          ),
        });
      }
      setStep("details");
    }
  }

  function goBack() {
    setError(null);
    const index = stepOrder.findIndex((item) => item.id === step);
    if (index > 0) setStep(stepOrder[index - 1]!.id);
  }

  async function confirm(request: NonNullable<typeof inFlight>) {
    setPending(true);
    setError(null);
    const formData = new FormData();
    formData.set("requestKey", request.key);
    let connectionId: unknown;
    try {
      connectionId = (JSON.parse(request.payload) as { connectionId?: unknown })
        .connectionId;
    } catch {
      connectionId = undefined;
    }
    if (typeof connectionId === "string") {
      formData.set("connectionId", connectionId);
    }

    let response: ConversionScreenActionResult;
    try {
      response = await confirmAction(formData);
    } catch {
      response = { ok: false, outcomeUnknown: true, message: unknownCreateMessage };
    }
    setPending(false);

    if (response.ok) {
      setInFlight(null);
      setResult(response);
      setStep("done");
      return;
    }
    if (response.receiptAbsent) {
      setInFlight({ ...request, state: "retry" });
    } else if (!response.outcomeUnknown && !response.unavailable) {
      setInFlight(null);
    }
    setError(response.message);
  }

  async function submit(retry = false) {
    if (!draft || pending || licenseLocked) return;
    let request = inFlight;

    // Pedido incerto: primeiro pergunta ao servidor se ele foi aplicado.
    if (retry && request?.state === "unknown") {
      await confirm(request);
      return;
    }

    if (!retry || !request) {
      const built = buildRulePayload(draft, context);
      if (!built.ok) {
        setError(built.message);
        return;
      }
      const key = mintRequestKey();
      if (!key) {
        setError(
          "Seu navegador não permitiu gerar um identificador seguro para o pedido. Atualize a página e tente de novo.",
        );
        return;
      }
      request = { key, payload: JSON.stringify(built.value), state: "unknown" };
    }

    setPending(true);
    setError(null);
    const formData = new FormData();
    formData.set("requestKey", request.key);
    formData.set("payload", request.payload);

    let response: ConversionScreenActionResult;
    try {
      response = await createAction(formData);
    } catch {
      response = { ok: false, outcomeUnknown: true, message: unknownCreateMessage };
    }
    setPending(false);

    if (response.ok) {
      setInFlight(null);
      setResult(response);
      setStep("done");
      return;
    }
    if (response.outcomeUnknown) {
      setInFlight({ ...request, state: "unknown" });
      setError(response.message);
      return;
    }
    if (response.unavailable) {
      // 503: recusado antes de processar; reenviar a mesma chave é seguro.
      setInFlight({ ...request, state: "retry" });
      setError(response.message);
      return;
    }
    // Recusa definitiva (inclui 423 da licença): nada foi criado e nada a conferir.
    setInFlight(null);
    setError(response.message);
  }

  if (step === "done" && result) {
    return (
      <div className="conversion-flow-result provider-conversion-builder" role="status">
        <div className="feedback-banner success">
          <strong>{result.replayed ? "Regra já existia" : "Regra criada"}</strong>
          <span>{result.message}</span>
        </div>
        {result.webhookUrl && urlVisible ? (
          <div className="conversion-webhook-url">
            <label className="conversion-field">
              <span className="field-label">
                {draft?.origin === "automation_payt"
                  ? "URL de postback da Payt (exibida uma única vez)"
                  : draft?.origin === "automation_unnichat"
                    ? "URL da regra no Unnichat (exibida uma única vez)"
                    : "Endereço da automação (exibido uma única vez)"}
              </span>
              <input
                readOnly
                value={result.webhookUrl}
                data-presentation-sensitive-field="true"
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <CopyUrlButton url={result.webhookUrl} />
            {draft?.origin === "automation_payt" ? (
              <PaytSetupPanel
                eventName={draft.eventName}
                beta={originBetaEvents(draft.origin, capabilities).includes(
                  draft.eventName,
                )}
              />
            ) : draft?.origin === "automation_unnichat" ? (
              <UnnichatAutomationSetupPanel
                eventLabel={ruleEventLabelForOrigin(
                  draft.origin,
                  draft.eventName,
                )}
              />
            ) : draft ? (
              <UmblerAutomationPayloadPanel eventName={draft.eventName} />
            ) : null}
            <button
              className="button ghost compact-button"
              type="button"
              onClick={() => setUrlVisible(false)}
            >
              Já copiei
            </button>
          </div>
        ) : null}
        <div className="conversion-flow-actions">
          <button className="button primary" type="button" onClick={onFinished}>
            Concluir
          </button>
        </div>
      </div>
    );
  }

  const currentIndex = stepOrder.findIndex((item) => item.id === step);
  const crmOrigin = origin && definition?.kind === "crm" ? (origin as CrmRuleOrigin) : null;

  return (
    <div className="conversion-flow provider-conversion-builder">
      <ol className="conversion-flow-steps" aria-label="Etapas da nova regra">
        {stepOrder.map((item, index) => (
          <li
            key={item.id}
            className={
              index < currentIndex ? "is-done" : index === currentIndex ? "is-current" : ""
            }
            aria-current={index === currentIndex ? "step" : undefined}
          >
            <span className="conversion-flow-step-index" aria-hidden="true">
              {index < currentIndex ? <Check size={13} /> : index + 1}
            </span>
            {item.label}
          </li>
        ))}
      </ol>

      {licenseLocked ? (
        <p className="action-note warn" role="status">
          {conversionsLicenseLockedNote}
        </p>
      ) : null}

      {step === "origin" ? (
        <OriginStep
          offeredOrigins={offeredOrigins}
          origin={origin}
          onChange={chooseOrigin}
        />
      ) : null}

      {crmOrigin && step !== "origin" ? (
        <CrmPointer origin={crmOrigin} />
      ) : null}

      {draft && step === "event" ? (
        <EventStep
          draft={draft}
          capabilities={capabilities}
          onChange={(eventName) => patch({ eventName })}
        />
      ) : null}

      {draft && step === "scope" ? (
        <ScopeStep
          draft={draft}
          numbers={numbers}
          connections={connections}
          capabilities={capabilities}
          comingSoonNumbers={comingSoonNumbers}
          onChange={patch}
          disabled={locked || licenseLocked}
        />
      ) : null}

      {draft && step === "details" ? (
        <DetailsStep
          draft={draft}
          numbers={numbers}
          connections={connections}
          capabilities={capabilities}
          onChange={patch}
          disabled={locked || licenseLocked}
        />
      ) : null}

      {error ? (
        <p
          className={`action-note${inFlight ? "" : " warn"} conversion-flow-error`}
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div className="conversion-flow-actions">
        {step !== "origin" && !locked ? (
          <button
            className="button"
            type="button"
            onClick={goBack}
            disabled={pending}
          >
            <ArrowLeft size={15} aria-hidden="true" />
            Voltar
          </button>
        ) : null}
        {crmOrigin && step !== "origin" ? null : step === "details" ? (
          <button
            className="button primary"
            type="button"
            onClick={() => void submit(locked)}
            disabled={pending || licenseLocked}
            data-pending={pending ? "true" : undefined}
          >
            {pending
              ? locked && inFlight?.state === "unknown"
                ? "Conferindo..."
                : "Criando..."
              : locked
                ? inFlight?.state === "retry"
                  ? "Tentar de novo"
                  : "Conferir e concluir"
                : "Criar regra"}
          </button>
        ) : (
          <button
            className="button primary"
            type="button"
            onClick={goNext}
            disabled={step === "origin" && !origin}
          >
            Continuar
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

function withDefaultConnection(
  draft: RuleDraft,
  connections: readonly ConversionConnection[],
  capabilities: ProviderConversionRuleCapabilitiesDto | null,
): RuleDraft {
  const options = connectionsForOrigin(draft.origin, connections, capabilities);
  return options.length === 1 ? { ...draft, connectionId: options[0]!.id } : draft;
}

function OriginStep({
  offeredOrigins,
  origin,
  onChange,
}: {
  offeredOrigins: RuleOriginId[];
  origin: RuleOriginId | null;
  onChange: (origin: RuleOriginId) => void;
}) {
  return (
    <fieldset className="conversion-flow-fieldset">
      <legend>De onde vem a conversão?</legend>
      <p className="muted">
        Aparecem só as integrações que você já conectou.
      </p>
      {offeredOrigins.length === 0 ? (
        <p className="action-note warn">
          Nenhuma integração ativa ainda. Conecte um número de WhatsApp, uma
          plataforma de venda ou um CRM em Integrações.
        </p>
      ) : (
        <div className="conversion-origin-grid">
          {offeredOrigins.map((id) => {
            const item = ruleOriginDefinition(id);
            return (
              <label
                key={id}
                className={`conversion-origin-option${origin === id ? " is-selected" : ""}`}
              >
                <input
                  type="radio"
                  name="conversion-origin"
                  value={id}
                  checked={origin === id}
                  onChange={() => onChange(id)}
                />
                <RuleLogo
                  logo={item.logoProvider ? providerLogo(item.logoProvider) : null}
                  origin={id}
                  size="small"
                />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
              </label>
            );
          })}
        </div>
      )}
      <Link className="conversion-inline-link" href="/integrations">
        <ArrowUpRight size={14} aria-hidden="true" />
        Conectar outra integração
      </Link>
    </fieldset>
  );
}

function CrmPointer({ origin }: { origin: CrmRuleOrigin }) {
  const item = ruleOriginDefinition(origin);
  const name = item.logoProvider ? providerLogo(item.logoProvider).name : item.label;

  return (
    <div className="integration-modal-note conversion-crm-pointer">
      <strong>As regras do {name} são criadas na conexão do {name}</strong>
      <p className="muted">
        Lá você escolhe o funil, a etapa e o evento enviado à Meta. As regras
        criadas aparecem nesta lista automaticamente.
      </p>
      <Link className="button primary" href={crmManageHref(origin)}>
        Abrir {name} em Integrações
        <ArrowUpRight size={15} aria-hidden="true" />
      </Link>
    </div>
  );
}

function PaytEventStep({
  draft,
  capabilities,
  onChange,
}: {
  draft: RuleDraft;
  capabilities: ProviderConversionRuleCapabilitiesDto | null;
  onChange: (eventName: ConversionEventNameDto) => void;
}) {
  const definition = ruleOriginDefinition(draft.origin);
  const eventNames =
    originEventNames(draft.origin, capabilities) ?? definition.allowedEvents ?? [];
  const beta = originBetaEvents(draft.origin, capabilities);

  return (
    <fieldset className="conversion-flow-fieldset">
      <legend>Qual venda da Payt vai para a Meta?</legend>
      <p className="muted">
        O evento vem do status de cada venda e o valor vem da própria venda da
        Payt. Crie uma regra para cada evento que quiser enviar.
      </p>
      <div className="conversion-origin-grid">
        {eventNames.map((eventName) => (
          <label
            key={eventName}
            className={`conversion-origin-option${draft.eventName === eventName ? " is-selected" : ""}`}
          >
            <input
              type="radio"
              name="payt-event"
              value={eventName}
              checked={draft.eventName === eventName}
              onChange={() => onChange(eventName)}
            />
            <span>
              <strong>
                {paytEventLabel(eventName)}
                {beta.includes(eventName) ? (
                  <>
                    {" "}
                    <span className="status-chip neutral conversion-beta-chip">
                      {paytBetaBadge}
                    </span>
                  </>
                ) : null}
              </strong>
              <small>{paytEventExplanations[eventName] ?? ""}</small>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function EventStep({
  draft,
  capabilities,
  onChange,
}: {
  draft: RuleDraft;
  capabilities: ProviderConversionRuleCapabilitiesDto | null;
  onChange: (eventName: ConversionEventNameDto) => void;
}) {
  const definition = ruleOriginDefinition(draft.origin);
  if (draft.origin === "automation_payt") {
    return (
      <PaytEventStep
        draft={draft}
        capabilities={capabilities}
        onChange={onChange}
      />
    );
  }
  const events = conversionEventCatalogOrdered.filter((event) =>
    definition.lockedEvent
      ? event.eventName === definition.lockedEvent
      : definition.allowedEvents
        ? definition.allowedEvents.includes(event.eventName)
        : true,
  );
  const categories = [...new Set(events.map((event) => event.category))];
  const metadata = conversionEventMetadata(draft.eventName);

  return (
    <fieldset className="conversion-flow-fieldset">
      <legend>Qual evento vai para a Meta?</legend>
      {definition.lockedEvent ? (
        <p className="muted">
          Pedidos do catálogo sempre viram Compra realizada, com o valor
          calculado pelo catálogo.
        </p>
      ) : null}
      <label className="conversion-field">
        <span className="field-label">Evento</span>
        <select
          value={draft.eventName}
          disabled={Boolean(definition.lockedEvent)}
          onChange={(event) =>
            onChange(event.target.value as ConversionEventNameDto)
          }
        >
          {categories.map((category) => (
            <optgroup key={category} label={eventCategoryLabels[category]}>
              {events
                .filter((event) => event.category === category)
                .map((event) => (
                  <option key={event.eventName} value={event.eventName}>
                    {accentEventCopy(event.label)}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <div className="provider-conversion-event-hint">
        <span className="micro-label">{accentEventCopy(metadata.label)}</span>
        <small>{accentEventCopy(metadata.description)}</small>
      </div>
      {draft.origin === "automation_umbler" ? (
        <p className="action-note">
          A automação da Umbler reconhece Lead qualificado e Compra realizada.
        </p>
      ) : null}
      {draft.origin === "automation_unnichat" ? (
        <p className="action-note">
          Aqui vale qualquer evento do catálogo. O Unnichat só avisa que o
          fluxo chegou naquela etapa; o evento enviado à Meta é o escolhido
          nesta regra. Crie uma regra por evento.
        </p>
      ) : null}
    </fieldset>
  );
}

function numberLogo(number: ConversionNumber) {
  const hubId = hubProviderForInbound(number.provider);
  return hubId ? providerLogo(hubId) : null;
}

export function ScopeStep({
  draft,
  numbers,
  connections,
  capabilities,
  comingSoonNumbers = [],
  onChange,
  disabled,
  connectionLocked = false,
  legend = "Em quais números esta regra vale?",
}: {
  draft: RuleDraft;
  numbers: ConversionNumber[];
  connections: ConversionConnection[];
  capabilities: ProviderConversionRuleCapabilitiesDto | null;
  comingSoonNumbers?: ComingSoonNumber[];
  onChange: (update: Partial<RuleDraft>) => void;
  disabled: boolean;
  /** Edição: a conexão de uma automação por endereço não muda. */
  connectionLocked?: boolean;
  legend?: string;
}) {
  const definition = ruleOriginDefinition(draft.origin);
  const connectionOptions = connectionsForOrigin(
    draft.origin,
    connections,
    capabilities,
  );
  const connectionBound = definition.connection === "same_provider";
  const connection = connections.find((item) => item.id === draft.connectionId);
  const available = numbersForOrigin(
    draft.origin,
    numbers,
    connectionBound ? (draft.connectionId ?? "__none__") : null,
    capabilities,
    draft.messageAuthorScope,
  );
  const availableIds = new Set(available.map((number) => number.id));
  const notYet = ineligibleNumbers(numbers, capabilities, draft.origin);
  // Números de provedores que leem a origem, mas não este autor (contato).
  const wrongAuthor = numbersForOrigin(
    draft.origin,
    numbers,
    connectionBound ? (draft.connectionId ?? "__none__") : null,
    capabilities,
    "both",
  ).filter((number) => !availableIds.has(number.id));
  const grouped = new Map<string, ConversionNumber[]>();
  for (const number of available) {
    grouped.set(number.connectionId, [...(grouped.get(number.connectionId) ?? []), number]);
  }
  function toggle(id: string) {
    onChange({
      channelIds: draft.channelIds.includes(id)
        ? draft.channelIds.filter((item) => item !== id)
        : [...draft.channelIds, id],
    });
  }

  return (
    <fieldset className="conversion-flow-fieldset" disabled={disabled}>
      <legend>{legend}</legend>

      {connectionBound && connectionLocked ? (
        <p className="action-note">
          Conexão que chama o endereço:{" "}
          <strong>{connection?.displayName ?? "conexão removida"}</strong>
        </p>
      ) : connectionBound ? (
        <label className="conversion-field">
          <span className="field-label">Conexão que chama o endereço</span>
          <select
            value={draft.connectionId ?? ""}
            onChange={(event) =>
              onChange({
                connectionId: event.target.value || null,
                channelIds: [],
              })
            }
          >
            <option value="">Escolha a conexão</option>
            {connectionOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.displayName}
              </option>
            ))}
          </select>
          <small className="action-note">
            Automações por endereço ficam ligadas à conexão que as chama.
          </small>
        </label>
      ) : null}

      <div className="conversion-scope-options" role="radiogroup" aria-label="Alcance">
        <label
          className={`conversion-scope-option${draft.scope === "all_numbers" ? " is-selected" : ""}`}
        >
          <input
            type="radio"
            name="conversion-scope"
            value="all_numbers"
            checked={draft.scope === "all_numbers"}
            onChange={() => onChange({ scope: "all_numbers", channelIds: [] })}
          />
          <span>
            <strong>
              {connectionBound && connection
                ? `Todos os números de ${connection.displayName}`
                : "Todos os números"}
            </strong>
            <small>
              Vale para todos os números que funcionam com esta origem,
              inclusive os que você conectar depois.
            </small>
          </span>
        </label>
        <label
          className={`conversion-scope-option${draft.scope === "specific_numbers" ? " is-selected" : ""}`}
        >
          <input
            type="radio"
            name="conversion-scope"
            value="specific_numbers"
            checked={draft.scope === "specific_numbers"}
            onChange={() => onChange({ scope: "specific_numbers" })}
          />
          <span>
            <strong>Números específicos</strong>
            <small>
              {connectionBound
                ? "Escolha um ou mais números desta conexão."
                : draft.origin === "automation_payt"
                  ? "Escolha um ou mais números de uma mesma conexão."
                  : "Escolha um ou mais números, de qualquer conexão."}
            </small>
          </span>
        </label>
      </div>

      {draft.origin === "automation_payt" ? (
        <p className="action-note conversion-scope-note">
          {paytSingleConnectionNote}
        </p>
      ) : null}

      {draft.origin === "whatsapp_label" && draft.scope === "all_numbers" ? (
        <p className="action-note conversion-scope-note">
          Em “Todos os números”, a etiqueta é reconhecida pelo nome em todas as
          instâncias Uazapi: escreva o nome igual ao da etiqueta no WhatsApp.
        </p>
      ) : null}

      {draft.scope === "specific_numbers" ? (
        available.length === 0 ? (
          <p className="action-note warn">
            {connectionBound && !draft.connectionId
              ? "Escolha a conexão para ver os números."
              : "Nenhum número conectado funciona com esta origem."}
          </p>
        ) : (
          <div className="conversion-number-picker">
            {[...grouped.entries()].map(([connectionId, items]) => (
              <fieldset key={connectionId} className="conversion-number-group">
                <legend>{items[0]!.connectionName}</legend>
                {items.map((number) => (
                  <label key={number.id} className="conversion-number-option">
                    <input
                      type="checkbox"
                      checked={draft.channelIds.includes(number.id)}
                      onChange={() => toggle(number.id)}
                    />
                    <RuleLogo
                      logo={numberLogo(number)}
                      origin="message_phrase"
                      size="small"
                    />
                    <span>
                      <PresentationMask placeholder="Número oculto">
                        {number.label}
                      </PresentationMask>
                      {number.label !== number.phone ? (
                        <small>
                          <PresentationMask placeholder="Telefone oculto">
                            {number.phone}
                          </PresentationMask>
                        </small>
                      ) : null}
                    </span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
        )
      ) : null}

      {wrongAuthor.length > 0 ? (
        <p className="action-note">
          Mensagens do contato só são lidas na Umbler; os números das outras
          plataformas ficam de fora enquanto “Quem pode enviar” for “Somente
          contato”.
        </p>
      ) : null}

      <NumbersWithoutRules comingSoon={comingSoonNumbers} webhookOnly={notYet} />

      <p className="action-note">
        Se um número tiver uma regra só dele com a mesma origem e o mesmo
        evento, ela vale no lugar desta naquele número.
      </p>
    </fieldset>
  );
}

export function ValueFields({
  draft,
  onChange,
}: {
  draft: RuleDraft;
  onChange: (update: Partial<RuleDraft>) => void;
}) {
  if (!conversionEventCarriesValue(draft.eventName)) return null;
  const required = conversionEventRequiresValue(draft.eventName);

  return (
    <div className="conversion-field-row">
      <label className="conversion-field">
        <span className="field-label">
          {required ? "Valor médio (R$)" : "Valor médio (opcional)"}
        </span>
        <input
          value={draft.averageValue}
          onChange={(event) => onChange({ averageValue: event.target.value })}
          inputMode="decimal"
          placeholder="Ex.: 250,00"
          required={required}
        />
      </label>
      <label className="conversion-field">
        <span className="field-label">Produto (opcional)</span>
        <input
          value={draft.contentName}
          onChange={(event) => onChange({ contentName: event.target.value })}
          maxLength={180}
          placeholder="Ex.: Consulta"
        />
      </label>
    </div>
  );
}

function CatalogFields({
  draft,
  onChange,
}: {
  draft: RuleDraft;
  onChange: (update: Partial<RuleDraft>) => void;
}) {
  const catalog = draft.catalog;
  const setCatalog = (update: Partial<RuleDraft["catalog"]>) =>
    onChange({ catalog: { ...catalog, ...update } });

  return (
    <div className="conversion-catalog">
      <label className="conversion-field">
        <span className="field-label">Frase que abre o pedido</span>
        <input
          value={draft.primaryPhrase}
          onChange={(event) => onChange({ primaryPhrase: event.target.value })}
          placeholder="Ex.: Resumo do pedido"
          maxLength={240}
        />
      </label>
      <div className="conversion-field-row">
        <label className="conversion-field">
          <span className="field-label">Nome do catálogo</span>
          <input
            value={catalog.name}
            onChange={(event) => setCatalog({ name: event.target.value })}
            placeholder="Ex.: Camas elásticas"
            maxLength={120}
          />
        </label>
        <label className="conversion-field">
          <span className="field-label">Produto</span>
          <input
            value={catalog.productName}
            onChange={(event) => setCatalog({ productName: event.target.value })}
            placeholder="Ex.: Cama elástica"
            maxLength={180}
          />
        </label>
      </div>
      <fieldset className="conversion-catalog-attributes">
        <legend className="field-label">Características (até 2)</legend>
        {catalog.attributes.map((attribute, index) => (
          <div className="conversion-catalog-attribute" key={index}>
            <input
              aria-label={`Característica ${index + 1}`}
              value={attribute}
              onChange={(event) =>
                setCatalog({
                  attributes: catalog.attributes.map((item, position) =>
                    position === index ? event.target.value : item,
                  ),
                })
              }
              placeholder="Ex.: Tamanho"
              maxLength={180}
            />
            {catalog.attributes.length > 1 ? (
              <button
                className="icon-button"
                type="button"
                aria-label={`Remover característica ${index + 1}`}
                onClick={() =>
                  setCatalog({
                    attributes: catalog.attributes.filter((_, position) => position !== index),
                    variants: catalog.variants.map((variant) => ({
                      ...variant,
                      values: variant.values.filter((_, position) => position !== index),
                    })),
                  })
                }
              >
                <X size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ))}
        {catalog.attributes.length < 2 ? (
          <button
            className="button ghost"
            type="button"
            onClick={() =>
              setCatalog({
                attributes: [...catalog.attributes, ""],
                variants: catalog.variants.map((variant) => ({
                  ...variant,
                  values: [...variant.values, ""],
                })),
              })
            }
          >
            <Plus size={14} aria-hidden="true" />
            Adicionar característica
          </button>
        ) : null}
      </fieldset>
      <fieldset className="conversion-catalog-variants">
        <legend className="field-label">Opções e preços</legend>
        {catalog.variants.map((variant, row) => (
          <div className="conversion-catalog-variant" key={row}>
            {catalog.attributes.map((attribute, index) => (
              <input
                key={index}
                aria-label={`${attribute || `Característica ${index + 1}`} da opção ${row + 1}`}
                value={variant.values[index] ?? ""}
                placeholder={attribute || `Característica ${index + 1}`}
                onChange={(event) =>
                  setCatalog({
                    variants: catalog.variants.map((item, position) =>
                      position === row
                        ? {
                            ...item,
                            values: catalog.attributes.map((_, valueIndex) =>
                              valueIndex === index
                                ? event.target.value
                                : (item.values[valueIndex] ?? ""),
                            ),
                          }
                        : item,
                    ),
                  })
                }
                maxLength={180}
              />
            ))}
            <input
              aria-label={`Preço da opção ${row + 1}`}
              value={variant.price}
              inputMode="decimal"
              placeholder="Preço (R$)"
              onChange={(event) =>
                setCatalog({
                  variants: catalog.variants.map((item, position) =>
                    position === row ? { ...item, price: event.target.value } : item,
                  ),
                })
              }
            />
            {catalog.variants.length > 1 ? (
              <button
                className="icon-button"
                type="button"
                aria-label={`Remover opção ${row + 1}`}
                onClick={() =>
                  setCatalog({
                    variants: catalog.variants.filter((_, position) => position !== row),
                  })
                }
              >
                <X size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ))}
        <button
          className="button ghost"
          type="button"
          onClick={() =>
            setCatalog({
              variants: [
                ...catalog.variants,
                { values: catalog.attributes.map(() => ""), price: "" },
              ],
            })
          }
        >
          <Plus size={14} aria-hidden="true" />
          Adicionar opção
        </button>
      </fieldset>
    </div>
  );
}

function DetailsStep({
  draft,
  numbers,
  connections,
  capabilities,
  onChange,
  disabled,
}: {
  draft: RuleDraft;
  numbers: ConversionNumber[];
  connections: ConversionConnection[];
  capabilities: ProviderConversionRuleCapabilitiesDto | null;
  onChange: (update: Partial<RuleDraft>) => void;
  disabled: boolean;
}) {
  const definition = ruleOriginDefinition(draft.origin);
  const contactProviders = contactMessageProviders(capabilities);
  const contactAvailable = numbers.some((number) =>
    contactProviders.includes(number.provider),
  );
  const selected = numbers.filter((number) => draft.channelIds.includes(number.id));
  const instanceIds = [
    ...new Set(
      selected
        .map((number) => number.whatsappInstanceId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const boundConnectionId = resolveRuleConnectionId(draft, { numbers, connections });
  const pickerInstanceId =
    draft.origin === "whatsapp_label" &&
    draft.scope === "specific_numbers" &&
    boundConnectionId &&
    instanceIds.length === 1
      ? instanceIds[0]!
      : null;
  const scopeSummary =
    draft.scope === "all_numbers"
      ? "Todos os números"
      : `${selected.length} ${selected.length === 1 ? "número escolhido" : "números escolhidos"}`;

  return (
    <fieldset className="conversion-flow-fieldset" disabled={disabled}>
      <legend>Detalhes da regra</legend>

      <label className="conversion-field">
        <span className="field-label">Nome da regra</span>
        <input
          value={draft.name}
          onChange={(event) => onChange({ name: event.target.value })}
          maxLength={120}
          required
        />
      </label>

      {draft.origin === "message_phrase" ? (
        <MessagePhraseFields
          eventName={draft.eventName}
          averageValue={draft.averageValue}
          contentName={draft.contentName}
          primaryPhrase={draft.primaryPhrase}
          variationPhrases={draft.variationPhrases}
          exampleMessage={draft.exampleMessage}
          valueMode={draft.valueMode}
          messageAuthorScope={draft.messageAuthorScope}
          contactAvailable={contactAvailable}
          onChange={(update) => onChange(update)}
        />
      ) : null}

      {draft.origin === "structured_catalog" ? (
        <CatalogFields draft={draft} onChange={onChange} />
      ) : null}

      {draft.origin === "whatsapp_label" ? (
        <>
          {pickerInstanceId ? (
            <UazapiLabelPicker
              whatsappInstanceId={pickerInstanceId}
              selectedLabels={draft.triggerLabels}
              onLabelsChange={(labels) => onChange({ triggerLabels: labels })}
              fallbackValue={draft.labelNames}
              onFallbackChange={(value) => onChange({ labelNames: value })}
            />
          ) : (
            <label className="conversion-field">
              <span className="field-label">Etiquetas (uma por linha)</span>
              <textarea
                value={draft.labelNames}
                onChange={(event) => onChange({ labelNames: event.target.value })}
                rows={3}
                placeholder={"Ex.: Venda fechada\nPagou"}
              />
              <small className="action-note">
                Escreva o nome igual ao da etiqueta no WhatsApp. Vale em todos
                os números escolhidos que tiverem uma etiqueta com esse nome.
              </small>
            </label>
          )}
          <ValueFields draft={draft} onChange={onChange} />
        </>
      ) : null}

      {draft.origin === "automation_umbler" ? (
        <>
          <ValueFields draft={draft} onChange={onChange} />
          <p className="action-note">
            Depois de criar, você recebe o endereço para colar na automação do
            Umbler Talk.
          </p>
        </>
      ) : null}

      {draft.origin === "automation_unnichat" ? (
        <>
          <ValueFields draft={draft} onChange={onChange} />
          <p className="action-note">
            Depois de criar, você recebe a URL desta regra para colar no fluxo
            do Unnichat, na etapa que marca a conversão. A URL só aparece
            uma vez.
          </p>
        </>
      ) : null}

      {draft.origin === "automation_payt" ? (
        <p className="action-note">
          Depois de criar, você recebe a URL de postback para colar na Payt, em
          Postback. O valor de cada venda vem da própria Payt.
        </p>
      ) : null}

      <dl className="conversion-flow-summary">
        <div>
          <dt>Origem</dt>
          <dd>{definition.label}</dd>
        </div>
        <div>
          <dt>Evento</dt>
          <dd>
            {ruleEventLabelForOrigin(
              draft.origin,
              definition.lockedEvent ?? draft.eventName,
            )}
          </dd>
        </div>
        <div>
          <dt>Alcance</dt>
          <dd>{scopeSummary}</dd>
        </div>
        <div>
          <dt>Começa em</dt>
          <dd>Observação: nada é enviado à Meta até você ativar o envio.</dd>
        </div>
      </dl>
    </fieldset>
  );
}

function CopyUrlButton({ url }: { url: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  return (
    <button
      className="button"
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(url).then(
          () => setState("copied"),
          () => setState("failed"),
        );
      }}
    >
      {state === "copied"
        ? "Endereço copiado"
        : state === "failed"
          ? "Copie manualmente"
          : "Copiar endereço"}
    </button>
  );
}
