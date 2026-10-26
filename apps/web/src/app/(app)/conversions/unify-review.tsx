"use client";

import type { ProviderConversionRuleUnifyCandidateDto } from "@wpptrack/shared";
import { Combine } from "lucide-react";
import { useState } from "react";
import { Modal } from "../../../components/modal";
import { PresentationMask } from "../../../components/presentation-mask";
import { ruleEventLabel } from "./event-copy";
import type { ConversionScreenActionResult } from "./actions";
import {
  automationPlatformIn,
  automationPlatformOf,
  ruleOriginDefinition,
} from "./conversion-origins";
import { observationCanonicalWarning } from "./conversion-rules-view";
import type { ConversionNumber } from "./conversion-rules-view";

type UnifyAction = (formData: FormData) => Promise<ConversionScreenActionResult>;

/** Umbler/Unnichat automations: per-connection rules fold per provider + event. */
export function isAutomationUnifyGroup(
  group: Pick<ProviderConversionRuleUnifyCandidateDto, "origin">,
): boolean {
  return (
    group.origin === "automation_unnichat" || group.origin === "automation_umbler"
  );
}

/** Platform of an automation group, for the copy. */
function automationPlatform(
  group: Pick<ProviderConversionRuleUnifyCandidateDto, "origin">,
): string {
  return automationPlatformOf(group.origin);
}

/** Short count shown in the banner ("3 cópias", "2 regras por conexão"). */
export function unifyGroupCountLabel(
  group: Pick<ProviderConversionRuleUnifyCandidateDto, "origin" | "ruleIds">,
): string {
  const count = group.ruleIds.length;
  if (isAutomationUnifyGroup(group)) {
    return count === 1 ? "1 regra por conexão" : `${count} regras por conexão`;
  }
  return `${count} cópias`;
}

/** Banner title: automations speak of connections, the others of numbers. */
export function unifyBannerTitle(
  groups: ReadonlyArray<Pick<ProviderConversionRuleUnifyCandidateDto, "origin">>,
): string {
  if (groups.length > 0 && groups.every(isAutomationUnifyGroup)) {
    const platforms = [...new Set(groups.map(automationPlatform))];
    const where =
      platforms.length === 1
        ? `várias conexões ${platforms[0]}`
        : "várias conexões";
    return groups.length === 1
      ? `Há regras iguais em ${where}`
      : `Há ${groups.length} eventos com regras iguais em ${where}`;
  }
  return groups.length === 1
    ? "Há uma regra repetida em vários números"
    : `Há ${groups.length} regras repetidas em vários números`;
}

const differenceLabels: Record<string, string> = {
  mode: "modo (observação/envio automático)",
  value: "valor",
  currency: "moeda",
  contentName: "produto",
};

