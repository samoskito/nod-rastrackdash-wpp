import { describe, expect, it } from "vitest";
import { whatsappDisconnectAlertText } from "../src/app/(app)/integrations/whatsapp-disconnect-alert";

/**
 * Fase 6.1c (porte do SaaS #63): aviso de desconexão confirmada na tela de
 * Integrações, para a Uazapi BYO e a WAHA (URL do servidor + token).
 */
const alert = {
  confirmedAt: "2026-10-26T15:30:00.000Z",
  lastCheckedAt: "2026-10-26T15:45:00.000Z",
};
const fixed = () => "26/10/2026, 12:30";

describe("aviso de WhatsApp desconectado", () => {
  it("sem alerta confirmado, não mostra nada", () => {
    expect(
      whatsappDisconnectAlertText({ provider: "waha", disconnectAlert: null }),
    ).toBeNull();
    expect(whatsappDisconnectAlertText({ provider: "uazapi_byo" })).toBeNull();
  });

  it("WAHA: diz desde quando, que foram 2 leituras e onde reconectar", () => {
    const text = whatsappDisconnectAlertText(
      { provider: "waha", disconnectAlert: alert },
      fixed,
    )!;
    expect(text).toContain("WhatsApp desconectado desde 26/10/2026, 12:30");
    expect(text).toContain("2 leituras seguidas");
    expect(text).toContain("painel da sua WAHA");
    expect(text).toContain("Testar");
  });

  it("Uazapi BYO: reconectar no painel da Uazapi do aluno", () => {
    const text = whatsappDisconnectAlertText(
      { provider: "uazapi_byo", disconnectAlert: alert },
      fixed,
    )!;
    expect(text).toContain("painel da sua Uazapi");
  });

  it("o texto não fala em ler código no celular (no nod a conexão é por URL do servidor e token)", () => {
    // A sigla proibida é montada por código para não aparecer no fonte.
    const forbidden = new RegExp(`\\b${String.fromCharCode(81, 82)}\\b`, "iu");
    for (const provider of ["waha", "uazapi_byo"] as const) {
      expect(
        whatsappDisconnectAlertText({ provider, disconnectAlert: alert }),
      ).not.toMatch(forbidden);
    }
  });

  it("formata a data em horário de Brasília por padrão", () => {
    const text = whatsappDisconnectAlertText({
      provider: "waha",
      disconnectAlert: alert,
    })!;
    expect(text).toMatch(/26\/10\/2026,? 12:30/u);
  });
});
