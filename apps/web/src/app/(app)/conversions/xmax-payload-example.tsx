"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { xmaxBodyExample, xmaxMinimalBodyExample } from "./webhook-view";

/**
 * Exemplo de chamada da automação da XMAX (dados fictícios). O texto espelha
 * o leitor da API (apps/api/src/inbound-webhooks/providers/xmax/
 * xmax-automation-v1.parser.ts): mude os dois lados juntos.
 */
function CopyableJson({ label, json }: { label: string; json: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="xmax-payload-block">
      <span className="micro-label">{label}</span>
      <pre className="payload-block">{json}</pre>
      <button className="button subtle" type="button" onClick={() => void copy()}>
        {copied ? (
          <Check size={14} aria-hidden="true" />
        ) : (
          <Copy size={14} aria-hidden="true" />
        )}
        {copied ? "Copiado" : "Copiar JSON"}
      </button>
    </div>
  );
}

export function XmaxPayloadExample() {
  return (
    <div className="provider-conversion-payload-helper" data-xmax-payload>
      <div>
        <span className="micro-label">Chamada da automação da XMAX</span>
        <strong>Método POST, corpo JSON</strong>
      </div>
      <p className="action-note">
        Envie um POST para a URL da regra. O token já vai na URL; se preferir,
        mande-o no cabeçalho <code>x-wpptrack-webhook-token</code>. O valor da
        conversão é o valor fixo da regra.
      </p>
      <ul className="integration-steps">
        <li>
          <code>ID_oportunidade</code> (obrigatório): identifica a oportunidade
          e evita contar duas vezes o mesmo evento.
        </li>
        <li>
          <code>Telefone_oportunidade</code> (obrigatório): com DDI e DDD, por
          exemplo 5511999999999. Se vier vazio, usamos o{" "}
          <code>contact_number</code> do primeiro contato de{" "}
          <code>Contatos_oportunidade</code>.
        </li>
        <li>
          <code>Contatos_oportunidade</code> (opcional): lista de contatos da
          oportunidade; só vale quando o telefone vem vazio.
        </li>
        <li>
          <code>Etapa_oportunidade</code> (opcional): só aparece na tela, não
          decide o evento (o evento é o da regra).
        </li>
      </ul>
      <p className="action-note">Os outros campos são ignorados.</p>
      <CopyableJson label="Exemplo completo" json={xmaxBodyExample()} />
      <CopyableJson
        label="Mínimo, se a XMAX deixar montar o corpo"
        json={xmaxMinimalBodyExample()}
      />
    </div>
  );
}
