// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import type { WhatsappConnectionDto } from "@wpptrack/shared";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsappProviderPanel } from "../src/app/(app)/integrations/whatsapp-provider-panel";

// Fase 6.3b (porte do SaaS #125/#126, adaptado): cada conexão Uazapi BYO ou
// WAHA (URL do servidor + token, um número por conexão) mostra a atividade do
// número e o atalho para os leads dele. Só leitura.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

afterEach(cleanup);

function connection(
  provider: WhatsappConnectionDto["provider"],
  id: string,
): WhatsappConnectionDto {
  return {
    id,
    name: `Conexão ${provider}`,
    displayName: null,
    provider,
    status: "active",
    lastHealthStatus: null,
    lastHealthCheckedAt: null,
    createdAt: "2026-08-28T12:00:00.000Z",
  };
}

function renderPanel(connections: WhatsappConnectionDto[]) {
  const action = vi.fn(async () => ({ ok: true as const, message: "ok" }));

  return render(
    createElement(WhatsappProviderPanel, {
      connections,
      canManage: true,
      createAction: action,
      testAction: action,
      rotateAction: action,
      editAction: action,
      loadEditAction: vi.fn(async () => ({ ok: false as const, message: "x" })),
      deleteAction: action,
      activities: {
        conn_uazapi: {
          state: "real",
          checkedAt: "2026-08-28T12:00:00.000Z",
          activity: {
            leads24h: 2,
            leads7d: 5,
            leadsTotal: 11,
            lastLeadAt: "2026-08-28T11:00:00.000Z",
            lastWebhookAt: "2026-08-28T11:30:00.000Z",
          },
        },
        conn_waha: { state: "unavailable" },
      },
    } as never),
  );
}

describe("WhatsApp connection activity (6.3b)", () => {
  it("shows the activity of Uazapi BYO and WAHA connections with a link to their leads", () => {
    const { container } = renderPanel([
      connection("uazapi_byo", "conn_uazapi"),
      connection("waha", "conn_waha"),
    ]);
    const sections = container.querySelectorAll(
      'section[aria-label="Atividade do número WhatsApp"]',
    );

    expect(sections).toHaveLength(2);
    expect(sections[0]!.textContent).toContain("CTWA total11");
    expect(sections[0]!.textContent).toContain("Webhook recebido nas últimas 24h");
    expect(sections[1]!.textContent).toContain("Atividade indisponível");
    expect(
      Array.from(container.querySelectorAll("a")).map((link) =>
        link.getAttribute("href"),
      ),
    ).toEqual([
      "/leads?whatsappInstanceId=conn_uazapi",
      "/leads?whatsappInstanceId=conn_waha",
    ]);
  });

  it("does not show activity for providers without it (Z-API)", () => {
    const { container } = renderPanel([connection("zapi", "conn_zapi")]);

    expect(
      container.querySelector('section[aria-label="Atividade do número WhatsApp"]'),
    ).toBeNull();
  });
});
