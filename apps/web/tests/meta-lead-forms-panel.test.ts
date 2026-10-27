import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MetaLeadFormConnectionDto } from "@wpptrack/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("../src/app/(app)/integrations/meta-lead-form-actions", () => ({
  createMetaLeadFormConnectionAction: vi.fn(),
  deleteMetaLeadFormConnectionAction: vi.fn(),
  setMetaLeadFormConnectionActiveAction: vi.fn(),
  subscribeMetaLeadFormPageAction: vi.fn(),
  updateMetaLeadFormConnectionAction: vi.fn(),
}));

import { MetaLeadFormsPanel } from "../src/app/(app)/integrations/meta-lead-forms-panel";

/**
 * Fase 6.9 (PR #91 do nod): seção "Formulários Meta" no card Meta de
 * Integrações. Produção direta (a conexão nasce ativa, sem passo de
 * liberação), sem QR, licença bloqueada sem formulário de escrita.
 * Dados fictícios.
 */

const connection: MetaLeadFormConnectionDto = {
  id: "conexao_1",
  label: "Página Exemplo",
  pageId: "100000000000001",
  formIds: [],
  crmDatasetId: "200000000000001",
  qualifiedEventName: "LeadQualificado",
  graphTokenLast4: "abcd",
  capiTokenLast4: null,
  active: true,
  pageSubscribedAt: null,
  webhookUrl: "https://api.exemplo.test/webhooks/meta",
  submissionCount: 3,
  lastSubmissionAt: "2026-10-26T12:00:00.000Z",
  createdAt: "2026-10-20T12:00:00.000Z",
  updatedAt: "2026-10-26T12:00:00.000Z",
};

function render(props: Partial<Parameters<typeof MetaLeadFormsPanel>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(MetaLeadFormsPanel, {
      connections: [connection],
      canManage: true,
      licenseLocked: false,
      loadFailed: false,
      ...props,
    }),
  );
}

describe("Formulários Meta (Lead Ads) em Integrações", () => {
  it("shows the connection, the webhook URL and the Page subscription", () => {
    const html = render();

    expect(html).toContain("Formulários Meta");
    expect(html).toContain("Página Exemplo");
    expect(html).toContain("https://api.exemplo.test/webhooks/meta");
    expect(html).toContain("Assinar Página");
    expect(html).toContain("Página não assinada");
    expect(html).toContain("o dataset usa o token Graph");
    expect(html).toContain("Salvar conexão");
  });

  it("production direct: no observation, release, test or QR wording", () => {
    const html = render();
    for (const word of ["observação", "Observação", "liberar", "Liberar", "certific", "QR", "em teste"])
      expect(html).not.toContain(word);
    // Deactivated connections are reactivated, never "Ativar envio".
    expect(render({ connections: [{ ...connection, active: false }] })).toContain(
      "Reativar",
    );
    expect(html).not.toContain("Ativar envio");
    // The integrations-route rule: this panel never names a "Token CAPI".
    expect(html).not.toContain("Token CAPI");
  });

  it("license locked: reads stay, no write form and no action buttons", () => {
    const html = render({ licenseLocked: true });

    expect(html).toContain("Página Exemplo");
    expect(html).toContain("Licença bloqueada");
    expect(html).not.toContain("Salvar conexão");
    expect(html).not.toContain("Assinar Página</");
    expect(html).not.toContain("Remover");
  });

  it("without permission: read-only", () => {
    const html = render({ canManage: false });
    expect(html).toContain("Sem permissão para alterar formulários Meta.");
    expect(html).not.toContain("Remover");
  });

  it("the Integrations page mounts the panel with the license state", () => {
    const page = readFileSync(
      resolve(__dirname, "../src/app/(app)/integrations/page.tsx"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(page).toContain('"/integrations/meta-lead-forms"');
    expect(page).toMatch(/<MetaLeadFormsPanel[\s\S]*?licenseLocked=\{licenseLocked\}/);
  });

  it("the manual conversion confirmation shows the CRM stage of the form", () => {
    const dialog = readFileSync(
      resolve(__dirname, "../src/app/(app)/leads/[leadId]/manual-conversion-dialog.tsx"),
      "utf8",
    );
    expect(dialog).toContain("Formulário Meta (CRM)");
    expect(dialog).toContain("preview.crmStage");
  });
});

describe("Formulários Meta: remover só sem envios (decisão de 27/10/2026)", () => {
  it("with submissions: no Remover, Desativar and the short reason", () => {
    const html = render();

    expect(html).not.toContain(">Remover<");
    expect(html).toContain("Desativar");
    expect(html).toContain("Esta Página já recebeu formulários: não dá para remover");
    expect(html).toContain("o histórico fica guardado");
  });

  it("deactivated with submissions: Reativar, still no Remover", () => {
    const html = render({ connections: [{ ...connection, active: false }] });

    expect(html).toContain("Reativar");
    expect(html).toContain("Desativada");
    expect(html).not.toContain(">Remover<");
  });

  it("without submissions: Remover stays available", () => {
    const html = render({
      connections: [{ ...connection, submissionCount: 0, lastSubmissionAt: null }],
    });

    expect(html).toContain(">Remover<");
    expect(html).not.toContain("não dá para remover");
  });

  it("the actions call the deactivate and reactivate routes", () => {
    const actions = readFileSync(
      resolve(__dirname, "../src/app/(app)/integrations/meta-lead-form-actions.ts"),
      "utf8",
    );
    expect(actions).toContain('"reactivate" : "deactivate"');
  });
});
