"use client";

import type {
  ProviderConversionRuleCapabilitiesDto,
  ProviderConversionRuleDto,
  ProviderConversionRuleOriginDto,
} from "@wpptrack/shared";
import { Check, Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { ProviderConversionRuleActionResult } from "./actions";
import { originBetaEvents } from "./conversion-origins";
import { PaytSetupPanel } from "./payt-setup";
import { UmblerAutomationPayloadPanel } from "./umbler-automation-payload";

type RuleAction = (formData: FormData) => Promise<ProviderConversionRuleActionResult>;

const platformNames: Partial<Record<ProviderConversionRuleOriginDto, string>> = {
  automation_umbler: "Umbler Talk",
  automation_payt: "Payt",
};

function formatDateTime(value: string | null): string {
  if (!value) return "nunca";
  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  });
}

export function rotateConfirmText(origin: ProviderConversionRuleOriginDto): string {
  const platform = platformNames[origin] ?? "plataforma";
  return `O endereço atual para de funcionar na hora. Depois, cole o novo endereço na ${platform}: até lá, nenhum evento desta regra é recebido.`;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  return (
    <button
      className="button"
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => setState("copied"),
          () => setState("failed"),
        );
      }}
    >
      {state === "copied" ? (
        <Check size={14} aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
      {state === "copied" ? "Copiado" : state === "failed" ? "Copie manualmente" : label}
    </button>
  );
}

function SetupSteps({
  origin,
  rule,
  capabilities,
}: {
  origin: ProviderConversionRuleOriginDto;
  rule: ProviderConversionRuleDto;
  capabilities?: ProviderConversionRuleCapabilitiesDto | null;
}) {
  if (origin === "automation_payt") {
    // The Payt panel already carries the setup steps: list them only once.
    return (
      <PaytSetupPanel
        eventName={rule.conversionRule.eventName}
        beta={originBetaEvents(origin, capabilities ?? null).includes(
          rule.conversionRule.eventName,
        )}
      />
    );
  }
  if (origin === "automation_umbler") {
    return (
      <>
        <ol className="integration-steps">
          <li>No Umbler Talk, crie uma ação HTTP (POST) na automação que marca a conversão.</li>
          <li>Cole o endereço da regra no campo de URL. Não precisa de cabeçalho extra.</li>
          <li>Cole o corpo abaixo e ligue os campos do contato e da conversa.</li>
        </ol>
        <UmblerAutomationPayloadPanel eventName={rule.conversionRule.eventName} />
      </>
    );
  }
  return null;
}

/**
 * Address of an automation rule (Umbler): when it was last
 * called, how to set it up and "Gerar novo endereço" (the old one stops
 * working; the new one is shown once). The new address is held by the
 * screen (`freshUrl`) until the operator says "Já copiei", so switching
 * tabs, refreshing the list or remounting never loses it.
 */
export function RuleEndpoint({
  rule,
  origin,
  canManage,
  rotateAction,
  freshUrl = null,
  capabilities = null,
  onRotated,
  onDismiss,
}: {
  capabilities?: ProviderConversionRuleCapabilitiesDto | null;
  rule: ProviderConversionRuleDto;
  origin: ProviderConversionRuleOriginDto;
  canManage: boolean;
  rotateAction: RuleAction;
  freshUrl?: string | null;
  onRotated: (url: string) => void;
  onDismiss: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const newUrl = freshUrl;
  const platform = platformNames[origin] ?? "plataforma";
  const endpoint = rule.endpoint;

  async function rotate() {
    if (pending) return;
    setPending(true);
    setError(null);
    const formData = new FormData();
    formData.set("ruleId", rule.id);
    try {
      const result = await rotateAction(formData);
      if (result.ok && result.oneTimeSecret) {
        onRotated(result.oneTimeSecret.webhookUrl);
      } else {
        setError(result.message);
      }
    } catch {
      setError(
        "Não deu para confirmar se um novo endereço foi gerado. Se a plataforma parar de enviar eventos, gere um novo endereço e cole de novo.",
      );
    } finally {
      setPending(false);
      setConfirming(false);
    }
  }

  return (
    <div className="conversion-endpoint">
      <dl className="conversion-flow-summary">
        <div>
          <dt>Último evento recebido</dt>
          <dd>{formatDateTime(endpoint?.lastDeliveryAt ?? null)}</dd>
        </div>
        <div>
          <dt>Endereço gerado de novo em</dt>
          <dd>{endpoint?.rotatedAt ? formatDateTime(endpoint.rotatedAt) : "nunca foi trocado"}</dd>
        </div>
      </dl>

      {newUrl ? (
        <div className="conversion-fresh-url" role="status">
          <p className="action-note warn">
            Novo endereço gerado: o anterior já parou de funcionar. Ele só
            aparece agora; copie e cole na {platform}.
          </p>
          <div className="conversion-webhook-url">
            <label className="conversion-field">
              <span className="field-label">Novo endereço (exibido uma única vez)</span>
              <input
                readOnly
                value={newUrl}
                data-presentation-sensitive-field="true"
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <CopyButton value={newUrl} label="Copiar endereço" />
          </div>
          <button className="button primary" type="button" onClick={onDismiss}>
            <Check size={15} aria-hidden="true" />
            Já copiei
          </button>
        </div>
      ) : (
        <p className="action-note">
          Por segurança, o endereço só aparece uma vez, quando é criado. Se você
          perdeu, gere um novo e cole de novo na {platform}.
        </p>
      )}

      {error ? (
        <p className="action-note warn" role="alert">
          {error}
        </p>
      ) : null}

      {canManage && endpoint && !newUrl ? (
        confirming ? (
          <div className="conversion-inline-confirm" role="alert">
            <p>{rotateConfirmText(origin)}</p>
            <div className="conversion-flow-actions">
              <button
                className="button"
                type="button"
                onClick={() => setConfirming(false)}
                disabled={pending}
              >
                Cancelar
              </button>
              <button
                className="button primary"
                type="button"
                onClick={() => void rotate()}
                disabled={pending}
              >
                {pending ? "Gerando..." : "Gerar novo endereço"}
              </button>
            </div>
          </div>
        ) : (
          <button className="button" type="button" onClick={() => setConfirming(true)}>
            <RefreshCw size={15} aria-hidden="true" />
            Gerar novo endereço
          </button>
        )
      ) : null}

      {!endpoint ? (
        <p className="action-note warn">Esta regra não tem um endereço ativo.</p>
      ) : null}

      <section className="conversion-endpoint-setup" aria-label={`Como configurar na ${platform}`}>
        <h3>Como configurar na {platform}</h3>
        <SetupSteps origin={origin} rule={rule} capabilities={capabilities} />
      </section>
    </div>
  );
}
