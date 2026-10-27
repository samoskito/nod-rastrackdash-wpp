import { afterEach, describe, expect, it, vi } from "vitest";
import { kommoHarness } from "./support/kommo-stateful-harness";

/**
 * 1.3.1 (revisão do #121): com INBOUND_CONVERSION_PRODUCTION_ENABLED=false o
 * evento da Kommo com regra enviando não é mais encerrado como "blocked". Ele
 * espera (sem gastar tentativas) e sai na reavaliação depois que o envio é
 * religado, uma vez só. Passados 7 dias, é encerrado como antes.
 */
/** Avança o relógio; a reconciliação real mantém o catálogo atualizado. */
function advance(h: ReturnType<typeof kommoHarness>, ms: number) {
  h.advance(ms);
  h.connection.catalogRefreshedAt = (h.service as any).now();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Kommo com o envio de conversões desligado no servidor", () => {
  it("espera sem materializar e sai uma vez quando o envio é religado", async () => {
    const h = kommoHarness();
    vi.stubEnv("INBOUND_CONVERSION_PRODUCTION_ENABLED", "false");
    const event = await h.receive();

    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "accepted",
      errorCode: "conversion_production_disabled",
    });
    expect(h.state.kommoWebhookEvent[0]).toMatchObject({
      status: "accepted",
      errorCode: "conversion_production_disabled",
      attempts: 0,
    });
    expect(h.state.kommoWebhookEvent[0].nextAttemptAt).toBeInstanceOf(Date);
    expect(h.state.conversionEventLog).toHaveLength(0);
    expect(h.state.kommoConversionDedupe).toHaveLength(0);

    // Ainda desligado: continua esperando.
    advance(h, 16 * 60_000);
    await h.service.process(event.id, event.workspaceId);
    expect(h.state.kommoWebhookEvent[0].status).toBe("accepted");
    expect(h.state.conversionEventLog).toHaveLength(0);

    // Religado: a reavaliação seguinte materializa.
    vi.stubEnv("INBOUND_CONVERSION_PRODUCTION_ENABLED", "true");
    advance(h, 16 * 60_000);
    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "queued",
    });
    expect(h.state.conversionEventLog).toHaveLength(1);
    expect(h.state.kommoConversionDedupe).toHaveLength(1);

    // Reavaliar de novo não cria outra conversão.
    advance(h, 31_000);
    await h.service.process(event.id, event.workspaceId);
    expect(h.state.conversionEventLog).toHaveLength(1);
  });

  it("passados 7 dias do evento, encerra como bloqueado (como na 1.3.0)", async () => {
    const h = kommoHarness();
    vi.stubEnv("INBOUND_CONVERSION_PRODUCTION_ENABLED", "false");
    const event = await h.receive();
    advance(h, 8 * 24 * 60 * 60_000);

    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "blocked",
      errorCode: "conversion_production_disabled",
    });
    expect(h.state.conversionEventLog).toHaveLength(0);
  });
});
