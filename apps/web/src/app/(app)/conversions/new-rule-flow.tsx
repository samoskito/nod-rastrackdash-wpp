"use client";

import type {
  ConversionEventCategoryDto,
  ConversionEventNameDto,
  IntegrationDetectedProductDto,
  IntegrationEndpointDto,
  IntegrationEndpointProviderDto,
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
  RuleCurrencySelect,
  useWorkspaceCurrency,
} from "../../../components/workspace-currency";
import {
  accentEventCopy,
  paytBetaBadge,
  braipEventExplanations,
  paytEventExplanations,
  yampiEventExplanations,
  paytEventLabel,
  ruleEventLabelForOrigin,
} from "./event-copy";
import { LeadSubmittedOverrideNotice } from "./lead-submitted-override";
import { conversionsLicenseLockedNote } from "./license-lock";
import { NumbersWithoutRules } from "./numbers-without-rules";
import { MessagePhraseFields } from "./message-phrase-fields";
import { PendingNumbersWarning } from "./pending-numbers";
import { PaytSetupPanel } from "./payt-setup";
import { UmblerAutomationPayloadPanel } from "./umbler-automation-payload";
import { UnnichatAutomationSetupPanel } from "../integrations/unnichat-setup";
import { UazapiLabelPicker } from "../integrations/uazapi-label-picker";
import {
  findEventEndpoint,
  isSalesPlatform,
} from "../integrations/single-url/single-url-copy";
import {
  EnsureUrlButton,
  IntegrationUrlBox,
  ProductFilterPicker,
  type SingleUrlActions,
} from "../integrations/single-url/single-url-panels";
import type { ConversionScreenActionResult } from "./actions";
import {
  automationPlatformOf,
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
  automationSingleConnectionNote,
  buildRulePayload,
  emptyRuleDraft,
  mintRequestKey,
  paytSingleConnectionNote,
  salesSingleConnectionNote,
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
  /** Números de Z-API e NOD API: aparecem como “Em breve”. */
  comingSoonNumbers?: ComingSoonNumber[];
  /** Licença bloqueada: o fluxo inteiro fica desabilitado (a API recusaria com 423). */
  licenseLocked?: boolean;
  createAction: CreateAction;
  /** Confere no servidor se uma criação incerta foi aplicada (create-receipt). */
  confirmAction: ConfirmAction;
  onBusyChange?: (busy: boolean) => void;
  onFinished: () => void;
  /** Fase 5.3: produtos vistos nas vendas da Payt (filtro opcional). */
  paytProducts?: IntegrationDetectedProductDto[];
  /** Fase 6.5: produtos vistos nas vendas da Braip (filtro opcional). */
  braipProducts?: IntegrationDetectedProductDto[];
  /** Fase 6.7: produtos vistos nas vendas da Yampi (filtro opcional). */
  yampiProducts?: IntegrationDetectedProductDto[];
  /** Fase 5.3: URLs únicas/por evento já geradas (sem a chave). */
  integrationEndpoints?: IntegrationEndpointDto[];
  /** Presente quando a URL única está ativa no workspace. */
  singleUrlActions?: SingleUrlActions;
  /** GET /channels de alguma conexão falhou: a lista de números está incompleta. */
  numbersUnavailable?: boolean;
};

/** Porte do #165: números que não puderam ser lidos não viram "sem número". */
export const numbersUnavailableNote =
  "Não deu para carregar os números de alguma conexão agora. Recarregue a página em instantes antes de escolher números.";

