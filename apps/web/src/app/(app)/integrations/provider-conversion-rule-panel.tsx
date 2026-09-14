"use client";

import type {
  ConversionEventCategoryDto,
  ConversionEventNameDto,
  InboundWebhookChannelDto,
  ProviderConversionAutomationAuditDto,
  ProviderConversionAutomationAuditItemDto,
  ProviderConversionAutomationPayloadDto,
  ProviderConversionRuleExecutionAuditDto,
  ProviderConversionRuleExecutionAuditItemDto,
  ProviderConversionRuleDto,
  PurchaseReviewDto,
  PurchaseReviewListDto,
} from "@wpptrack/shared";
import {
  conversionEventBuilderLabel,
  conversionEventCarriesValue,
  conversionEventCatalogOrdered,
  conversionEventMetadata,
  conversionEventRequiresValue,
} from "@wpptrack/shared";
import {
  BookOpen,
  Check,
  Copy,
  Eye,
  FlaskConical,
  ListChecks,
  MessageSquareText,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useRef, useState } from "react";
import { PresentationMask } from "../../../components/presentation-mask";
import type {
  ProviderConversionRuleActionResult,
  ProviderConversionRuleOneTimeSecret,
} from "./provider-conversion-rule-actions";
import { ProviderCatalogTestConsole } from "../settings/provider-catalog-test-console";
import {
  executionReasonLabel,
  purchaseReviewReasonLabel,
  purchaseReviewStatusLabel,
  purchaseReviewTone,
} from "../settings/provider-conversion-labels";
import {
  UazapiLabelPicker,
  type UazapiTriggerLabel,
} from "./uazapi-label-picker";

type ProviderRuleAction = (
  formData: FormData,
) => Promise<ProviderConversionRuleActionResult>;

/**
 * Onde a regra e reconhecida. Cada origem mapeia um triggerType do contrato:
 * message -> message_phrase, tag -> provider_automation, catalog ->
 * structured_catalog. O evento enviado a Meta e escolhido a parte.
 */
export type ConversionRuleOrigin = "message" | "tag" | "catalog";

const conversionRuleOriginLabels: Record<ConversionRuleOrigin, string> = {
  message: "Mensagem no WhatsApp",
  tag: "Tag ou automacao do provedor",
  catalog: "Catalogo estruturado",
};

const conversionEventCategoryLabels: Record<
  ConversionEventCategoryDto,
  string
> = {
  journey: "Jornada",
  conversion: "Conversao",
  operational: "Operacional",
};

/** structured_catalog continua restrito a Purchase (ver contrato em shared). */
const catalogOriginEventName = "Purchase" satisfies ConversionEventNameDto;

type MessageAuthorScope = "team" | "contact" | "both";

type MessagePhraseValueMode = "fixed" | "message_extracted";

/** Campos de uma regra message_phrase, qualquer que seja o evento. */
type MessagePhraseValues = {
  averageValue: string;
  contentName: string;
  primaryPhrase: string;
  variationPhrases: string;
  exampleMessage: string;
  valueMode: MessagePhraseValueMode;
  messageAuthorScope: MessageAuthorScope;
};

export type MessagePhrasePreview = {
  matchedPhrase: string | null;
  valueCents: number | null;
  valueSource: "fixed" | "message" | "fallback" | null;
  ambiguousValue: boolean;
};

type CatalogAttributeDraft = {
  id: number;
  label: string;
};

type CatalogVariantDraft = {
  id: number;
  values: string[];
  aliases: string[];
  value: string;
  contentName: string;
};

type Notice = {
  tone: "success" | "error";
  message: string;
};

export type ProviderConversionRulePanelProps = {
  connectionId: string;
  connectionProvider: "umbler" | "gupshup" | "uazapi";
  channels: InboundWebhookChannelDto[];
  rules: ProviderConversionRuleDto[];
  enabled: boolean;
  canManage: boolean;
  createAction: ProviderRuleAction;
  updateAction: ProviderRuleAction;
  rotateEndpointAction: ProviderRuleAction;
  loadAutomationAuditAction: ProviderRuleAction;
  loadAutomationPayloadAction: ProviderRuleAction;
  loadPurchaseAuditAction: ProviderRuleAction;
  loadExecutionAuditAction: ProviderRuleAction;
  reprocessAutomationCallbacksAction: ProviderRuleAction;
  removeAction: ProviderRuleAction;
  testMessageAction: ProviderRuleAction;
};