/** "valor e modo" for the differences of a group. */
export function unifyDifferencesLabel(differences: readonly string[]): string {
  const labels = differences.map((key) => differenceLabels[key] ?? key);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} e ${labels[labels.length - 1]}`;
}

function formatMemberValue(member: {
  defaultValueCents: number | null;
  defaultCurrency: string | null;
}): string {
  if (member.defaultValueCents === null) return "sem valor";
  return (member.defaultValueCents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: member.defaultCurrency ?? "BRL",
  });
}

/** What "Unificar" does to the group, in one sentence. */
export function unifyGroupDescription(
  group: Pick<
    ProviderConversionRuleUnifyCandidateDto,
    "origin" | "ruleIds" | "name" | "existingGlobalRuleId"
  >,
): string {
  if (isAutomationUnifyGroup(group)) {
    return `As regras “${group.name}” de cada conexão viram uma regra para todos os números ${automationPlatformOf(group.origin)}, de todas as conexões. As URLs antigas continuam funcionando e passam a entregar nesta regra, então você não precisa mudar nada ${automationPlatformIn(group.origin)} agora.`;
  }
  return `${group.ruleIds.length} regras “${group.name}” viram uma regra para todos os números.`;
}

/** "3 regras iguais em 3 números" banner with one review button per group. */
export function UnifyBanner({
  groups,
  canManage,
  onReview,
}: {
  groups: ProviderConversionRuleUnifyCandidateDto[];
  canManage: boolean;
  onReview: (group: ProviderConversionRuleUnifyCandidateDto) => void;
}) {
  if (groups.length === 0) return null;

  return (
    <section
      className="conversion-unify-banner"
      aria-labelledby="conversion-unify-title"
    >
      <span className="conversion-unify-icon" aria-hidden="true">
        <Combine size={20} />
      </span>
      <div className="conversion-unify-copy">
        <h2 id="conversion-unify-title">
          {unifyBannerTitle(groups)}
        </h2>
        <p>
          Você pode trocar as cópias por uma regra só, que vale para todos os
          números. Nada muda até você revisar e confirmar.
        </p>
      </div>
      <ul className="conversion-unify-groups" role="list">
        {groups.map((group) => (
          <li key={group.key}>
            <span>
              <strong>{group.name}</strong>
              <small>
                {ruleOriginDefinition(group.origin).label} ·{" "}
                {ruleEventLabel(group.eventName)} ·{" "}
                {unifyGroupCountLabel(group)}
              </small>
            </span>
            {canManage ? (
              <button
                className="button"
                type="button"
                onClick={() => onReview(group)}
                aria-haspopup="dialog"
              >
                Revisar e unificar
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function NumberList({
  ids,
  numbersById,
}: {
  ids: readonly string[];
  numbersById: ReadonlyMap<string, ConversionNumber>;
}) {
  return (
    <ul className="conversion-number-chips" role="list">
      {ids.map((id) => {
        const number = numbersById.get(id);
        return (
          <li key={id}>
            <PresentationMask placeholder="Número oculto">
              {number?.label ?? "Número removido"}
            </PresentationMask>
            {number ? <small>{number.connectionName}</small> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Confirmation of one "Unificar" group and its result. */
export function UnifyReviewModal({
  group,
  numbers,
  unifyAction,
  onClose,
  onDone,
}: {
  group: ProviderConversionRuleUnifyCandidateDto | null;
  numbers: readonly ConversionNumber[];
  unifyAction: UnifyAction;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ConversionScreenActionResult | null>(
    null,
  );
  const numbersById = new Map(numbers.map((number) => [number.id, number]));

  function close() {
    if (pending) return;
    const finished = result?.ok;
    setResult(null);
    setName("");
    setAcknowledged(false);
    if (finished) onDone();
    else onClose();
  }

  async function confirm() {
    if (!group || pending) return;
    setPending(true);
    const formData = new FormData();
    for (const id of group.ruleIds) formData.append("ruleId", id);
    if (name.trim()) formData.set("name", name.trim());
    if (acknowledged) formData.set("acknowledgeDifferences", "true");
    try {
      const response = await unifyAction(formData);
      setResult(response);
    } catch {
      setResult({
        ok: false,
        outcomeUnknown: true,
        message:
          "Não deu para confirmar a unificação. Confira a lista antes de tentar de novo.",
      });
    } finally {
      setPending(false);
    }
  }

  const duplicatePhone = group?.duplicatePhoneChannelIds ?? [];
  const observationCanonical = group?.observationCanonicalChannels ?? [];
  const differences = group?.differences ?? [];
  const members = group?.members ?? [];
  const target = members.find((member) => member.ruleId === group?.targetRuleId);
  const needsAcknowledgement = differences.length > 0;

  return (
    <Modal
      open={group !== null}
      onClose={close}
      title="Unificar regras iguais"
      description={group ? unifyGroupDescription(group) : undefined}
      size="wide"
    >
      {group ? (
        result?.ok ? (
          <div className="conversion-flow-result" role="status">
            <div className="feedback-banner success">
              <strong>Regras unificadas</strong>
              <span>{result.message}</span>
            </div>
            {result.unify?.newlyCoveredChannelIds.length ? (
              <section className="conversion-review-block">
                <h3>Números que passaram a ser cobertos</h3>
                <NumberList
                  ids={result.unify.newlyCoveredChannelIds}
                  numbersById={numbersById}
                />
              </section>
            ) : null}
            {result.unify?.duplicatePhoneChannelIds.length ? (
              <p className="action-note">
                Alguns números têm o mesmo telefone em duas conexões: o evento
                sai uma vez só por telefone.
              </p>
            ) : null}
            <div className="conversion-flow-actions">
              <button className="button primary" type="button" onClick={close}>
                Concluir
              </button>
            </div>
          </div>
        ) : (
          <div className="conversion-unify-review provider-conversion-builder">
            <p className="muted">
              {ruleOriginDefinition(group.origin).label} ·{" "}
              {ruleEventLabel(group.eventName)} ·{" "}
              {group.mode === "production"
                ? "envio automático"
                : "em observação"}
              . As regras atuais são pausadas e o histórico delas continua
              salvo.
            </p>
            <p className="action-note">
              Dá para desfazer: retome as regras pausadas (em “Regras”,
              Retomar observação) e pause a regra para todos os números.
              Unificar é uma sugestão, nunca é obrigatório.
            </p>

            {members.length > 0 ? (
              <section className="conversion-review-block">
                <h3>Regras que serão juntadas</h3>
                <div className="conversion-unify-members-scroll">
                <table className="conversion-unify-members">
                  <thead>
                    <tr>
                      <th scope="col">Regra</th>
                      <th scope="col">Modo</th>
                      <th scope="col">Valor</th>
                      <th scope="col">Produto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((member) => (
                      <tr
                        key={member.ruleId}
                        className={member.ruleId === group.targetRuleId ? "is-target" : undefined}
                      >
                        <td>
                          <span className="conversion-unify-member-name">
                            <PresentationMask placeholder="Regra oculta">{member.name}</PresentationMask>
                          </span>
                          {member.ruleId === group.targetRuleId ? (
                            <span className="status-chip">vale para todos</span>
                          ) : member.numberRemoved ? (
                            <span className="status-chip warn">número removido</span>
                          ) : null}
                        </td>
                        <td>{member.mode === "production" ? "Envio automático" : "Observação"}</td>
                        <td>{formatMemberValue(member)}</td>
                        <td>{member.defaultContentName ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                {needsAcknowledgement ? (
                  <div className="feedback-banner warn" role="alert">
                    <strong>
                      As regras têm {unifyDifferencesLabel(differences)} diferentes
                    </strong>
                    <span>
                      {target
                        ? `Vão valer os de “${target.name}”: ${target.mode === "production" ? "envio automático" : "observação"}, ${formatMemberValue(target)}${target.defaultContentName ? `, produto “${target.defaultContentName}”` : ""}. Os das outras regras deixam de valer.`
                        : "Vão valer os valores da regra mais antiga com número conectado."}
                    </span>
                    <label className="conversion-check conversion-unify-ack">
                      <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(event) => setAcknowledged(event.target.checked)}
                      />
                      <span>Entendi quais valores vão valer</span>
                    </label>
                  </div>
                ) : null}
              </section>
            ) : null}

            <section className="conversion-review-block">
              <h3>Já cobertos hoje ({group.channelIds.length})</h3>
              <NumberList ids={group.channelIds} numbersById={numbersById} />
            </section>

            <section className="conversion-review-block">
              <h3>
                Passam a ser cobertos ({group.newlyCoveredChannelIds.length})
              </h3>
              {group.newlyCoveredChannelIds.length > 0 ? (
                <>
                  <NumberList
                    ids={group.newlyCoveredChannelIds}
                    numbersById={numbersById}
                  />
                  <p className="action-note warn">
                    {group.mode === "production"
                      ? "Estes números começam a enviar este evento para a Meta."
                      : "Estes números começam a ser observados por esta regra (nada é enviado à Meta em observação)."}
                  </p>
                </>
              ) : (
                <p className="muted">
                  Nenhum número novo. Números conectados depois também entram
                  automaticamente.
                </p>
              )}
            </section>

            {group.overriddenChannelIds.length > 0 ? (
              <section className="conversion-review-block">
                <h3>
                  Continuam com a regra própria (
                  {group.overriddenChannelIds.length})
                </h3>
                <NumberList
                  ids={group.overriddenChannelIds}
                  numbersById={numbersById}
                />
                <p className="action-note">
                  Esses números já têm outra regra específica com a mesma origem
                  e o mesmo evento. Ela continua valendo no lugar da nova regra.
                </p>
              </section>
            ) : null}

            {duplicatePhone.length > 0 ? (
              <section className="conversion-review-block">
                <h3>Mesmo telefone em duas conexões ({duplicatePhone.length})</h3>
                <NumberList ids={duplicatePhone} numbersById={numbersById} />
                <p className="action-note">
                  O telefone destes números já é lido por outra conexão. A
                  regra roda uma vez só por telefone, para nunca enviar o
                  evento em dobro.
                </p>
              </section>
            ) : null}

            {observationCanonical.length > 0 ? (
              <section className="conversion-review-block">
                <h3>
                  Canal em observação ({observationCanonical.length})
                </h3>
                <NumberList
                  ids={observationCanonical.map((item) => item.canonicalChannelId)}
                  numbersById={numbersById}
                />
                <p className="action-note warn">
                  {observationCanonicalWarning(
                    observationCanonical.map((item) => item.canonicalChannelId),
                    numbersById,
                  )}
                </p>
              </section>
            ) : null}

            {group.existingGlobalRuleId ? (
              <p className="action-note">
                Já existe uma regra igual para todos os números. Ela será
                reaproveitada.
              </p>
            ) : isAutomationUnifyGroup(group) ? (
              <p className="action-note">
                A regra mais antiga com número conectado passa a valer para
                todos os números (mantém a URL e o histórico dela). As outras
                são pausadas e o histórico delas continua salvo.
              </p>
            ) : (
              <label className="conversion-field">
                <span className="field-label">Nome da regra unificada</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={group.name}
                  maxLength={120}
                />
              </label>
            )}

            {result && !result.ok ? (
              <p
                className={`action-note${result.outcomeUnknown ? "" : " warn"}`}
                role="alert"
              >
                {result.message}
              </p>
            ) : null}

            <div className="conversion-flow-actions">
              <button
                className="button"
                type="button"
                onClick={close}
                disabled={pending}
              >
                Cancelar
              </button>
              <button
                className="button primary"
                type="button"
                onClick={() => void confirm()}
                disabled={
                  pending ||
                  result?.licenseLocked === true ||
                  (needsAcknowledgement && !acknowledged)
                }
                data-pending={pending ? "true" : undefined}
              >
                {pending ? "Unificando..." : "Unificar"}
              </button>
            </div>
          </div>
        )
      ) : null}
    </Modal>
  );
}
