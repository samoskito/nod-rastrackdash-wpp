import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../src/app/(app)/events/actions", () => ({
  retryBlockedMetaEventsAction: vi.fn(),
  retryMetaEventAction: vi.fn(),
  retryRejectedMetaEventAction: vi.fn(),
  retryRejectedMetaEventsAction: vi.fn(),
}));

import {
  RETRY_REJECTED_WARNING,
  RetryRejectedEvents,
} from "../src/app/(app)/events/retry-rejected-events";

/** 1.3.1: "Reenviar recusados" em Eventos Meta (lote e por evento). */
const filters = {
  since: "2026-10-21",
  until: "2026-10-27",
  eventName: "",
  status: "",
  source: "",
};

describe("Reenviar recusados", () => {
  it("mostra o aviso antes do botão e desabilita sem recusas corrigíveis", () => {
    const html = renderToStaticMarkup(
      createElement(RetryRejectedEvents, { rejectedCount: 3, filters }),
    );
    expect(RETRY_REJECTED_WARNING).toBe(
      "Corrija a causa mostrada no motivo da recusa antes de reenviar. Se a Meta recusar de novo, o evento volta a Falhou com o novo motivo.",
    );
    expect(html.indexOf("Corrija a causa")).toBeLessThan(
      html.indexOf("Reenviar recusados"),
    );
    expect(html).not.toMatch(/<button[^>]*disabled/);
    const empty = renderToStaticMarkup(
      createElement(RetryRejectedEvents, { rejectedCount: 0, filters }),
    );
    expect(empty).toMatch(/<button[^>]*disabled/);
  });

  it("as ações chamam as rotas de recusados, em lote e por evento", () => {
    const actions = readFileSync(
      resolve(__dirname, "../src/app/(app)/events/actions.ts"),
      "utf8",
    );
    expect(actions).toContain("/reports/conversions/audit/retry-rejected?");
    expect(actions).toContain("/retry-rejected`");
  });

  it("o detalhe do evento oferece o reenvio com o aviso", () => {
    const details = readFileSync(
      resolve(__dirname, "../src/app/(app)/events/event-audit-details.tsx"),
      "utf8",
    );
    expect(details).toContain("detail.canRetryRejected");
    expect(details).toContain("RETRY_REJECTED_WARNING");
    expect(details).toContain("retryRejectedMetaEventAction");
  });

  it("a página mostra o botão para owner e admin", () => {
    const page = readFileSync(
      resolve(__dirname, "../src/app/(app)/events/page.tsx"),
      "utf8",
    );
    expect(page).toContain('workspace.role === "owner" || workspace.role === "admin"');
    expect(page).toContain("summary.metaRejectedRetryable");
  });
});

describe("Reenviar recusados em lote: resumo", () => {
  it("separa os que ficaram de fora por configuração dos já reenviados", async () => {
    const { retryRejectedMessage } = await import(
      "../src/app/(app)/events/retry-rejected-message"
    );
    const message = retryRejectedMessage({
      claimed: 1,
      enqueued: 1,
      skipped: 5,
      expired: 1,
      notReady: 2,
      alreadyConverted: 1,
      failed: 0,
    });
    expect(message).toContain("1 evento recusado enfileirado");
    expect(message).toContain("1 já tinha sido reenviado e ficou de fora.");
    expect(message).toContain(
      "2 eventos ficaram de fora por configuração: a rota Meta do número ou do anúncio ainda não está pronta.",
    );
    expect(message).toContain("1 evento ficou de fora por ter mais de 7 dias");
    expect(message).toContain(
      "1 evento ficou de fora porque o lead já foi convertido para o pixel atual",
    );
  });

  it("API antiga sem notReady: tudo como antes", async () => {
    const { retryRejectedMessage } = await import(
      "../src/app/(app)/events/retry-rejected-message"
    );
    expect(
      retryRejectedMessage({ claimed: 0, enqueued: 0, skipped: 2, failed: 0 }),
    ).toBe("2 já tinham sido reenviados e ficaram de fora.");
  });
});