export function ProviderConversionRulePanel({
  connectionId,
  connectionProvider,
  channels,
  rules,
  enabled,
  canManage,
  createAction,
  updateAction,
  rotateEndpointAction,
  loadAutomationAuditAction,
  loadAutomationPayloadAction,
  loadPurchaseAuditAction,
  loadExecutionAuditAction,
  reprocessAutomationCallbacksAction,
  removeAction,
  testMessageAction,
}: ProviderConversionRulePanelProps) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [origin, setOrigin] = useState<ConversionRuleOrigin>("message");
  const [eventName, setEventName] =
    useState<ConversionEventNameDto>("QualifiedLead");
  const [name, setName] = useState("");
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>(() =>
    channels.map((channel) => channel.id),
  );
  const [averageValue, setAverageValue] = useState("");
  const [contentName, setContentName] = useState("");
  const [triggerPhrases, setTriggerPhrases] = useState("");
  const [triggerLabels, setTriggerLabels] = useState<UazapiTriggerLabel[]>([]);
  const [primaryPhrase, setPrimaryPhrase] = useState("");
  const [variationPhrases, setVariationPhrases] = useState("");
  const [exampleMessage, setExampleMessage] = useState("");
  const [valueMode, setValueMode] = useState<MessagePhraseValueMode>("fixed");
  const [messageAuthorScope, setMessageAuthorScope] =
    useState<MessageAuthorScope>("team");
  const [catalogName, setCatalogName] = useState("");
  const [productName, setProductName] = useState("");
  const [attributes, setAttributes] = useState<CatalogAttributeDraft[]>([
    { id: 1, label: "" },
  ]);
  const [variants, setVariants] = useState<CatalogVariantDraft[]>([
    emptyVariant(1, 1),
  ]);
  const [nextAttributeId, setNextAttributeId] = useState(2);
  const [nextVariantId, setNextVariantId] = useState(2);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [oneTimeSecret, setOneTimeSecret] =
    useState<ProviderConversionRuleOneTimeSecret | null>(null);
  // Capturado no momento da criacao/rotacao (nao depende do refresh do
  // servidor) para montar o exemplo de payload junto da URL de uso unico.
  const [oneTimeSecretEventName, setOneTimeSecretEventName] =
    useState<ConversionEventNameDto | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (pending) return;

    const payload = buildCreatePayload({
      connectionId,
      origin,
      eventName,
      name,
      selectedChannelIds,
      averageValue,
      contentName,
      triggerPhrases:
        origin === "message"
          ? mergeTriggerPhrases(primaryPhrase, variationPhrases)
          : triggerPhrases,
      triggerLabels,
      exampleMessage,
      valueMode,
      messageAuthorScope,
      catalogName,
      productName,
      attributes,
      variants,
    });

    if (!payload.ok) {
      setNotice({ tone: "error", message: payload.message });
      return;
    }

    const formData = new FormData();
    formData.set("payload", JSON.stringify(payload.value));
    setPending("create");
    setNotice(null);
    const result = await createAction(formData);
    applyResult(result);

    if (result.ok) {
      setCreateOpen(false);
      setName("");
      setTriggerLabels([]);
      if (result.oneTimeSecret) {
        setOneTimeSecret(result.oneTimeSecret);
        setOneTimeSecretEventName(origin === "tag" ? eventName : null);
        setCopied(false);
      }
      router.refresh();
    }

    setPending(null);
  }

  async function runRuleAction(
    key: string,
    action: ProviderRuleAction,
    values: Record<string, string>,
    automationEventName: ConversionEventNameDto | null = null,
  ) {
    if (pending) return;

    const formData = new FormData();
    for (const [field, value] of Object.entries(values)) {
      formData.set(field, value);
    }

    setPending(key);
    setNotice(null);
    const result = await action(formData);
    applyResult(result);

    if (result.ok) {
      if (result.oneTimeSecret) {
        setOneTimeSecret(result.oneTimeSecret);
        setOneTimeSecretEventName(automationEventName);
        setCopied(false);
      }
      router.refresh();
    }

    setPending(null);
  }

  function applyResult(result: ProviderConversionRuleActionResult) {
    setNotice({
      tone: result.ok ? "success" : "error",
      message: result.message,
    });
  }

  async function copyWebhookUrl() {
    if (!oneTimeSecret) return;

    try {
      await navigator.clipboard.writeText(oneTimeSecret.webhookUrl);
      setCopied(true);
      setNotice({
        tone: "success",
        message: "URL copiada. Cadastre-a na automacao do provedor.",
      });
    } catch {
      setNotice({
        tone: "error",
        message: "Nao foi possivel copiar automaticamente. Selecione a URL.",
      });
    }
  }

  /**
   * O catalogo estruturado so existe para Purchase; qualquer outra origem
   * mantem o evento escolhido. Trocar para uma origem de mensagem devolve o
   * autor padrao "team", que e o unico que faz sentido fora do catalogo.
   */
  function selectOrigin(next: ConversionRuleOrigin) {
    setOrigin(next);
    setMessageAuthorScope(next === "catalog" ? "both" : "team");
    if (next === "catalog") selectEvent(catalogOriginEventName);
  }

  /** Evento sem valor limpa o rascunho monetario para nao vazar no payload. */
  function selectEvent(next: ConversionEventNameDto) {
    setEventName(next);
    if (!conversionEventCarriesValue(next)) {
      setAverageValue("");
      setContentName("");
      setValueMode("fixed");
    }
  }

  function toggleChannel(channelId: string) {
    setSelectedChannelIds((current) =>
      current.includes(channelId)
        ? current.filter((id) => id !== channelId)
        : [...current, channelId],
    );
  }

  function addAttribute() {
    if (attributes.length >= 2) return;

    setAttributes((current) => [
      ...current,
      { id: nextAttributeId, label: "" },
    ]);
    setVariants((current) =>
      current.map((variant) => ({
        ...variant,
        values: [...variant.values, ""],
        aliases: [...variant.aliases, ""],
      })),
    );
    setNextAttributeId((current) => current + 1);
  }

  function removeAttribute(index: number) {
    if (attributes.length <= 1) return;

    setAttributes((current) => current.filter((_, item) => item !== index));
    setVariants((current) =>
      current.map((variant) => ({
        ...variant,
        values: variant.values.filter((_, item) => item !== index),
        aliases: variant.aliases.filter((_, item) => item !== index),
      })),
    );
  }

  function addVariant() {
    setVariants((current) => [
      ...current,
      emptyVariant(nextVariantId, attributes.length),
    ]);
    setNextVariantId((current) => current + 1);
  }

  function updateVariant(
    variantId: number,
    update: (variant: CatalogVariantDraft) => CatalogVariantDraft,
  ) {
    setVariants((current) =>
      current.map((variant) =>
        variant.id === variantId ? update(variant) : variant,
      ),
    );
  }

  // Somente canais UAZAPI trazem whatsappInstanceId; conexoes como Umbler
  // mantem o textarea de frases gatilho.
  const resolvedWhatsappInstanceId = resolveUazapiWhatsappInstanceId(
    channels,
    selectedChannelIds,
  );

  return (
    <section className="provider-conversion-panel">
      <header className="provider-conversion-heading">
        <div>
          <span className="eyebrow">Eventos de conversao</span>
          <h3>Qualificados, compras e checkout</h3>
          <p className="muted">
            Regras independentes por canal, preservadas em observacao antes de
            qualquer envio.
          </p>
        </div>
        <div className="provider-conversion-heading-actions">
          <span className={`event-chip ${enabled ? "success" : "warn"}`}>
            {enabled ? "Observacao disponivel" : "Indisponivel"}
          </span>
          {canManage && enabled && channels.length > 0 ? (
            <button
              className="button"
              type="button"
              onClick={() => setCreateOpen((current) => !current)}
              aria-expanded={createOpen}
            >
              {createOpen ? (
                <X size={15} aria-hidden="true" />
              ) : (
                <Plus size={15} aria-hidden="true" />
              )}
              {createOpen ? "Fechar" : "Nova regra"}
            </button>
          ) : null}
        </div>
      </header>

      {canManage && enabled && channels.length === 0 ? (
        <div className="feedback-banner warn" role="status">
          <span>
            Nenhum canal cadastrado nesta conexao ainda. Cadastre o numero
            conectado em Integracoes para liberar a criacao de regras — nao e
            preciso esperar a primeira mensagem chegar.
          </span>
        </div>
      ) : null}

      {oneTimeSecret ? (
        <div className="provider-conversion-secret-group">
          <div
            className="provider-conversion-secret"
            data-presentation-sensitive-action="true"
          >
            <div>
              <span className="micro-label">URL exibida uma unica vez</span>
              <strong>Webhook da automacao</strong>
            </div>
            <input
              readOnly
              value={oneTimeSecret.webhookUrl}
              aria-label="URL privada da automacao"
              data-presentation-sensitive-field="true"
            />
            <button className="button" type="button" onClick={copyWebhookUrl}>
              {copied ? (
                <Check size={15} aria-hidden="true" />
              ) : (
                <Copy size={15} aria-hidden="true" />
              )}
              {copied ? "Copiada" : "Copiar URL"}
            </button>
            <button
              className="icon-button"
              type="button"
              title="Ocultar URL"
              aria-label="Ocultar URL"
              onClick={() => setOneTimeSecret(null)}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          {connectionProvider === "umbler" && oneTimeSecretEventName ? (
            <UmblerAutomationPayloadPanel eventName={oneTimeSecretEventName} />
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <div
          className={`feedback-banner ${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          <span>{notice.message}</span>
        </div>
      ) : null}

      {createOpen ? (
        <form className="provider-conversion-builder" onSubmit={handleCreate}>
          <ConversionRuleOriginEventSelector
            origin={origin}
            eventName={eventName}
            onOriginChange={selectOrigin}
            onEventChange={selectEvent}
          />

          <div className="provider-conversion-base-fields">
            <label>
              <span className="field-label">Nome da regra</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                minLength={2}
                maxLength={120}
                placeholder="Ex.: Compra confirmada"
                required
              />
            </label>
            {origin === "tag" && conversionEventCarriesValue(eventName) ? (
              <>
                <label>
                  <span className="field-label">
                    {conversionEventRequiresValue(eventName)
                      ? "Valor medio (R$)"
                      : "Valor medio (opcional)"}
                  </span>
                  <input
                    value={averageValue}
                    onChange={(event) => setAverageValue(event.target.value)}
                    inputMode="decimal"
                    placeholder="Ex.: 299,90"
                    required={conversionEventRequiresValue(eventName)}
                  />
                </label>
                <label>
                  <span className="field-label">Produto (opcional)</span>
                  <input
                    value={contentName}
                    onChange={(event) => setContentName(event.target.value)}
                    maxLength={180}
                    placeholder="Ex.: Pedido medio"
                  />
                </label>
              </>
            ) : null}
          </div>

          {origin === "message" ? (
            <MessagePhraseFields
              eventName={eventName}
              averageValue={averageValue}
              contentName={contentName}
              primaryPhrase={primaryPhrase}
              variationPhrases={variationPhrases}
              exampleMessage={exampleMessage}
              valueMode={valueMode}
              messageAuthorScope={messageAuthorScope}
              onChange={(patch) => {
                if (patch.averageValue !== undefined) {
                  setAverageValue(patch.averageValue);
                }
                if (patch.contentName !== undefined) {
                  setContentName(patch.contentName);
                }
                if (patch.primaryPhrase !== undefined) {
                  setPrimaryPhrase(patch.primaryPhrase);
                }
                if (patch.variationPhrases !== undefined) {
                  setVariationPhrases(patch.variationPhrases);
                }
                if (patch.exampleMessage !== undefined) {
                  setExampleMessage(patch.exampleMessage);
                }
                if (patch.valueMode !== undefined) {
                  setValueMode(patch.valueMode);
                }
                if (patch.messageAuthorScope !== undefined) {
                  setMessageAuthorScope(patch.messageAuthorScope);
                }
              }}
            />
          ) : null}

          {origin === "tag" ? (
            <div className="provider-conversion-message-fields">
              {resolvedWhatsappInstanceId ? (
                <UazapiLabelPicker
                  whatsappInstanceId={resolvedWhatsappInstanceId}
                  selectedLabels={triggerLabels}
                  onLabelsChange={setTriggerLabels}
                  fallbackValue={triggerPhrases}
                  onFallbackChange={setTriggerPhrases}
                />
              ) : (
                <label>
                  <span className="field-label">Etiquetas do WhatsApp</span>
                  <textarea
                    value={triggerPhrases}
                    onChange={(event) => setTriggerPhrases(event.target.value)}
                    rows={3}
                    maxLength={4_800}
                    placeholder="Uma por linha. Ex.: Venda fechada"
                    required
                  />
                  <small className="action-note">
                    A regra dispara quando a conversa receber uma dessas
                    etiquetas ou automacoes.
                  </small>
                </label>
              )}
            </div>
          ) : null}

          {origin === "catalog" ? (
            <div className="provider-conversion-base-fields">
              <label>
                <span className="field-label">Frases gatilho</span>
                <textarea
                  value={triggerPhrases}
                  onChange={(event) => setTriggerPhrases(event.target.value)}
                  rows={3}
                  maxLength={4_800}
                  placeholder="Uma por linha. Ex.: Dados para confirmar o pedido"
                  required
                />
              </label>
              <label>
                <span className="field-label">Quem pode enviar</span>
                <select
                  value={messageAuthorScope}
                  onChange={(event) =>
                    setMessageAuthorScope(
                      event.target.value as MessageAuthorScope,
                    )
                  }
                >
                  <option value="team">Equipe ou bot</option>
                  <option value="contact">Somente contato</option>
                  <option value="both">Equipe, bot ou contato</option>
                </select>
              </label>
            </div>
          ) : null}

          <ChannelSelector
            channels={channels}
            selectedChannelIds={selectedChannelIds}
            onToggle={toggleChannel}
          />

          {origin === "catalog" ? (
            <div className="provider-catalog-builder">
              <div className="provider-catalog-meta">
                <label>
                  <span className="field-label">Nome do catalogo</span>
                  <input
                    value={catalogName}
                    onChange={(event) => setCatalogName(event.target.value)}
                    placeholder="Ex.: Produtos vendidos"
                    required
                  />
                </label>
                <label>
                  <span className="field-label">Produto principal</span>
                  <input
                    value={productName}
                    onChange={(event) => setProductName(event.target.value)}
                    placeholder="Ex.: Cama elastica"
                    required
                  />
                </label>
              </div>

              <div className="provider-catalog-section">
                <div className="provider-catalog-section-heading">
                  <div>
                    <span className="micro-label">Campos da mensagem</span>
                    <strong>Atributos</strong>
                  </div>
                  {attributes.length < 2 ? (
                    <button
                      className="button subtle"
                      type="button"
                      onClick={addAttribute}
                    >
                      <Plus size={14} aria-hidden="true" />
                      Adicionar atributo
                    </button>
                  ) : null}
                </div>
                <div className="provider-catalog-attributes">
                  {attributes.map((attribute, index) => (
                    <label key={attribute.id}>
                      <span className="field-label">Atributo {index + 1}</span>
                      <span className="provider-catalog-input-action">
                        <input
                          value={attribute.label}
                          onChange={(event) =>
                            setAttributes((current) =>
                              current.map((item) =>
                                item.id === attribute.id
                                  ? { ...item, label: event.target.value }
                                  : item,
                              ),
                            )
                          }
                          placeholder={
                            index === 0 ? "Ex.: Tamanho" : "Ex.: Modelo"
                          }
                          required
                        />
                        {attributes.length > 1 ? (
                          <button
                            className="icon-button danger"
                            type="button"
                            title={`Remover atributo ${index + 1}`}
                            aria-label={`Remover atributo ${index + 1}`}
                            onClick={() => removeAttribute(index)}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="provider-catalog-section">
                <div className="provider-catalog-section-heading">
                  <div>
                    <span className="micro-label">
                      Preco fixo por combinacao
                    </span>
                    <strong>Variantes</strong>
                  </div>
                  <button
                    className="button subtle"
                    type="button"
                    onClick={addVariant}
                  >
                    <Plus size={14} aria-hidden="true" />
                    Adicionar variante
                  </button>
                </div>
                <div className="provider-catalog-variants">
                  {variants.map((variant, variantIndex) => (
                    <div className="provider-catalog-variant" key={variant.id}>
                      <span className="provider-catalog-variant-index">
                        {variantIndex + 1}
                      </span>
                      <div
                        className={`provider-catalog-variant-fields attributes-${attributes.length}`}
                      >
                        <div className="provider-catalog-variant-attributes">
                          {attributes.map((attribute, attributeIndex) => (
                            <div
                              className="provider-catalog-variant-attribute"
                              key={attribute.id}
                            >
                              <label>
                                <span className="field-label">
                                  {attribute.label ||
                                    `Atributo ${attributeIndex + 1}`}
                                </span>
                                <input
                                  value={variant.values[attributeIndex] ?? ""}
                                  onChange={(event) =>
                                    updateVariant(variant.id, (current) => ({
                                      ...current,
                                      values: replaceAt(
                                        current.values,
                                        attributeIndex,
                                        event.target.value,
                                      ),
                                    }))
                                  }
                                  placeholder="Valor exato"
                                  required
                                />
                              </label>
                              <label>
                                <span className="field-label">
                                  Outras formas aceitas (opcional)
                                </span>
                                <input
                                  value={variant.aliases[attributeIndex] ?? ""}
                                  onChange={(event) =>
                                    updateVariant(variant.id, (current) => ({
                                      ...current,
                                      aliases: replaceAt(
                                        current.aliases,
                                        attributeIndex,
                                        event.target.value,
                                      ),
                                    }))
                                  }
                                  placeholder="Ex.: abreviacao, outra escrita"
                                  title="Separe por virgulas apenas quando o mesmo valor puder chegar escrito de outra forma."
                                />
                              </label>
                            </div>
                          ))}
                        </div>
                        <div className="provider-catalog-variant-commerce">
                          <label>
                            <span className="field-label">
                              Preco da combinacao (R$)
                            </span>
                            <input
                              value={variant.value}
                              onChange={(event) =>
                                updateVariant(variant.id, (current) => ({
                                  ...current,
                                  value: event.target.value,
                                }))
                              }
                              inputMode="decimal"
                              placeholder="Ex.: 1.597,00"
                              required
                            />
                          </label>
                          <label>
                            <span className="field-label">
                              Nome da variante na Meta (opcional)
                            </span>
                            <input
                              value={variant.contentName}
                              onChange={(event) =>
                                updateVariant(variant.id, (current) => ({
                                  ...current,
                                  contentName: event.target.value,
                                }))
                              }
                              placeholder="Automatico: produto + atributos"
                              title="Se ficar vazio, o nome sera montado automaticamente com o produto e os atributos desta variante."
                            />
                          </label>
                        </div>
                      </div>
                      {variants.length > 1 ? (
                        <button
                          className="icon-button danger"
                          type="button"
                          title={`Remover variante ${variantIndex + 1}`}
                          aria-label={`Remover variante ${variantIndex + 1}`}
                          onClick={() =>
                            setVariants((current) =>
                              current.filter((item) => item.id !== variant.id),
                            )
                          }
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          <div className="provider-conversion-builder-footer">
            <span className="action-note">
              A nova regra sera criada em modo de observacao.
            </span>
            <button
              className="button primary"
              type="submit"
              disabled={pending === "create"}
            >
              <Check size={15} aria-hidden="true" />
              {pending === "create" ? "Salvando..." : "Criar regra"}
            </button>
          </div>
        </form>
      ) : null}

      <div className="provider-conversion-rule-list">
        {rules.length === 0 ? (
          <div className="provider-conversion-empty">
            <FlaskConical size={18} aria-hidden="true" />
            <span>Nenhuma regra de qualificado ou compra configurada.</span>
          </div>
        ) : (
          rules.map((rule) => {
            const automation =
              rule.conversionRule.triggerType === "provider_automation";
            const messagePhrase =
              rule.conversionRule.triggerType === "message_phrase";
            const isPurchaseRule =
              rule.conversionRule.triggerType === "structured_catalog" ||
              rule.conversionRule.eventName === "Purchase";
            const uazapiAutomation =
              automation && connectionProvider === "uazapi";
            const umblerAutomation =
              automation && connectionProvider === "umbler";
            const active = rule.conversionRule.active;
            return (
              <article className="provider-conversion-rule" key={rule.id}>
                <div className="provider-conversion-rule-main">
                  <div className="provider-conversion-rule-icon">
                    {automation ? (
                      <Tag size={17} aria-hidden="true" />
                    ) : messagePhrase ? (
                      <MessageSquareText size={17} aria-hidden="true" />
                    ) : (
                      <BookOpen size={17} aria-hidden="true" />
                    )}
                  </div>
                  <div className="provider-conversion-rule-copy">
                    <div className="provider-conversion-rule-title">
                      <strong>{rule.conversionRule.name}</strong>
                      <span className="event-chip neutral">
                        {eventLabel(rule)}
                      </span>
                      <span
                        className={`event-chip ${active ? "success" : "warn"}`}
                      >
                        {!active
                          ? "Pausada"
                          : rule.mode === "production"
                            ? "Envio ativo"
                            : "Observando"}
                      </span>
                    </div>
                    <span>
                      {eventLabel(rule)} /{" "}
                      {uazapiAutomation
                        ? "Lista WhatsApp (chat_labels)"
                        : triggerLabel(rule)}
                      {messagePhrase ? ` / ${valueModeLabel(rule)}` : ""} /{" "}
                      {rule.channelIds.length} canal(is)
                    </span>
                    <small>
                      {rule.lastExecution
                        ? `Ultimo resultado: ${executionStatusLabel(rule.lastExecution.status)} / ${executionReasonLabel(rule.lastExecution.reasonCode)} / ${formatDateTime(rule.lastExecution.occurredAt)}`
                        : uazapiAutomation
                          ? rule.mode === "observation"
                            ? "Aguardando contato entrar na lista. Em observacao, lead pago nao e obrigatorio para validar o match."
                            : "Aguardando contato entrar na lista. Em producao, apenas leads pagos podem gerar eventos."
                          : automation
                            ? `Ultimo callback: ${formatDateTime(rule.endpoint?.lastDeliveryAt ?? null)}`
                            : `${rule.catalog?.variants.length ?? 0} variante(s) cadastrada(s)`}
                    </small>
                  </div>
                </div>

                {canManage ? (
                  <div className="provider-conversion-rule-actions">
                    {active ? (
                      <button
                        className="icon-button"
                        type="button"
                        title={
                          rule.mode === "production"
                            ? "Voltar para observacao"
                            : "Ativar envio automatico"
                        }
                        aria-label={
                          rule.mode === "production"
                            ? "Voltar para observacao"
                            : "Ativar envio automatico"
                        }
                        disabled={Boolean(pending)}
                        onClick={() => {
                          const activating = rule.mode !== "production";
                          if (
                            !activating ||
                            window.confirm(
                              `Ativar o envio automatico dos novos eventos de ${eventLabel(rule).toLocaleLowerCase("pt-BR")} reconhecidos por esta regra? O historico anterior permanecera apenas observado.`,
                            )
                          ) {
                            void runRuleAction(
                              `mode-${rule.id}`,
                              updateAction,
                              {
                                ruleId: rule.id,
                                payload: JSON.stringify({
                                  mode: activating
                                    ? "production"
                                    : "observation",
                                }),
                              },
                            );
                          }
                        }}
                      >
                        <Send size={15} aria-hidden="true" />
                      </button>
                    ) : null}
                    <button
                      className="icon-button"
                      type="button"
                      title={active ? "Pausar regra" : "Retomar observacao"}
                      aria-label={
                        active ? "Pausar regra" : "Retomar observacao"
                      }
                      disabled={Boolean(pending)}
                      onClick={() =>
                        void runRuleAction(`active-${rule.id}`, updateAction, {
                          ruleId: rule.id,
                          payload: JSON.stringify({ active: !active }),
                        })
                      }
                    >
                      {active ? (
                        <Pause size={15} aria-hidden="true" />
                      ) : (
                        <Play size={15} aria-hidden="true" />
                      )}
                    </button>
                    {automation ? (
                      <button
                        className="icon-button"
                        type="button"
                        title="Gerar nova URL"
                        aria-label="Gerar nova URL"
                        disabled={Boolean(pending)}
                        onClick={() => {
                          if (
                            window.confirm(
                              "Gerar uma nova URL invalida a URL atual desta automacao. Continuar?",
                            )
                          ) {
                            void runRuleAction(
                              `rotate-${rule.id}`,
                              rotateEndpointAction,
                              { ruleId: rule.id },
                              rule.conversionRule.eventName,
                            );
                          }
                        }}
                      >
                        <RefreshCw size={15} aria-hidden="true" />
                      </button>
                    ) : null}
                    <button
                      className="icon-button danger"
                      type="button"
                      title="Remover regra"
                      aria-label="Remover regra"
                      disabled={Boolean(pending)}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Remover esta regra? O historico observado sera preservado.",
                          )
                        ) {
                          void runRuleAction(
                            `remove-${rule.id}`,
                            removeAction,
                            { ruleId: rule.id },
                          );
                        }
                      }}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                ) : null}

                <RuleChannelEditor
                  rule={rule}
                  channels={channels}
                  canManage={canManage}
                  updateAction={updateAction}
                  onResult={applyResult}
                />

                {umblerAutomation ? (
                  <UmblerAutomationSetupDetails
                    eventName={rule.conversionRule.eventName}
                  />
                ) : null}

                {automation && !uazapiAutomation && canManage ? (
                  <AutomationCallbackAudit
                    rule={rule}
                    loadAuditAction={loadAutomationAuditAction}
                    loadPayloadAction={loadAutomationPayloadAction}
                    reprocessAction={reprocessAutomationCallbacksAction}
                  />
                ) : null}

                {messagePhrase && rule.exampleMessage ? (
                  <details className="provider-conversion-rule-scope">
                    <summary>
                      <span>Exemplo da mensagem</span>
                      <strong>{valueModeLabel(rule)}</strong>
                    </summary>
                    <p className="provider-conversion-rule-example">
                      {rule.exampleMessage}
                    </p>
                  </details>
                ) : null}

                {!automation ? (
                  <MessageRuleEditor
                    rule={rule}
                    canManage={canManage}
                    updateAction={updateAction}
                    onResult={applyResult}
                  />
                ) : null}

                {rule.catalog ? (
                  <CatalogRuleDetails
                    rule={rule}
                    canManage={canManage}
                    updateAction={updateAction}
                    testMessageAction={testMessageAction}
                    onResult={applyResult}
                  />
                ) : null}

                {!automation && canManage ? (
                  isPurchaseRule ? (
                    <PurchaseRuleAudit
                      rule={rule}
                      loadAuditAction={loadPurchaseAuditAction}
                    />
                  ) : (
                    <ExecutionRuleAudit
                      rule={rule}
                      loadAuditAction={loadExecutionAuditAction}
                    />
                  )
                ) : null}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

type AutomationAuditFilter = "all" | "recoverable" | "blocked" | "materialized";

function AutomationCallbackAudit({
  rule,
  loadAuditAction,
  loadPayloadAction,
  reprocessAction,
}: {
  rule: ProviderConversionRuleDto;
  loadAuditAction: ProviderRuleAction;
  loadPayloadAction: ProviderRuleAction;
  reprocessAction: ProviderRuleAction;
}) {
  const payloadDialogRef = useRef<HTMLDialogElement>(null);
  const [audit, setAudit] =
    useState<ProviderConversionAutomationAuditDto | null>(null);
  const [payload, setPayload] =
    useState<ProviderConversionAutomationPayloadDto | null>(null);
  const [filter, setFilter] = useState<AutomationAuditFilter>("recoverable");
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function loadAudit(showSuccess = false, clearNotice = true) {
    if (loading) return;
    const formData = new FormData();
    formData.set("ruleId", rule.id);
    setLoading(true);
    if (!showSuccess && clearNotice) setNotice(null);
    const result = await loadAuditAction(formData);
    if (result.ok && result.automationAudit) {
      setAudit(result.automationAudit);
      const recoverableIds = new Set(
        result.automationAudit.items
          .filter((item) => item.reprocessable)
          .map((item) => item.deliveryId),
      );
      setSelected((current) =>
        current.filter((deliveryId) => recoverableIds.has(deliveryId)),
      );
      if (showSuccess) {
        setNotice({ tone: "success", message: result.message });
      }
    } else {
      setNotice({ tone: "error", message: result.message });
    }
    setLoading(false);
  }

  async function openPayload(deliveryId: string) {
    const formData = new FormData();
    formData.set("ruleId", rule.id);
    formData.set("deliveryId", deliveryId);
    setLoading(true);
    setNotice(null);
    const result = await loadPayloadAction(formData);
    if (result.ok && result.automationPayload) {
      setPayload(result.automationPayload);
      payloadDialogRef.current?.showModal();
    } else {
      setNotice({ tone: "error", message: result.message });
    }
    setLoading(false);
  }

  async function reprocess(deliveryIds: string[]) {
    if (reprocessing || deliveryIds.length === 0) return;
    if (
      !window.confirm(
        `Reavaliar ${deliveryIds.length} callback(s) selecionado(s) e encaminhar somente os que possuem lead pago com CTWA?`,
      )
    ) {
      return;
    }

    const formData = new FormData();
    formData.set("ruleId", rule.id);
    formData.set(
      "payload",
      JSON.stringify({
        confirmation: "REPROCESSAR_CALLBACKS_SELECIONADOS",
        deliveryIds,
      }),
    );
    setReprocessing(true);
    setNotice(null);
    const result = await reprocessAction(formData);
    if (result.ok) {
      setSelected([]);
      await loadAudit(false, false);
    }
    setNotice({
      tone: result.ok ? "success" : "error",
      message: result.message,
    });
    setReprocessing(false);
  }

  const visibleItems = audit
    ? audit.items.filter((item) => {
        if (filter === "recoverable") return item.reprocessable;
        if (filter === "blocked") return item.status === "blocked";
        if (filter === "materialized") return item.status === "materialized";
        return true;
      })
    : [];
  const recoverableIds = audit
    ? audit.items
        .filter((item) => item.reprocessable)
        .map((item) => item.deliveryId)
        .slice(0, 50)
    : [];

  return (
    <details
      className="provider-callback-audit"
      onToggle={(event) => {
        if (event.currentTarget.open && !audit && !loading) {
          void loadAudit();
        }
      }}
    >
      <summary>
        <span className="provider-callback-audit-heading">
          <ListChecks size={17} aria-hidden="true" />
          <span>
            <strong>Auditar eventos recebidos</strong>
            <small>Payload, diagnostico e reprocessamento por callback</small>
          </span>
        </span>
        <span className="status-chip">
          {audit ? `${audit.summary.recoverable} recuperavel(is)` : "Abrir"}
        </span>
      </summary>

      <div className="provider-callback-audit-body">
        {notice ? (
          <div className={`inline-notice ${notice.tone}`}>{notice.message}</div>
        ) : null}

        {loading && !audit ? (
          <div className="provider-conversion-empty">
            <RefreshCw size={17} aria-hidden="true" />
            <span>Carregando callbacks preservados...</span>
          </div>
        ) : audit ? (
          <>
            <div
              className="provider-callback-summary"
              aria-label="Resumo dos callbacks"
            >
              <AuditMetric label="Recebidos" value={audit.summary.total} />
              <AuditMetric label="Observados" value={audit.summary.observed} />
              <AuditMetric
                label="Bloqueados"
                value={audit.summary.blocked}
                tone="warn"
              />
              <AuditMetric
                label="Falhas"
                value={audit.summary.failed}
                tone="warn"
              />
              <AuditMetric
                label="Na fila"
                value={audit.summary.queued}
                tone="info"
              />
              <AuditMetric
                label="Eventos criados"
                value={audit.summary.materialized}
                tone="success"
              />
              <AuditMetric
                label="Recuperaveis"
                value={audit.summary.recoverable}
                tone="accent"
              />
            </div>

            <div className="provider-callback-toolbar">
              <div
                className="provider-callback-filters"
                aria-label="Filtrar callbacks"
              >
                {(
                  [
                    ["recoverable", "Recuperaveis"],
                    ["blocked", "Bloqueados"],
                    ["materialized", "Eventos criados"],
                    ["all", "Todos"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    className={filter === value ? "active" : undefined}
                    type="button"
                    key={value}
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="provider-callback-toolbar-actions">
                <button
                  className="button ghost compact-button"
                  type="button"
                  disabled={loading}
                  onClick={() => void loadAudit(true)}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  Atualizar
                </button>
                {recoverableIds.length > 0 ? (
                  <button
                    className="button ghost compact-button"
                    type="button"
                    onClick={() =>
                      setSelected(
                        selected.length === recoverableIds.length
                          ? []
                          : recoverableIds,
                      )
                    }
                  >
                    <Check size={14} aria-hidden="true" />
                    {selected.length === recoverableIds.length
                      ? "Limpar selecao"
                      : "Selecionar ate 50"}
                  </button>
                ) : null}
                <button
                  className="button primary compact-button"
                  type="button"
                  disabled={selected.length === 0 || reprocessing}
                  onClick={() => void reprocess(selected)}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                  {reprocessing
                    ? "Reprocessando..."
                    : `Reprocessar ${selected.length || "selecionados"}`}
                </button>
              </div>
            </div>

            <div className="provider-callback-table" role="table">
              <div
                className="provider-callback-row provider-callback-row-head"
                role="row"
              >
                <span aria-label="Selecionar" />
                <span>Recebido</span>
                <span>Evento e canal</span>
                <span>Diagnostico</span>
                <span>Payload</span>
                <span>Acao</span>
              </div>
              {visibleItems.length > 0 ? (
                visibleItems.map((item) => (
                  <AutomationCallbackRow
                    key={item.deliveryId}
                    item={item}
                    selected={selected.includes(item.deliveryId)}
                    busy={loading || reprocessing}
                    onSelect={(checked) =>
                      setSelected((current) =>
                        checked
                          ? [...new Set([...current, item.deliveryId])]
                          : current.filter(
                              (deliveryId) => deliveryId !== item.deliveryId,
                            ),
                      )
                    }
                    onPayload={() => void openPayload(item.deliveryId)}
                    onReprocess={() => void reprocess([item.deliveryId])}
                  />
                ))
              ) : (
                <div className="provider-callback-empty">
                  Nenhum callback encontrado neste filtro.
                </div>
              )}
            </div>
            {audit.summary.total > audit.items.length ? (
              <p className="action-note">
                Exibindo os 100 callbacks mais recentes de {audit.summary.total}
                .
              </p>
            ) : null}
            {audit.summary.recoverable > recoverableIds.length ? (
              <p className="action-note">
                Reprocesse em lotes de ate 50 callbacks. Depois de concluir o
                lote atual, atualize a auditoria para selecionar os proximos.
              </p>
            ) : null}
            <p className="action-note">
              Callbacks sem lead pago ficam recuperaveis por 24 horas. Depois
              permanecem apenas em Bloqueados ou Todos para consulta do
              historico.
            </p>
          </>
        ) : null}
      </div>

      <dialog
        className="event-audit-dialog provider-callback-payload-dialog"
        ref={payloadDialogRef}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className="event-audit-dialog-shell">
          <header className="event-audit-dialog-header">
            <div>
              <span className="micro-label">Auditoria do callback</span>
              <h3>Payload recebido do provedor</h3>
              <small>
                {payload
                  ? `Recebido em ${formatDateTime(payload.receivedAt)}`
                  : "Carregando payload"}
              </small>
            </div>
            <button
              className="meta-dialog-close"
              type="button"
              title="Fechar payload"
              aria-label="Fechar payload"
              onClick={() => payloadDialogRef.current?.close()}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </header>
          <div className="event-audit-dialog-body">
            {payload ? (
              <>
                <p className="action-note">
                  Payload criptografado em repouso e disponivel ate{" "}
                  {formatDateTime(payload.payloadExpiresAt)}.
                </p>
                <pre
                  className="payload-block provider-callback-raw-payload"
                  data-presentation-sensitive-field="true"
                >
                  {JSON.stringify(payload.payload, null, 2)}
                </pre>
              </>
            ) : null}
          </div>
        </div>
      </dialog>
    </details>
  );
}

function AuditMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "warn" | "info" | "success" | "accent";
}) {
  return (
    <div className={tone ? `tone-${tone}` : undefined}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AutomationCallbackRow({
  item,
  selected,
  busy,
  onSelect,
  onPayload,
  onReprocess,
}: {
  item: ProviderConversionAutomationAuditItemDto;
  selected: boolean;
  busy: boolean;
  onSelect: (checked: boolean) => void;
  onPayload: () => void;
  onReprocess: () => void;
}) {
  return (
    <div className="provider-callback-row" role="row">
      <span>
        {item.reprocessable ? (
          <input
            type="checkbox"
            checked={selected}
            aria-label={`Selecionar callback de ${formatDateTime(item.receivedAt)}`}
            onChange={(event) => onSelect(event.target.checked)}
          />
        ) : null}
      </span>
      <span className="provider-callback-time">
        <strong>{formatDateTime(item.receivedAt)}</strong>
        <small>{item.attemptCount} entrega(s)</small>
      </span>
      <span className="provider-callback-source">
        <strong>{automationEventLabel(item.eventName)}</strong>
        <small>{item.channel?.name ?? "Canal nao localizado"}</small>
        {item.channel ? (
          <PresentationMask placeholder="Numero oculto">
            {item.channel.connectedPhone}
          </PresentationMask>
        ) : null}
      </span>
      <span className="provider-callback-diagnosis">
        <span className={`event-chip ${automationAuditTone(item.status)}`}>
          {automationAuditStatusLabel(item.status)}
        </span>
        <strong>{executionReasonLabel(item.reasonCode)}</strong>
        <small>
          Lead pago: {item.leadResolved ? "localizado" : "nao localizado"}
        </small>
      </span>
      <span className="provider-callback-payload-state">
        <strong>{item.payloadAvailable ? "Disponivel" : "Indisponivel"}</strong>
        <small>Ate {formatDateTime(item.payloadExpiresAt)}</small>
      </span>
      <span className="provider-callback-row-actions">
        {item.payloadAvailable ? (
          <button
            className="icon-button"
            type="button"
            title="Ver payload"
            aria-label={`Ver payload de ${formatDateTime(item.receivedAt)}`}
            disabled={busy}
            onClick={onPayload}
          >
            <Eye size={15} aria-hidden="true" />
          </button>
        ) : null}
        {item.reprocessable ? (
          <button
            className="icon-button"
            type="button"
            title="Reprocessar este callback"
            aria-label={`Reprocessar callback de ${formatDateTime(item.receivedAt)}`}
            disabled={busy}
            onClick={onReprocess}
          >
            <RotateCcw size={15} aria-hidden="true" />
          </button>
        ) : null}
      </span>
    </div>
  );
}

type PurchaseAuditFilter = "actionable" | "sent" | "all";

function PurchaseRuleAudit({
  rule,
  loadAuditAction,
}: {
  rule: ProviderConversionRuleDto;
  loadAuditAction: ProviderRuleAction;
}) {
  const [audit, setAudit] = useState<PurchaseReviewListDto | null>(null);
  const [filter, setFilter] = useState<PurchaseAuditFilter>("actionable");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function loadAudit(showSuccess = false) {
    if (loading) return;
    const formData = new FormData();
    formData.set("ruleId", rule.id);
    setLoading(true);
    if (!showSuccess) setNotice(null);
    const result = await loadAuditAction(formData);
    if (result.ok && result.purchaseAudit) {
      setAudit(result.purchaseAudit);
      setNotice(
        showSuccess ? { tone: "success", message: result.message } : null,
      );
    } else {
      setNotice({ tone: "error", message: result.message });
    }
    setLoading(false);
  }

  const reviews = audit?.reviews ?? [];
  const actionableStatuses = new Set<PurchaseReviewDto["status"]>([
    "recognized",
    "awaiting_data",
    "review_required",
    "failed",
  ]);
  const visibleReviews = reviews.filter((review) => {
    if (filter === "actionable") return actionableStatuses.has(review.status);
    if (filter === "sent") {
      return ["approved", "sent", "corrected_after_send"].includes(
        review.status,
      );
    }
    return true;
  });
  const actionableCount = reviews.filter((review) =>
    actionableStatuses.has(review.status),
  ).length;
  const queuedCount = reviews.filter(
    (review) => review.status === "approved",
  ).length;
  const sentCount = reviews.filter((review) =>
    ["sent", "corrected_after_send"].includes(review.status),
  ).length;

  return (
    <details
      className="provider-callback-audit provider-purchase-audit"
      onToggle={(event) => {
        if (event.currentTarget.open && !audit && !loading) {
          void loadAudit();
        }
      }}
    >
      <summary>
        <span className="provider-callback-audit-heading">
          <ListChecks size={17} aria-hidden="true" />
          <span>
            <strong>Auditar compras reconhecidas</strong>
            <small>Diagnostico, valor e acesso a revisao desta regra</small>
          </span>
        </span>
        <span
          className={actionableCount > 0 ? "status-chip warn" : "status-chip"}
        >
          {audit ? `${actionableCount} para revisar` : "Abrir"}
        </span>
      </summary>

      <div className="provider-callback-audit-body">
        {notice ? (
          <div className={`inline-notice ${notice.tone}`}>{notice.message}</div>
        ) : null}

        {loading && !audit ? (
          <div className="provider-conversion-empty">
            <RefreshCw size={17} aria-hidden="true" />
            <span>Carregando compras reconhecidas...</span>
          </div>
        ) : audit ? (
          <>
            <div
              className="provider-callback-summary provider-purchase-summary"
              aria-label="Resumo das compras reconhecidas"
            >
              <AuditMetric
                label="Registradas"
                value={audit.pagination.totalItems}
              />
              <AuditMetric
                label="Para revisar"
                value={actionableCount}
                tone="warn"
              />
              <AuditMetric label="Na fila" value={queuedCount} tone="info" />
              <AuditMetric label="Enviadas" value={sentCount} tone="success" />
            </div>

            <div className="provider-callback-toolbar">
              <div
                className="provider-callback-filters"
                aria-label="Filtrar compras reconhecidas"
              >
                {(
                  [
                    ["actionable", "Para revisar"],
                    ["sent", "Na fila e enviadas"],
                    ["all", "Todas"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    className={filter === value ? "active" : undefined}
                    key={value}
                    type="button"
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="provider-callback-toolbar-actions">
                <button
                  className="button ghost compact-button"
                  type="button"
                  disabled={loading}
                  onClick={() => void loadAudit(true)}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  Atualizar
                </button>
                <Link
                  className="button primary compact-button"
                  href={`/events/purchase-reviews?providerRuleId=${encodeURIComponent(rule.id)}`}
                >
                  <Eye size={14} aria-hidden="true" />
                  Abrir central de revisao
                </Link>
              </div>
            </div>

            <div className="provider-purchase-table" role="table">
              <div
                className="provider-purchase-row provider-callback-row-head"
                role="row"
              >
                <span>Recebido</span>
                <span>Canal</span>
                <span>Diagnostico</span>
                <span>Compra</span>
                <span>Acao</span>
              </div>
              {visibleReviews.length > 0 ? (
                visibleReviews.map((review) => (
                  <PurchaseAuditRow key={review.id} review={review} />
                ))
              ) : (
                <div className="provider-callback-empty">
                  Nenhuma compra encontrada neste filtro.
                </div>
              )}
            </div>

            {audit.pagination.totalItems === 0 ? (
              <p className="action-note">
                Nenhuma mensagem desta regra foi reconhecida. Confira a frase
                gatilho, o autor permitido e os canais vinculados.
              </p>
            ) : null}
            {audit.pagination.totalItems > reviews.length ? (
              <p className="action-note">
                Exibindo as 50 compras mais recentes. A central de revisao
                possui o historico completo desta regra.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </details>
  );
}

function PurchaseAuditRow({ review }: { review: PurchaseReviewDto }) {
  const valueCents = review.effectiveValueCents ?? review.calculatedValueCents;

  return (
    <div className="provider-purchase-row" role="row">
      <span>
        <strong>{formatDateTime(review.occurredAt)}</strong>
        <small>
          {review.sourceType === "provider_message" ? "Mensagem" : "Automacao"}
        </small>
      </span>
      <span>
        <strong>{review.channelName ?? "Canal nao localizado"}</strong>
        <small>{review.matchedTriggerPhrase ?? "Sem frase identificada"}</small>
      </span>
      <span className="provider-callback-diagnosis">
        <span className={`event-chip ${purchaseReviewTone(review.status)}`}>
          {purchaseReviewStatusLabel(review.status)}
        </span>
        <small>{purchaseReviewReasonLabel(review.reasonCode)}</small>
      </span>
      <span>
        <strong>
          {valueCents
            ? formatMoney(valueCents, review.currency)
            : "Valor pendente"}
        </strong>
        <small>{review.items.length} item(ns) reconhecido(s)</small>
      </span>
      <span className="provider-callback-row-actions">
        <Link
          className="icon-button"
          href={`/events/purchase-reviews?providerRuleId=${encodeURIComponent(review.providerRuleId)}`}
          title="Abrir compra na central de revisao"
          aria-label={`Abrir compra de ${formatDateTime(review.occurredAt)} na central de revisao`}
        >
          <Eye size={15} aria-hidden="true" />
        </Link>
      </span>
    </div>
  );
}

type ExecutionAuditFilter =
  "all" | "observed" | "eligible" | "materialized" | "blocked" | "failed";

function ExecutionRuleAudit({
  rule,
  loadAuditAction,
}: {
  rule: ProviderConversionRuleDto;
  loadAuditAction: ProviderRuleAction;
}) {
  const [audit, setAudit] =
    useState<ProviderConversionRuleExecutionAuditDto | null>(null);
  const [filter, setFilter] = useState<ExecutionAuditFilter>("all");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function loadAudit(showSuccess = false) {
    if (loading) return;
    const formData = new FormData();
    formData.set("ruleId", rule.id);
    setLoading(true);
    if (!showSuccess) setNotice(null);
    const result = await loadAuditAction(formData);
    if (result.ok && result.executionAudit) {
      setAudit(result.executionAudit);
      setNotice(
        showSuccess ? { tone: "success", message: result.message } : null,
      );
    } else {
      setNotice({ tone: "error", message: result.message });
    }
    setLoading(false);
  }

  const visibleItems = (audit?.items ?? []).filter(
    (item) => filter === "all" || item.status === filter,
  );

  return (
    <details
      className="provider-callback-audit provider-purchase-audit"
      onToggle={(event) => {
        if (event.currentTarget.open && !audit && !loading) {
          void loadAudit();
        }
      }}
    >
      <summary>
        <span className="provider-callback-audit-heading">
          <ListChecks size={17} aria-hidden="true" />
          <span>
            <strong>Auditar execucoes reconhecidas</strong>
            <small>
              Diagnostico e status desta regra fora do fluxo de compra
            </small>
          </span>
        </span>
        <span className="status-chip">
          {audit ? `${audit.summary.total} registro(s)` : "Abrir"}
        </span>
      </summary>

      <div className="provider-callback-audit-body">
        {notice ? (
          <div className={`inline-notice ${notice.tone}`}>{notice.message}</div>
        ) : null}

        {loading && !audit ? (
          <div className="provider-conversion-empty">
            <RefreshCw size={17} aria-hidden="true" />
            <span>Carregando execucoes reconhecidas...</span>
          </div>
        ) : audit ? (
          <>
            <div
              className="provider-callback-summary provider-purchase-summary"
              aria-label="Resumo das execucoes reconhecidas"
            >
              <AuditMetric label="Total" value={audit.summary.total} />
              <AuditMetric label="Observados" value={audit.summary.observed} />
              <AuditMetric
                label="Elegiveis"
                value={audit.summary.eligible}
                tone="info"
              />
              <AuditMetric
                label="Eventos criados"
                value={audit.summary.materialized}
                tone="success"
              />
              <AuditMetric
                label="Duplicados"
                value={audit.summary.duplicate}
                tone="warn"
              />
              <AuditMetric
                label="Bloqueados"
                value={audit.summary.blocked}
                tone="warn"
              />
              <AuditMetric
                label="Falhas"
                value={audit.summary.failed}
                tone="warn"
              />
            </div>

            <div className="provider-callback-toolbar">
              <div
                className="provider-callback-filters"
                aria-label="Filtrar execucoes reconhecidas"
              >
                {(
                  [
                    ["all", "Todas"],
                    ["observed", "Observados"],
                    ["eligible", "Elegiveis"],
                    ["materialized", "Eventos criados"],
                    ["blocked", "Bloqueados"],
                    ["failed", "Falhas"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    className={filter === value ? "active" : undefined}
                    key={value}
                    type="button"
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="provider-callback-toolbar-actions">
                <button
                  className="button ghost compact-button"
                  type="button"
                  disabled={loading}
                  onClick={() => void loadAudit(true)}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  Atualizar
                </button>
              </div>
            </div>

            {audit.summary.total === 0 ? (
              <p className="action-note">
                Nenhuma execucao registrada para esta regra ainda.
              </p>
            ) : (
              <div className="provider-purchase-table" role="table">
                <div
                  className="provider-purchase-row provider-callback-row-head"
                  role="row"
                >
                  <span>Recebido</span>
                  <span>Canal</span>
                  <span>Diagnostico</span>
                  <span>Lead</span>
                  <span>Acao</span>
                </div>
                {visibleItems.length > 0 ? (
                  visibleItems.map((item) => (
                    <ExecutionAuditRow key={item.executionId} item={item} />
                  ))
                ) : (
                  <div className="provider-callback-empty">
                    Nenhuma execucao encontrada neste filtro.
                  </div>
                )}
              </div>
            )}
          </>
        ) : null}
      </div>
    </details>
  );
}

function ExecutionAuditRow({
  item,
}: {
  item: ProviderConversionRuleExecutionAuditItemDto;
}) {
  return (
    <div className="provider-purchase-row" role="row">
      <span>
        <strong>{formatDateTime(item.occurredAt)}</strong>
        <small>{item.attemptCount} tentativa(s)</small>
      </span>
      <span>
        <strong>
          {item.channel?.name ??
            item.channel?.connectedPhone ??
            "Canal nao localizado"}
        </strong>
        {item.channel ? (
          <small>
            <PresentationMask placeholder="Numero oculto">
              {item.channel.connectedPhone}
            </PresentationMask>
          </small>
        ) : null}
      </span>
      <span className="provider-callback-diagnosis">
        <span className={`event-chip ${executionAuditTone(item.status)}`}>
          {executionStatusLabel(item.status)}
        </span>
        <small>{executionReasonLabel(item.reasonCode)}</small>
      </span>
      <span>
        <strong>
          {item.leadName ?? item.phoneDisplay ?? "Lead nao localizado"}
        </strong>
        <small>
          {item.valueCents !== null && item.currency
            ? formatMoney(item.valueCents, item.currency)
            : (item.matchedTriggerPhrase ?? "Sem valor identificado")}
        </small>
      </span>
      <span className="provider-callback-row-actions">
        {item.leadId ? (
          <Link
            className="icon-button"
            href={`/leads/${encodeURIComponent(item.leadId)}`}
            title="Abrir lead"
            aria-label={`Abrir lead de ${formatDateTime(item.occurredAt)}`}
          >
            <Eye size={15} aria-hidden="true" />
          </Link>
        ) : null}
      </span>
    </div>
  );
}

function MessageRuleEditor({
  rule,
  canManage,
  updateAction,
  onResult,
}: {
  rule: ProviderConversionRuleDto;
  canManage: boolean;
  updateAction: ProviderRuleAction;
  onResult: (result: ProviderConversionRuleActionResult) => void;
}) {
  const router = useRouter();
  const [phrases, setPhrases] = useState(rule.triggerPhrases.join("\n"));
  const [authorScope, setAuthorScope] = useState<"team" | "contact" | "both">(
    rule.messageAuthorScope ?? "team",
  );
  const [pending, setPending] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const triggerPhrases = parseTriggerPhrases(phrases);
    if (triggerPhrases.length === 0) {
      onResult({
        ok: false,
        message: "Informe ao menos uma frase gatilho.",
      });
      return;
    }

    const formData = new FormData();
    formData.set("ruleId", rule.id);
    formData.set(
      "payload",
      JSON.stringify({ triggerPhrases, messageAuthorScope: authorScope }),
    );
    setPending(true);
    const result = await updateAction(formData);
    onResult(result);
    if (result.ok) router.refresh();
    setPending(false);
  }

  return (
    <details className="provider-conversion-rule-scope">
      <summary>
        <span>Reconhecimento da mensagem</span>
        <strong>{rule.triggerPhrases.length} frase(s)</strong>
      </summary>
      <form onSubmit={save}>
        <div className="provider-conversion-base-fields">
          <label>
            <span className="field-label">Frases gatilho</span>
            <textarea
              value={phrases}
              onChange={(event) => setPhrases(event.target.value)}
              rows={3}
              maxLength={4_800}
              readOnly={!canManage}
              required
            />
          </label>
          <label>
            <span className="field-label">Quem pode enviar</span>
            <select
              value={authorScope}
              disabled={!canManage}
              onChange={(event) =>
                setAuthorScope(
                  event.target.value as "team" | "contact" | "both",
                )
              }
            >
              <option value="team">Equipe ou bot</option>
              <option value="contact">Somente contato</option>
              <option value="both">Equipe, bot ou contato</option>
            </select>
          </label>
        </div>
        {canManage ? (
          <button className="button subtle" type="submit" disabled={pending}>
            <Check size={14} aria-hidden="true" />
            {pending ? "Salvando..." : "Salvar reconhecimento"}
          </button>
        ) : null}
      </form>
    </details>
  );
}

/**
 * Espelha o contrato aceito pelo parser da automacao da Umbler
 * (apps/api/src/inbound-webhooks/providers/umbler/umbler-automation-v1.parser.ts).
 * Mude os dois lados juntos se o schema mudar: o operador copia este JSON
 * literalmente para a automacao HTTP da Umbler.
 */
const UMBLER_AUTOMATION_V1_SCHEMA = "wpptrack.umbler.automation.v1";
const UMBLER_AUTOMATION_V1_SOURCE = "umbler_tag_automation";

export type UmblerAutomationKey = "lead_qualificado" | "compra_aprovada";

/** O parser da automacao so reconhece estes dois eventos. */
export function umblerAutomationKeyForEvent(
  eventName: ConversionEventNameDto,
): UmblerAutomationKey | null {
  if (eventName === "QualifiedLead") return "lead_qualificado";
  if (eventName === "Purchase") return "compra_aprovada";
  return null;
}

/** Referencia mais proxima quando o evento da regra nao mapeia para um automation valido. */
function umblerAutomationFallbackForEvent(
  eventName: ConversionEventNameDto,
): UmblerAutomationKey {
  return conversionEventCarriesValue(eventName)
    ? "compra_aprovada"
    : "lead_qualificado";
}

export function buildUmblerAutomationPayloadExample(
  automation: UmblerAutomationKey,
): Record<string, unknown> {
  return {
    schema: UMBLER_AUTOMATION_V1_SCHEMA,
    source: UMBLER_AUTOMATION_V1_SOURCE,
    automation,
    contact: { phone: "+55..." },
    conversation: {
      id: "CONVERSATION_ID",
      created_at_utc: "YYYY-MM-DD HH:mm:ss",
    },
  };
}

/**
 * Corpo JSON que a automacao HTTP da Umbler precisa enviar para o callback de
 * tag/automacao. Aparece logo apos criar (ou rotacionar) a URL de uso unico e
 * tambem no "Como configurar" de uma regra ja existente.
 */
export function UmblerAutomationPayloadPanel({
  eventName,
}: {
  eventName: ConversionEventNameDto;
}) {
  const automation = umblerAutomationKeyForEvent(eventName);
  const exampleAutomation =
    automation ?? umblerAutomationFallbackForEvent(eventName);
  const payloadJson = JSON.stringify(
    buildUmblerAutomationPayloadExample(exampleAutomation),
    null,
    2,
  );
  const [copied, setCopied] = useState(false);

  async function copyPayload() {
    try {
      await navigator.clipboard.writeText(payloadJson);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="provider-conversion-payload-helper">
      <div>
        <span className="micro-label">Corpo JSON da automacao</span>
        <strong>Configuracao HTTP na Umbler</strong>
      </div>
      {automation ? null : (
        <p className="action-note warn">
          O callback da Umbler so reconhece os eventos Lead qualificado
          (lead_qualificado) ou Compra aprovada (compra_aprovada). Troque o
          evento desta regra para um dos dois, ou use &quot;{exampleAutomation}
          &quot; como referencia mais proxima.
        </p>
      )}
      <pre className="payload-block" data-presentation-sensitive-field="true">
        {payloadJson}
      </pre>
      <button
        className="button subtle"
        type="button"
        onClick={() => void copyPayload()}
      >
        {copied ? (
          <Check size={14} aria-hidden="true" />
        ) : (
          <Copy size={14} aria-hidden="true" />
        )}
        {copied ? "Copiado" : "Copiar JSON"}
      </button>
      <ol className="provider-conversion-payload-steps">
        <li>
          Copie a URL da automacao e cole no campo de URL da acao HTTP na
          Umbler.
        </li>
        <li>
          Metodo POST; o token de acesso ja esta na URL, sem cabecalho extra.
        </li>
        <li>Cole o corpo JSON acima no campo de body da acao HTTP.</li>
        <li>
          Mapeie contact.phone, conversation.id e conversation.created_at_utc
          para os campos reais do contato e da conversa na automacao da Umbler.
        </li>
      </ol>
    </div>
  );
}

/** "Como configurar" para uma regra de automacao Umbler ja existente na lista. */
function UmblerAutomationSetupDetails({
  eventName,
}: {
  eventName: ConversionEventNameDto;
}) {
  return (
    <details className="provider-conversion-rule-scope">
      <summary>
        <span>Como configurar na Umbler</span>
        <strong>Corpo JSON da automacao</strong>
      </summary>
      <div className="provider-conversion-payload-helper-body">
        <p className="action-note">
          A URL secreta so aparece uma vez, na criacao da regra. Se perdeu, gere
          uma nova URL acima e repita a configuracao na automacao da Umbler.
        </p>
        <UmblerAutomationPayloadPanel eventName={eventName} />
      </div>
    </details>
  );
}

/**
 * Origem do gatilho e evento enviado a Meta, os dois eixos independentes da
 * regra. O catalogo estruturado e o unico caso preso a um evento (Purchase):
 * ele deriva o valor dos itens da mensagem e alimenta a fila de revisao.
 */
export function ConversionRuleOriginEventSelector({
  origin,
  eventName,
  onOriginChange,
  onEventChange,
}: {
  origin: ConversionRuleOrigin;
  eventName: ConversionEventNameDto;
  onOriginChange: (origin: ConversionRuleOrigin) => void;
  onEventChange: (eventName: ConversionEventNameDto) => void;
}) {
  const catalogOnly = origin === "catalog";
  const events = catalogOnly
    ? conversionEventCatalogOrdered.filter(
        (event) => event.eventName === catalogOriginEventName,
      )
    : conversionEventCatalogOrdered;
  const categories = [...new Set(events.map((event) => event.category))];

  return (
    <div className="provider-conversion-target">
      <div className="provider-conversion-target-selects">
        <label>
          <span className="field-label">Origem do gatilho</span>
          <select
            value={origin}
            onChange={(event) =>
              onOriginChange(event.target.value as ConversionRuleOrigin)
            }
          >
            {(
              Object.keys(conversionRuleOriginLabels) as ConversionRuleOrigin[]
            ).map((value) => (
              <option key={value} value={value}>
                {conversionRuleOriginLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">Evento enviado a Meta</span>
          <select
            value={eventName}
            disabled={catalogOnly}
            onChange={(event) =>
              onEventChange(event.target.value as ConversionEventNameDto)
            }
          >
            {categories.map((category) => (
              <optgroup
                key={category}
                label={conversionEventCategoryLabels[category]}
              >
                {events
                  .filter((event) => event.category === category)
                  .map((event) => (
                    <option key={event.eventName} value={event.eventName}>
                      {event.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>
      <ConversionEventHint eventName={eventName} />
    </div>
  );
}

function ConversionEventHint({
  eventName,
}: {
  eventName: ConversionEventNameDto;
}) {
  const event = conversionEventMetadata(eventName);

  return (
    <div className="provider-conversion-event-hint">
      <span className="micro-label">{event.label}</span>
      <small>{event.description}</small>
    </div>
  );
}

/**
 * Trigger phrases, example message and value pipeline of a message_phrase rule.
 * The preview mirrors the server heuristics: contains match on the normalized
 * phrase and a single distinct money value in the message.
 */
export function MessagePhraseFields({
  eventName,
  averageValue,
  contentName,
  primaryPhrase,
  variationPhrases,
  exampleMessage,
  valueMode,
  messageAuthorScope,
  onChange,
}: MessagePhraseValues & {
  eventName: ConversionEventNameDto;
  onChange: (patch: Partial<MessagePhraseValues>) => void;
}) {
  const carriesValue = conversionEventCarriesValue(eventName);
  const extracting = carriesValue && valueMode === "message_extracted";
  const preview = previewMessagePhrase({
    triggerPhrases: mergeTriggerPhrases(primaryPhrase, variationPhrases),
    exampleMessage,
    valueMode: extracting ? "message_extracted" : "fixed",
    averageValue,
  });

  return (
    <div className="provider-conversion-message-fields">
      <label>
        <span className="field-label">Frase principal</span>
        <input
          value={primaryPhrase}
          onChange={(event) => onChange({ primaryPhrase: event.target.value })}
          maxLength={2_400}
          placeholder="Ex.: A sua consulta esta agendada"
          required
        />
      </label>
      <label>
        <span className="field-label">Variacoes (opcional)</span>
        <textarea
          value={variationPhrases}
          onChange={(event) =>
            onChange({ variationPhrases: event.target.value })
          }
          rows={3}
          maxLength={4_800}
          placeholder={
            "Uma por linha. Ex.: consulta confirmada\nestou confirmando sua consulta"
          }
        />
        <small className="action-note">
          Secretarias nem sempre usam a mesma frase. Cadastre variacoes comuns.
        </small>
      </label>

      <div className="provider-conversion-base-fields provider-conversion-base-fields-2col">
        <label>
          <span className="field-label">Exemplo da mensagem</span>
          <textarea
            value={exampleMessage}
            onChange={(event) =>
              onChange({ exampleMessage: event.target.value })
            }
            rows={3}
            maxLength={2_000}
            placeholder={
              carriesValue
                ? "Ex.: Pagamento confirmado no valor de R$ 1.397,00"
                : "Ex.: Perfeito! Vou te passar os valores agora."
            }
          />
        </label>
        <label>
          <span className="field-label">Quem pode enviar</span>
          <select
            value={messageAuthorScope}
            onChange={(event) =>
              onChange({
                messageAuthorScope: event.target.value as MessageAuthorScope,
              })
            }
          >
            <option value="team">Equipe ou bot</option>
            <option value="contact">Somente contato</option>
            <option value="both">Equipe, bot ou contato</option>
          </select>
        </label>
      </div>

      {carriesValue ? (
        <>
          <fieldset className="provider-conversion-value-modes">
            <legend className="field-label">Modo de valor</legend>
            <div>
              <label>
                <input
                  type="radio"
                  name="messagePhraseValueMode"
                  value="fixed"
                  checked={!extracting}
                  onChange={() => onChange({ valueMode: "fixed" })}
                />
                <span>Valor fixo</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="messagePhraseValueMode"
                  value="message_extracted"
                  checked={extracting}
                  onChange={() => onChange({ valueMode: "message_extracted" })}
                />
                <span>Extrair da mensagem</span>
              </label>
            </div>
          </fieldset>

          <div className="provider-conversion-base-fields provider-conversion-base-fields-2col">
            <label>
              <span className="field-label">
                {averageValueLabel(eventName, extracting)}
              </span>
              <input
                value={averageValue}
                onChange={(event) =>
                  onChange({ averageValue: event.target.value })
                }
                inputMode="decimal"
                placeholder="Ex.: 250,00"
                required={
                  !extracting && conversionEventRequiresValue(eventName)
                }
              />
            </label>
            <label>
              <span className="field-label">Produto (opcional)</span>
              <input
                value={contentName}
                onChange={(event) =>
                  onChange({ contentName: event.target.value })
                }
                maxLength={180}
                placeholder="Ex.: Consulta"
              />
            </label>
          </div>
        </>
      ) : null}

      <div className="provider-conversion-preview">
        <span className="micro-label">Previa do reconhecimento</span>
        <strong>
          {preview.matchedPhrase
            ? `Frase gatilho reconhecida: ${preview.matchedPhrase}`
            : exampleMessage.trim()
              ? "Nenhuma frase gatilho encontrada no exemplo."
              : "Escreva um exemplo para conferir o reconhecimento."}
        </strong>
        <small>
          {carriesValue
            ? previewValueLabel(preview, extracting, eventName)
            : "Este evento nao envia valor monetario."}
        </small>
      </div>
    </div>
  );
}

function averageValueLabel(
  eventName: ConversionEventNameDto,
  extracting: boolean,
): string {
  if (extracting) return "Valor medio (fallback, opcional)";

  return conversionEventRequiresValue(eventName)
    ? "Valor medio (R$)"
    : "Valor medio (opcional)";
}

function previewValueLabel(
  preview: MessagePhrasePreview,
  extracting: boolean,
  eventName: ConversionEventNameDto,
): string {
  if (preview.ambiguousValue) {
    return "O exemplo tem mais de um valor. A regra vai pedir revisao manual.";
  }
  if (preview.valueCents === null) {
    if (extracting) {
      return conversionEventRequiresValue(eventName)
        ? "Nenhum valor no exemplo e sem valor medio de fallback: a conversao ficaria em revisao."
        : "Nenhum valor no exemplo. Este evento pode ser enviado sem valor.";
    }

    return conversionEventRequiresValue(eventName)
      ? "Informe o valor medio enviado por esta regra."
      : "Sem valor medio: este evento seria enviado sem valor.";
  }

  const money = formatMoney(preview.valueCents, "BRL");
  if (preview.valueSource === "message") {
    return `Valor extraido do exemplo: ${money}`;
  }
  if (preview.valueSource === "fallback") {
    return `Sem valor no exemplo. Seria enviado o valor medio: ${money}`;
  }

  return `Valor fixo enviado em toda conversao: ${money}`;
}

function ChannelSelector({
  channels,
  selectedChannelIds,
  onToggle,
}: {
  channels: InboundWebhookChannelDto[];
  selectedChannelIds: string[];
  onToggle: (channelId: string) => void;
}) {
  return (
    <fieldset className="provider-conversion-channels">
      <legend className="field-label">Canais desta regra</legend>
      <div>
        {channels.map((channel) => (
          <label key={channel.id}>
            <input
              type="checkbox"
              checked={selectedChannelIds.includes(channel.id)}
              onChange={() => onToggle(channel.id)}
            />
            <span>
              <PresentationMask placeholder="Canal oculto">
                {channel.channelName ?? channel.connectedPhone}
              </PresentationMask>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function RuleChannelEditor({
  rule,
  channels,
  canManage,
  updateAction,
  onResult,
}: {
  rule: ProviderConversionRuleDto;
  channels: InboundWebhookChannelDto[];
  canManage: boolean;
  updateAction: ProviderRuleAction;
  onResult: (result: ProviderConversionRuleActionResult) => void;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState(rule.channelIds);
  const [pending, setPending] = useState(false);

  async function saveChannels(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || selected.length === 0) return;

    const formData = new FormData();
    formData.set("ruleId", rule.id);
    formData.set("payload", JSON.stringify({ channelIds: selected }));
    setPending(true);
    const result = await updateAction(formData);
    onResult(result);
    if (result.ok) router.refresh();
    setPending(false);
  }

  return (
    <details className="provider-conversion-rule-scope">
      <summary>
        <span>Canais vinculados</span>
        <strong>{rule.channelIds.length}</strong>
      </summary>
      <form onSubmit={saveChannels}>
        <div className="provider-conversion-scope-options">
          {channels.map((channel) => (
            <label key={channel.id}>
              <input
                type="checkbox"
                checked={selected.includes(channel.id)}
                disabled={!canManage || pending}
                onChange={() =>
                  setSelected((current) =>
                    current.includes(channel.id)
                      ? current.filter((id) => id !== channel.id)
                      : [...current, channel.id],
                  )
                }
              />
              <span>
                <PresentationMask placeholder="Canal oculto">
                  {channel.channelName ?? channel.connectedPhone}
                </PresentationMask>
              </span>
            </label>
          ))}
        </div>
        {canManage ? (
          <button
            className="button subtle"
            type="submit"
            disabled={pending || selected.length === 0}
          >
            <Check size={14} aria-hidden="true" />
            {pending ? "Salvando..." : "Salvar canais"}
          </button>
        ) : null}
      </form>
    </details>
  );
}

function CatalogRuleDetails({
  rule,
  canManage,
  updateAction,
  testMessageAction,
  onResult,
}: {
  rule: ProviderConversionRuleDto;
  canManage: boolean;
  updateAction: ProviderRuleAction;
  testMessageAction: ProviderRuleAction;
  onResult: (result: ProviderConversionRuleActionResult) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [editingAliases, setEditingAliases] = useState(false);
  const [aliasDrafts, setAliasDrafts] = useState<Record<string, string[]>>(() =>
    catalogAliasDrafts(rule.catalog),
  );
  const [error, setError] = useState<string | null>(null);
  const catalog = rule.catalog;

  if (!catalog) return null;
  const editableCatalog = catalog;

  async function handleAliasSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const formData = new FormData();
    formData.set("ruleId", rule.id);
    formData.set(
      "payload",
      JSON.stringify({
        catalog: {
          name: editableCatalog.name,
          productName: editableCatalog.productName,
          currency: editableCatalog.currency,
          attributes: editableCatalog.attributes.map((attribute) => ({
            key: attribute.key,
            label: attribute.label,
          })),
          variants: editableCatalog.variants.map((variant) => ({
            attributeValues: variant.attributeValues,
            aliases: editableCatalog.attributes.map((_, attributeIndex) =>
              splitAliases(aliasDrafts[variant.id]?.[attributeIndex] ?? ""),
            ),
            valueCents: variant.valueCents,
            contentName: variant.contentName,
          })),
        },
      }),
    );

    setPending(true);
    setError(null);
    const response = await updateAction(formData);
    onResult(response);
    if (response.ok) {
      setEditingAliases(false);
      router.refresh();
    } else {
      setError(response.message);
    }
    setPending(false);
  }

  function resetAliases() {
    setAliasDrafts(catalogAliasDrafts(editableCatalog));
    setEditingAliases(false);
    setError(null);
  }

  return (
    <details className="provider-catalog-details">
      <summary>
        <span>{catalog.name}</span>
        <strong>{catalog.variants.length} variante(s)</strong>
      </summary>
      <div className="provider-catalog-details-body">
        {canManage ? (
          <div className="provider-catalog-alias-heading">
            <div>
              <span className="micro-label">Reconhecimento de escrita</span>
              <span className="muted">
                Cadastre sinonimos sem alterar combinacoes ou precos.
              </span>
            </div>
            {!editingAliases ? (
              <button
                className="button subtle"
                type="button"
                onClick={() => setEditingAliases(true)}
              >
                <Pencil size={14} aria-hidden="true" />
                Editar aliases
              </button>
            ) : null}
          </div>
        ) : null}

        {editingAliases ? (
          <form
            className="provider-catalog-alias-editor"
            onSubmit={handleAliasSave}
          >
            <div className="provider-catalog-alias-list">
              {catalog.variants.map((variant) => (
                <div
                  className={`provider-catalog-alias-row attributes-${catalog.attributes.length}`}
                  key={variant.id}
                >
                  <strong>{variant.attributeValues.join(" / ")}</strong>
                  {catalog.attributes.map((attribute, attributeIndex) => (
                    <label key={attribute.id}>
                      <span className="field-label">
                        Alias de {attribute.label}
                      </span>
                      <input
                        value={aliasDrafts[variant.id]?.[attributeIndex] ?? ""}
                        onChange={(event) =>
                          setAliasDrafts((current) => ({
                            ...current,
                            [variant.id]: replaceAt(
                              current[variant.id] ?? [],
                              attributeIndex,
                              event.target.value,
                            ),
                          }))
                        }
                        placeholder="Opcional, separado por virgulas"
                      />
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <span className="action-note">
              Os aliases preservam combinacoes, precos e todo o historico da
              regra.
            </span>
            <div className="provider-catalog-alias-actions">
              <button
                className="button subtle"
                type="button"
                disabled={pending}
                onClick={resetAliases}
              >
                <X size={14} aria-hidden="true" />
                Cancelar
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={pending}
              >
                <Check size={14} aria-hidden="true" />
                {pending ? "Salvando..." : "Salvar aliases"}
              </button>
            </div>
          </form>
        ) : null}

        <div className="provider-catalog-table" role="table">
          <div
            className={`provider-catalog-table-row heading attributes-${catalog.attributes.length}`}
            role="row"
          >
            {catalog.attributes.map((attribute) => (
              <span key={attribute.id}>{attribute.label}</span>
            ))}
            <span>Valor</span>
            <span>Evento</span>
          </div>
          {catalog.variants.map((variant) => (
            <div
              className={`provider-catalog-table-row attributes-${catalog.attributes.length}`}
              role="row"
              key={variant.id}
            >
              {variant.attributeValues.map((value, index) => (
                <strong
                  key={`${variant.id}-${catalog.attributes[index]?.id ?? index}`}
                >
                  {value}
                </strong>
              ))}
              <strong>
                {formatMoney(variant.valueCents, catalog.currency)}
              </strong>
              <span>{variant.contentName ?? catalog.productName}</span>
            </div>
          ))}
        </div>

        <ProviderCatalogTestConsole
          ruleId={rule.id}
          testMessageAction={testMessageAction}
        />
      </div>
    </details>
  );
}

function catalogAliasDrafts(
  catalog: ProviderConversionRuleDto["catalog"],
): Record<string, string[]> {
  if (!catalog) return {};

  return Object.fromEntries(
    catalog.variants.map((variant) => [
      variant.id,
      catalog.attributes.map((_, index) =>
        (variant.aliases[index] ?? []).join(", "),
      ),
    ]),
  );
}

export function buildCreatePayload(input: {
  connectionId: string;
  origin: ConversionRuleOrigin;
  eventName: ConversionEventNameDto;
  name: string;
  selectedChannelIds: string[];
  averageValue: string;
  contentName: string;
  triggerPhrases: string;
  triggerLabels?: UazapiTriggerLabel[];
  exampleMessage: string;
  valueMode: MessagePhraseValueMode;
  messageAuthorScope: MessageAuthorScope;
  catalogName: string;
  productName: string;
  attributes: CatalogAttributeDraft[];
  variants: CatalogVariantDraft[];
}): { ok: true; value: unknown } | { ok: false; message: string } {
  const name = input.name.trim();
  if (name.length < 2) {
    return { ok: false, message: "Informe um nome para a regra." };
  }
  if (input.selectedChannelIds.length === 0) {
    return { ok: false, message: "Selecione ao menos um canal." };
  }

  const base = {
    name,
    connectionId: input.connectionId,
    channelIds: input.selectedChannelIds,
    mode: "observation" as const,
  };

  const carriesValue = conversionEventCarriesValue(input.eventName);

  if (input.origin === "tag") {
    const selectedLabels = (input.triggerLabels ?? [])
      .map((label) => ({
        id: label.id.trim(),
        name: label.name.trim(),
      }))
      .filter((label) => label.id.length > 0 && label.name.length > 0);
    const triggerPhrases =
      selectedLabels.length > 0
        ? selectedLabels.map((label) => label.name)
        : parseTriggerPhrases(input.triggerPhrases);
    if (triggerPhrases.length === 0) {
      return {
        ok: false,
        message: "Selecione ou informe ao menos uma etiqueta para a regra.",
      };
    }
    const automation = {
      ...base,
      triggerType: "provider_automation",
      eventName: input.eventName,
      triggerPhrases,
      ...(selectedLabels.length > 0 ? { triggerLabels: selectedLabels } : {}),
    };
    if (!carriesValue) return { ok: true, value: automation };

    const valueFields = buildEventValueFields(input, false);
    if (!valueFields.ok) return valueFields;

    return { ok: true, value: { ...automation, ...valueFields.value } };
  }

  if (input.origin === "message") {
    const extracting = carriesValue && input.valueMode === "message_extracted";
    const valueFields = carriesValue
      ? buildEventValueFields(input, extracting)
      : ({ ok: true, value: {} } as const);
    if (!valueFields.ok) return valueFields;

    const messagePhrases = parseTriggerPhrases(input.triggerPhrases);
    if (messagePhrases.length === 0) {
      return {
        ok: false,
        message: `Informe ao menos uma frase gatilho para reconhecer o evento ${conversionEventBuilderLabel(input.eventName)}.`,
      };
    }

    return {
      ok: true,
      value: {
        ...base,
        triggerType: "message_phrase",
        eventName: input.eventName,
        // Evento sem valor recusa "message_extracted" no contrato compartilhado.
        valueMode: extracting ? "message_extracted" : "fixed",
        exampleMessage: input.exampleMessage.trim() || null,
        ...valueFields.value,
        triggerPhrases: messagePhrases,
        messageAuthorScope: input.messageAuthorScope,
      },
    };
  }

  const triggerPhrases = parseTriggerPhrases(input.triggerPhrases);
  if (triggerPhrases.length === 0) {
    return {
      ok: false,
      message: "Informe ao menos uma frase gatilho para reconhecer a compra.",
    };
  }

  const labels = input.attributes.map((attribute) => attribute.label.trim());
  if (labels.some((label) => !label)) {
    return { ok: false, message: "Preencha o nome de todos os atributos." };
  }
  const keys = labels.map((label, index) => catalogAttributeKey(label, index));
  if (new Set(keys).size !== keys.length) {
    return {
      ok: false,
      message: "Os atributos precisam ter nomes diferentes.",
    };
  }

  const variants = input.variants.map((variant) => ({
    attributeValues: variant.values.map((value) => value.trim()),
    aliases: variant.aliases.map((aliases) => splitAliases(aliases)),
    valueCents: parseMoneyToCents(variant.value),
    contentName: variant.contentName.trim() || null,
  }));
  if (
    variants.some(
      (variant) =>
        variant.attributeValues.some((value) => !value) || !variant.valueCents,
    )
  ) {
    return {
      ok: false,
      message: "Preencha os atributos e o valor de todas as variantes.",
    };
  }
  if (!input.catalogName.trim() || !input.productName.trim()) {
    return {
      ok: false,
      message: "Informe o nome do catalogo e do produto principal.",
    };
  }

  return {
    ok: true,
    value: {
      ...base,
      triggerType: "structured_catalog",
      eventName: catalogOriginEventName,
      triggerPhrases,
      messageAuthorScope: input.messageAuthorScope,
      catalog: {
        name: input.catalogName.trim(),
        productName: input.productName.trim(),
        currency: "BRL",
        attributes: labels.map((label, index) => ({
          key: keys[index],
          label,
        })),
        variants,
      },
    },
  };
}

/**
 * Campos monetarios de um evento que carrega valor. Eventos "required"
 * (Purchase, InitiateCheckout) exigem valor medio quando o modo e fixo;
 * "optional" aceita a ausencia, mas nunca um valor invalido.
 */
function buildEventValueFields(
  input: {
    eventName: ConversionEventNameDto;
    averageValue: string;
    contentName: string;
  },
  extracting: boolean,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string } {
  const defaultValueCents = parseMoneyToCents(input.averageValue);
  const required = !extracting && conversionEventRequiresValue(input.eventName);
  if (!defaultValueCents && (required || input.averageValue.trim())) {
    return { ok: false, message: "Informe um valor medio valido." };
  }

  return {
    ok: true,
    value: {
      defaultValueCents,
      defaultCurrency: "BRL",
      defaultContentName: input.contentName.trim() || null,
    },
  };
}

/**
 * Client-side rehearsal of the server decision for message_phrase rules:
 * normalized "contains" match of the trigger phrases plus the money value of
 * the example. Values only count when the example carries a single amount, the
 * same guard the parser applies before trusting a message value.
 */
export function previewMessagePhrase(input: {
  triggerPhrases: string;
  exampleMessage: string;
  valueMode: MessagePhraseValueMode;
  averageValue: string;
}): MessagePhrasePreview {
  const example = input.exampleMessage.trim();
  const matchedPhrase = matchTriggerPhrase(
    example,
    parseTriggerPhrases(input.triggerPhrases),
  );
  const fallbackCents = parseMoneyToCents(input.averageValue);

  if (input.valueMode === "fixed") {
    return {
      matchedPhrase,
      valueCents: fallbackCents,
      valueSource: fallbackCents === null ? null : "fixed",
      ambiguousValue: false,
    };
  }

  const values = messageMoneyValues(example);
  if (values.length > 1) {
    return {
      matchedPhrase,
      valueCents: null,
      valueSource: null,
      ambiguousValue: true,
    };
  }

  const extracted = values[0] ?? null;
  const valueCents = extracted ?? fallbackCents;
  return {
    matchedPhrase,
    valueCents,
    valueSource:
      valueCents === null ? null : extracted === null ? "fallback" : "message",
    ambiguousValue: false,
  };
}

function normalizeMessageText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ");
}

function matchTriggerPhrase(
  message: string,
  triggerPhrases: string[],
): string | null {
  if (!message) return null;

  const normalizedMessage = normalizeMessageText(message);
  return (
    triggerPhrases.find((phrase) => {
      const normalizedPhrase = normalizeMessageText(phrase);
      return (
        normalizedPhrase.length > 0 &&
        normalizedMessage.includes(normalizedPhrase)
      );
    }) ?? null
  );
}

const messageMoneyPattern =
  /(?:^|[^\d])((?:R\$\s*)?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}|(?:US\$\s*|\$\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?=$|[^\d])/giu;

/** Distinct money values of a message, in cents. Mirrors the server parser. */
function messageMoneyValues(message: string): number[] {
  const values = new Set<number>();
  for (const match of message.matchAll(messageMoneyPattern)) {
    const cents = parseMessageMoneyToken(match[1]);
    if (cents !== null) values.add(cents);
  }

  return [...values];
}

function parseMessageMoneyToken(token: string): number | null {
  const normalized = token.replace(/R\$|US\$|\$/giu, "").replace(/\s+/g, "");
  const decimalSeparator =
    normalized.lastIndexOf(",") > normalized.lastIndexOf(".") ? "," : ".";
  const [wholePart, decimalPart] = normalized.split(decimalSeparator);
  if (!wholePart || !/^\d{2}$/u.test(decimalPart ?? "")) return null;

  const wholeDigits = wholePart.replace(/[.,]/g, "");
  if (!/^\d+$/u.test(wholeDigits)) return null;

  const cents = Number(wholeDigits) * 100 + Number(decimalPart);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/**
 * First selected channel bridged to a WhatsApp instance, in selection order.
 * UAZAPI channels carry this id; other providers (Umbler, Gupshup) leave it
 * null, which keeps the free-text trigger phrases textarea instead of the
 * live label picker.
 */
function resolveUazapiWhatsappInstanceId(
  channels: InboundWebhookChannelDto[],
  selectedChannelIds: string[],
): string | null {
  for (const channelId of selectedChannelIds) {
    const channel = channels.find((item) => item.id === channelId);
    if (channel?.whatsappInstanceId) return channel.whatsappInstanceId;
  }

  return null;
}

function parseTriggerPhrases(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((phrase) => phrase.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Combines the primary phrase and the "one per line" variations into the
 * single newline-separated string the rest of the pipeline expects.
 * Deduping, trimming and dropping empties happens downstream in
 * parseTriggerPhrases, which every caller of this string already runs.
 */
export function mergeTriggerPhrases(
  primaryPhrase: string,
  variationPhrases: string,
): string {
  return [primaryPhrase, variationPhrases]
    .filter((part) => part.trim())
    .join("\n");
}

function emptyVariant(id: number, attributeCount: number): CatalogVariantDraft {
  return {
    id,
    values: Array.from({ length: attributeCount }, () => ""),
    aliases: Array.from({ length: attributeCount }, () => ""),
    value: "",
    contentName: "",
  };
}

function replaceAt(values: string[], index: number, value: string): string[] {
  return values.map((current, item) => (item === index ? value : current));
}

function splitAliases(value: string): string[] {
  return value
    .split(",")
    .map((alias) => alias.trim())
    .filter(Boolean);
}

function catalogAttributeKey(label: string, index: number): string {
  const normalized = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);

  return /^[a-z]/.test(normalized) ? normalized : `atributo_${index + 1}`;
}

export function parseMoneyToCents(value: string): number | null {
  let normalized = value.trim().replace(/R\$/gi, "").replace(/\s/g, "");
  if (!normalized) return null;

  if (normalized.includes(",")) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else {
    const parts = normalized.split(".");
    if (parts.length > 2) {
      const decimal = parts.pop();
      normalized = `${parts.join("")}.${decimal}`;
    }
  }

  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function eventLabel(rule: ProviderConversionRuleDto): string {
  return conversionEventBuilderLabel(rule.conversionRule.eventName);
}

function triggerLabel(rule: ProviderConversionRuleDto): string {
  if (rule.conversionRule.triggerType === "structured_catalog") {
    return "Mensagem com catalogo";
  }
  if (rule.conversionRule.triggerType === "message_phrase") {
    return "Mensagem com frase gatilho";
  }
  return "Automacao por tag";
}

function valueModeLabel(rule: ProviderConversionRuleDto): string {
  return rule.valueMode === "message_extracted"
    ? "Valor na mensagem"
    : "Valor fixo";
}

function executionStatusLabel(
  status: NonNullable<ProviderConversionRuleDto["lastExecution"]>["status"],
): string {
  const labels = {
    observed: "Observado",
    eligible: "Pronto para envio",
    materialized: "Evento criado",
    duplicate: "Duplicado",
    blocked: "Bloqueado",
    failed: "Falhou",
  } satisfies Record<
    NonNullable<ProviderConversionRuleDto["lastExecution"]>["status"],
    string
  >;

  return labels[status];
}

function automationEventLabel(
  eventName: ProviderConversionAutomationAuditItemDto["eventName"],
): string {
  return eventName
    ? conversionEventBuilderLabel(eventName)
    : "Evento nao identificado";
}

function automationAuditStatusLabel(
  status: ProviderConversionAutomationAuditItemDto["status"],
): string {
  const labels = {
    observed: "Observado",
    eligible: "Na fila",
    materialized: "Evento criado",
    duplicate: "Duplicado",
    blocked: "Bloqueado",
    failed: "Falhou",
    ignored: "Ignorado",
    invalid_payload: "Payload invalido",
  } satisfies Record<
    ProviderConversionAutomationAuditItemDto["status"],
    string
  >;

  return labels[status];
}

function automationAuditTone(
  status: ProviderConversionAutomationAuditItemDto["status"],
): "" | "warn" | "bad" | "neutral" {
  if (status === "materialized") return "";
  if (status === "observed" || status === "eligible" || status === "ignored") {
    return "neutral";
  }
  if (status === "blocked" || status === "duplicate") return "warn";
  return "bad";
}

function executionAuditTone(
  status: ProviderConversionRuleExecutionAuditItemDto["status"],
): "" | "warn" | "bad" | "neutral" {
  if (status === "materialized") return "";
  if (status === "observed" || status === "eligible") return "neutral";
  if (status === "duplicate" || status === "blocked") return "warn";
  return "bad";
}

function formatMoney(valueCents: number, currency: string): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency,
  }).format(valueCents / 100);
}

function formatDateTime(value: string | null): string {
  if (!value) return "Ainda nao recebido";

  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  });
}
