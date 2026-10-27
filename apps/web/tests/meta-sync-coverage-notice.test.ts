import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MetaSyncCoverageDto } from "@wpptrack/shared";
import {
  MetaSyncCoverageNotice,
  metaSyncCoverageMessages,
} from "../src/components/meta-sync-coverage-notice";

const healthy: MetaSyncCoverageDto = {
  earliestDailyDate: "2026-08-01",
  earliestDailyAccountName: "Conta Principal",
  periodStartsBeforeCoverage: false,
  problemAccounts: [],
  staleSince: null,
};

function html(
  coverage: MetaSyncCoverageDto | undefined,
  action?: string,
): string {
  return renderToStaticMarkup(
    React.createElement(MetaSyncCoverageNotice, { coverage, action }),
  );
}

describe("MetaSyncCoverageNotice", () => {
  it("não renderiza nada quando está tudo certo ou sem cobertura", () => {
    expect(html(healthy)).toBe("");
    expect(html(undefined)).toBe("");
  });

  it("avisa que os dados da Meta começam depois do início do período", () => {
    const markup = html({
      ...healthy,
      earliestDailyDate: "2026-09-10",
      periodStartsBeforeCoverage: true,
    });

    expect(markup).toContain(
      "Dados da Meta disponíveis a partir de 10/09 (conta Conta Principal)",
    );
    expect(markup).not.toContain("Sincronização da Meta atrasada");
    expect(markup).toContain("feedback-banner warn");
  });

  it("avisa sincronização atrasada com link para Integrações", () => {
    const markup = html(
      {
        ...healthy,
        problemAccounts: [
          {
            adAccountId: "act_1",
            name: "Conta Principal",
            reason: "stale",
            since: "2026-10-20T15:00:00.000Z",
          },
        ],
        staleSince: "2026-10-20T15:00:00.000Z",
      },
      "Use Sincronizar Meta acima.",
    );

    expect(markup).toContain(
      "Sincronização da Meta atrasada desde 20/10 — reconecte a conta ou sincronize.",
    );
    expect(markup).toContain("Use Sincronizar Meta acima.");
    expect(markup).toContain('href="/integrations"');
    expect(markup).toContain("Abrir Integrações");
  });

  it("usa o dia de Brasília e resume quando há muitas contas", () => {
    const messages = metaSyncCoverageMessages({
      ...healthy,
      problemAccounts: ["a", "b", "c", "d"].map((id) => ({
        adAccountId: id,
        name: id,
        reason: "error" as const,
        // 01:00 UTC ainda é dia 19 em Brasília.
        since: "2026-10-20T01:00:00.000Z",
      })),
      staleSince: "2026-10-20T01:00:00.000Z",
    });

    expect(messages.delay).toContain("desde 19/10");
    expect(messages.delay).toContain("4 contas afetadas");
  });
});