/** Plataforma da URL única/por evento de uma origem de automação. */
export function singleUrlProviderFor(
  origin: RuleOriginId | null,
): IntegrationEndpointProviderDto | null {
  switch (origin) {
    case "automation_payt":
      return "payt";
    case "automation_braip":
      return "braip";
    case "automation_yampi":
      return "yampi";
    case "automation_unnichat":
      return "unnichat";
    case "automation_umbler":
      return "umbler";
    default:
      return null;
  }
}

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
  paytProducts = [],
  braipProducts = [],
  yampiProducts = [],
  integrationEndpoints = [],
  singleUrlActions,
  numbersUnavailable = false,
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

  const workspaceCurrency = useWorkspaceCurrency();
  const context = useMemo(
    () => ({
      numbers,
      connections,
      capabilities,
      workspaceCurrency,
      singleUrl: Boolean(singleUrlActions),
    }),
    [numbers, connections, capabilities, workspaceCurrency, singleUrlActions],
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
    const singleUrlProvider = singleUrlProviderFor(origin);
    return (
      <div className="conversion-flow-result provider-conversion-builder" role="status">
        <div className="feedback-banner success">
          <strong>{result.replayed ? "Regra já existia" : "Regra criada"}</strong>
          <span>{result.message}</span>
        </div>
        {result.ruleId && result.pendingNumbers?.length ? (
          <PendingNumbersWarning
            ruleId={result.ruleId}
            pendingNumbers={result.pendingNumbers}
            numbers={numbers}
            mode={result.ruleMode ?? "production"}
            canManage
          />
        ) : null}
        {origin === "automation_roichat" ? (
          <p className="action-note">
            Pronto para receber: as compras chegam pela URL de cada número do
            ROI Chat (a mesma da entrada do lead). Peça ao ROI Chat para enviar
            a compra com event_name &quot;Purchase&quot;, valor_venda e moeda.
          </p>
        ) : null}
        {singleUrlProvider && draft && singleUrlActions && !result.webhookUrl ? (
          <SingleUrlAfterCreate
            provider={singleUrlProvider}
            eventName={draft.eventName}
            endpoints={integrationEndpoints}
            actions={singleUrlActions}
          />
        ) : null}
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
          numbersUnavailable={numbersUnavailable}
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
          paytProducts={
            draft.origin === "automation_braip"
              ? braipProducts
              : draft.origin === "automation_yampi"
                ? yampiProducts
                : paytProducts
          }
          singleUrl={Boolean(singleUrlActions)}
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
  // Fase 6.5/6.7: a Braip e a Yampi usam o mesmo passo, com os seus rótulos.
  const braip = draft.origin === "automation_braip";
  const yampi = draft.origin === "automation_yampi";
  const platform = braip ? "Braip" : yampi ? "Yampi" : "Payt";
  const explanations = braip
    ? braipEventExplanations
    : yampi
      ? yampiEventExplanations
      : paytEventExplanations;

  return (
    <fieldset className="conversion-flow-fieldset">
      <legend>Qual venda da {platform} vai para a Meta?</legend>
      <p className="muted">
        O evento vem do status de cada venda e o valor vem da própria venda da{" "}
        {platform}. Crie uma regra para cada evento que quiser enviar.
        {braip
          ? " Reembolso, chargeback e cancelamento são recebidos e ignorados."
          : yampi
            ? " Cancelamento, reembolso e pagamento recusado são recebidos e ignorados."
            : ""}
      </p>
      <div className="conversion-origin-grid">
        {eventNames.map((eventName) => (
          <label
            key={eventName}
            className={`conversion-origin-option${draft.eventName === eventName ? " is-selected" : ""}`}
          >
            <input
              type="radio"
              name={braip ? "braip-event" : yampi ? "yampi-event" : "payt-event"}
              value={eventName}
              checked={draft.eventName === eventName}
              onChange={() => onChange(eventName)}
            />
            <span>
              <strong>
                {ruleEventLabelForOrigin(draft.origin, eventName)}
                {beta.includes(eventName) ? (
                  <>
                    {" "}
                    <span className="status-chip neutral conversion-beta-chip">
                      {paytBetaBadge}
                    </span>
                  </>
                ) : null}
              </strong>
              <small>{explanations[eventName] ?? ""}</small>
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
  if (
    draft.origin === "automation_payt" ||
    draft.origin === "automation_braip" ||
    draft.origin === "automation_yampi"
  ) {
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
          {draft.origin === "automation_roichat"
            ? "O ROI Chat avisa a compra com event_name Purchase, então o evento é sempre Compra realizada, com o valor e a moeda de cada compra."
            : "Pedidos do catálogo sempre viram Compra realizada, com o valor calculado pelo catálogo."}
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
      {/* Produção direta: toda regra nova já nasce enviando. */}
      <LeadSubmittedOverrideNotice
        enabled={capabilities?.leadSubmittedRuleOverrideEnabled === true}
        eventName={definition.lockedEvent ?? draft.eventName}
        mode="production"
      />
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
  initialCrossConnection = true,
  legend = "Em quais números esta regra vale?",
  numbersUnavailable = false,
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
  /** Editing: whether the saved rule already spans every connection. */
  initialCrossConnection?: boolean;
  legend?: string;
  /**
   * The numbers of some connection could not be read (GET /channels failed):
   * an empty list must not read as "no number" or "number removed".
   */
  numbersUnavailable?: boolean;
}) {
  const definition = ruleOriginDefinition(draft.origin);
  // Umbler/Unnichat (Fase 6.1a, porte do #159): "Todos os números" pode
  // valer para todas as conexões do provedor; números específicos vêm de UMA
  // conexão (a da própria regra ao editar).
  const automation = definition.connection === "provider_anchor";
  const platformOf = automationPlatformOf(draft.origin);
  const connection = connections.find((item) => item.id === draft.connectionId);
  const available = numbersForOrigin(
    draft.origin,
    numbers,
    automation && connectionLocked ? (draft.connectionId ?? "__none__") : null,
    capabilities,
    draft.messageAuthorScope,
  );
  const availableIds = new Set(available.map((number) => number.id));
  const notYet = ineligibleNumbers(numbers, capabilities, draft.origin);
  // Números de provedores que leem a origem, mas não este autor (contato).
  const wrongAuthor = numbersForOrigin(
    draft.origin,
    numbers,
    automation && connectionLocked ? (draft.connectionId ?? "__none__") : null,
    capabilities,
    "both",
  ).filter((number) => !availableIds.has(number.id));
  // Umbler/Unnichat "Todos os números": só a conexão da regra (formato
  // antigo) ou todas as conexões do provedor (explícito).
  const allOfConnection =
    automation && draft.scope === "all_numbers" && !draft.crossConnection;
  const allOfProvider =
    draft.scope === "all_numbers" && (!automation || draft.crossConnection);
  const legacyCross = initialCrossConnection;
  // Números específicos de uma automação ficam numa conexão só: depois do
  // primeiro número, os das outras conexões ficam desabilitados.
  const lockedConnectionId = automation
    ? (numbers.find((number) => draft.channelIds.includes(number.id))
        ?.connectionId ?? null)
    : null;
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

      {automation && draft.origin === "automation_roichat" ? (
        <p className="action-note">
          Cada número do ROI Chat tem a própria URL, que já recebe a entrada e
          a compra: a compra de um número nunca vale para outro.
        </p>
      ) : automation ? (
        <p className="action-note">
          Uma regra serve para todos os números {platformOf}: a mesma URL
          vale em todos os fluxos, de qualquer conexão.
        </p>
      ) : null}

      <div className="conversion-scope-options" role="radiogroup" aria-label="Alcance">
        {automation && connectionLocked ? (
          // Editing an Umbler/Unnichat rule: its own connection only (the
          // historical "Todos os números"), or widened to every connection.
          <label
            className={`conversion-scope-option${allOfConnection ? " is-selected" : ""}`}
          >
            <input
              type="radio"
              name="conversion-scope"
              value="all_numbers_connection"
              checked={allOfConnection}
              onChange={() =>
                onChange({ scope: "all_numbers", crossConnection: false, channelIds: [] })
              }
            />
            <span>
              <strong>
                Todos os números de {connection?.displayName ?? "conexão removida"}
              </strong>
              <small>
                {allOfConnection
                  ? "Vale só para os números desta conexão. Os números das outras conexões ficam de fora."
                  : "Só os números desta conexão."}
              </small>
            </span>
          </label>
        ) : null}
        <label
          className={`conversion-scope-option${allOfProvider ? " is-selected" : ""}`}
        >
          <input
            type="radio"
            name="conversion-scope"
            value="all_numbers"
            checked={allOfProvider}
            onChange={() =>
              onChange({ scope: "all_numbers", crossConnection: true, channelIds: [] })
            }
          />
          <span>
            <strong>
              {automation
                ? `Todos os números ${platformOf} (todas as conexões)`
                : "Todos os números"}
            </strong>
            <small>
              {automation && connectionLocked && !legacyCross
                ? allOfProvider
                  ? `Ampliar para todas as conexões: passa a valer para todos os números ${platformOf}, inclusive os que você conectar depois.`
                  : "Ampliar para todas as conexões."
                : automation
                  ? `Vale para todos os números ${platformOf} conectados aqui, de todas as conexões, inclusive os que você conectar depois.`
                  : "Vale para todos os números que funcionam com esta origem, inclusive os que você conectar depois."}
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
              {draft.scope !== "specific_numbers"
                ? "Escolha um ou mais números."
                : automation && connectionLocked
                  ? `Escolha um ou mais números de ${connection?.displayName ?? "conexão removida"}, a conexão desta regra.`
                  : automation ||
                      draft.origin === "automation_payt" ||
                      draft.origin === "automation_braip" ||
                      draft.origin === "automation_yampi"
                    ? "Escolha um ou mais números de uma mesma conexão."
                    : "Escolha um ou mais números, de qualquer conexão."}
            </small>
          </span>
        </label>
      </div>

      {draft.origin === "automation_payt" ||
      draft.origin === "automation_braip" ||
      draft.origin === "automation_yampi" ? (
        <p className="action-note conversion-scope-note">
          {salesSingleConnectionNote(draft.origin)}
        </p>
      ) : null}

      {draft.origin === "whatsapp_label" && draft.scope === "all_numbers" ? (
        <p className="action-note conversion-scope-note">
          Em “Todos os números”, a etiqueta é reconhecida pelo nome em todas as
          instâncias Uazapi: escreva o nome igual ao da etiqueta no WhatsApp.
        </p>
      ) : automation && draft.scope === "specific_numbers" && !connectionLocked ? (
        <p className="action-note conversion-scope-note">
          {automationSingleConnectionNote(draft.origin)}
        </p>
      ) : null}

      {draft.scope === "specific_numbers" &&
      numbersUnavailable &&
      available.length > 0 ? (
        <p className="action-note warn">{numbersUnavailableNote}</p>
      ) : null}

      {draft.scope === "specific_numbers" ? (
        available.length === 0 ? (
          <p className="action-note warn">
            {numbersUnavailable
              ? numbersUnavailableNote
              : automation && connectionLocked
                ? "O número da conexão desta regra foi removido. Use “Todos os números” ou crie uma regra nova."
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
                      disabled={
                        lockedConnectionId !== null &&
                        number.connectionId !== lockedConnectionId
                      }
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
          {required ? "Valor médio" : "Valor médio (opcional)"}
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
  paytProducts = [],
  singleUrl = false,
}: {
  draft: RuleDraft;
  numbers: ConversionNumber[];
  connections: ConversionConnection[];
  capabilities: ProviderConversionRuleCapabilitiesDto | null;
  onChange: (update: Partial<RuleDraft>) => void;
  disabled: boolean;
  paytProducts?: IntegrationDetectedProductDto[];
  /** Fase 5.3: a regra recebe pela URL única/por evento do workspace. */
  singleUrl?: boolean;
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
          currency={draft.currency}
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
            {singleUrl
              ? "Depois de criar, você recebe a URL deste evento para colar no fluxo do Unnichat, na etapa que marca a conversão. A mesma URL vale para todos os números."
              : "Depois de criar, você recebe a URL desta regra para colar no fluxo do Unnichat, na etapa que marca a conversão. A URL só aparece uma vez."}
          </p>
        </>
      ) : null}

      {draft.origin === "automation_roichat" ? (
        <RoichatPurchaseFields
          draft={draft}
          onChange={onChange}
          disabled={disabled}
        />
      ) : null}

      {draft.origin === "automation_payt" ? (
        <>
          {singleUrl ? (
            <ProductFilterPicker
              products={paytProducts}
              selected={draft.productCodes}
              onChange={(productCodes) => onChange({ productCodes })}
              disabled={disabled}
            />
          ) : null}
          <p className="action-note">
            {singleUrl
              ? "O valor de cada venda vem da própria Payt. As vendas chegam pela URL única da Payt (uma para a conta toda)."
              : "Depois de criar, você recebe a URL de postback para colar na Payt, em Postback. O valor de cada venda vem da própria Payt."}
          </p>
        </>
      ) : null}

      {draft.origin === "automation_braip" ? (
        <>
          <ProductFilterPicker
            provider="braip"
            products={paytProducts}
            selected={draft.productCodes}
            onChange={(productCodes) => onChange({ productCodes })}
            disabled={disabled}
          />
          <p className="action-note">
            O valor de cada venda vem da própria Braip. As vendas chegam pela
            URL única da Braip (uma para a conta toda), que você cola na Braip
            em Ferramentas → Postback.
          </p>
        </>
      ) : null}

      {draft.origin === "automation_yampi" ? (
        <>
          <ProductFilterPicker
            provider="yampi"
            products={paytProducts}
            selected={draft.productCodes}
            onChange={(productCodes) => onChange({ productCodes })}
            disabled={disabled}
          />
          <p className="action-note">
            O valor de cada venda vem da própria Yampi: só os produtos, sem
            frete e sem os juros do parcelamento (no carrinho abandonado, o
            subtotal). Moeda: real (BRL). Os itens do pedido (com order bump)
            vão junto para a Meta. As vendas chegam pela URL única da Yampi
            (uma para a conta toda), cadastrada no webhook da loja.
          </p>
        </>
      ) : null}

      {conversionEventCarriesValue(definition.lockedEvent ?? draft.eventName) ? (
        <RuleCurrencySelect
          value={draft.currency}
          onChange={(currency) => onChange({ currency })}
          disabled={disabled}
          hint={ruleCurrencyHint(draft.origin)}
        />
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
        {draft.origin === "automation_roichat" ? (
          <div>
            <dt>Valor enviado</dt>
            <dd>
              {draft.averageValue.trim()
                ? `O valor de cada compra (reserva: ${draft.currency || "moeda da conta"} ${draft.averageValue.trim()})`
                : "O valor de cada compra (valor_venda)"}
            </dd>
          </div>
        ) : null}
        {(draft.origin === "automation_payt" && singleUrl) ||
        draft.origin === "automation_braip" ||
        draft.origin === "automation_yampi" ? (
          <div>
            <dt>Produtos</dt>
            <dd>
              {draft.productCodes.length > 0
                ? draft.productCodes.join(", ")
                : "Todos os produtos"}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Envio</dt>
          <dd>
            Já começa enviando: cada conversão reconhecida vai para a Meta pelo
            destino (pixel e página) de cada número.
          </dd>
        </div>
      </dl>
    </fieldset>
  );
}

/** Depois de criar: a URL única (Payt) ou a URL do evento (Unnichat/Umbler). */
function SingleUrlAfterCreate({
  provider,
  eventName,
  endpoints,
  actions,
}: {
  provider: IntegrationEndpointProviderDto;
  eventName: ConversionEventNameDto;
  endpoints: readonly IntegrationEndpointDto[];
  actions: SingleUrlActions;
}) {
  const existing = findEventEndpoint(endpoints, provider, eventName);
  const [created, setCreated] = useState<IntegrationEndpointDto | null>(null);
  const endpoint = created ?? existing;
  const sales = isSalesPlatform(provider);
  const platform =
    provider === "braip" ? "Braip" : provider === "yampi" ? "Yampi" : "Payt";
  const label = sales
    ? provider === "braip"
      ? "URL única da Braip (cole em Ferramentas → Postback)"
      : provider === "yampi"
        ? "URL única da Yampi (cadastre no webhook da loja)"
        : "URL única da Payt (cole em Postback)"
    : `URL do evento “${ruleEventLabelForOrigin(`automation_${provider}`, eventName)}”`;

  return (
    <div className="integration-modal-note single-url-after-create">
      <strong>{sales ? `URL única da ${platform}` : "URL do evento"}</strong>
      <p className="muted">
        {sales
          ? `A mesma URL vale para todas as regras e números da ${platform}. Se ela já está na ${platform}, não precisa fazer nada.`
          : "A mesma URL vale para todos os números da conta. Cole na automação que marca este evento."}
      </p>
      {endpoint ? (
        <IntegrationUrlBox
          key={endpoint.id}
          endpoint={endpoint}
          label={label}
          canManage
          actions={actions}
        />
      ) : (
        <EnsureUrlButton
          provider={provider}
          eventName={sales ? null : eventName}
          ensure={actions.ensure}
          label={sales ? "Gerar URL única" : "Gerar URL do evento"}
          onReady={setCreated}
        />
      )}
    </div>
  );
}

/** O que a moeda da regra significa em cada origem. */
/**
 * Fase 6.8 (porte do #183): ROI Chat. O valor de cada compra vem do payload;
 * a regra guarda só um valor de reserva opcional, usado quando a compra chega
 * sem valor_venda.
 */
function RoichatPurchaseFields({
  draft,
  onChange,
  disabled,
}: {
  draft: RuleDraft;
  onChange: (update: Partial<RuleDraft>) => void;
  disabled: boolean;
}) {
  return (
    <>
      <label className="conversion-field">
        <span className="field-label">Valor de reserva (opcional)</span>
        <input
          value={draft.averageValue}
          onChange={(event) => onChange({ averageValue: event.target.value })}
          inputMode="decimal"
          placeholder="Ex.: 20,00"
          disabled={disabled}
        />
      </label>
      <small className="action-note">
        Usado só quando a compra chegar sem valor_venda. Com o valor na compra,
        vai o valor da compra.
      </small>
      <p className="action-note">
        As compras chegam pela URL de cada número do ROI Chat, a mesma que
        recebe a entrada do lead: não há URL nova para cadastrar. A mesma
        pessoa pode comprar mais de uma vez; a mesma compra (mesmo lead, número,
        valor e moeda) repetida em até 12 horas conta uma vez só.
      </p>
    </>
  );
}

export function ruleCurrencyHint(origin: string): string {
  if (origin === "automation_roichat") {
    return "A moeda da compra vence; esta só vale quando a compra não informa a moeda.";
  }
  if (
    origin === "automation_payt" ||
    origin === "automation_braip" ||
    origin === "automation_yampi"
  ) {
    return "A moeda da venda vence; esta só vale quando a venda não informa a moeda.";
  }
  if (origin === "structured_catalog") {
    return "Moeda dos preços do catálogo.";
  }
  return "Moeda do valor enviado à Meta.";
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
