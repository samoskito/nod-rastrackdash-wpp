import { describe, expect, it, vi } from "vitest";
import {
  canRetryConversionEvent,
  isMetaAuthFailureConversionEvent,
} from "../../src/conversion-events/conversion-event-retry";
import {
  MetaCapiAdapter,
  type MetaCapiSendEventInput,
} from "../../src/conversion-events/meta-capi.adapter";
import {
  conversionEventRejectionText,
  META_AUTH_FAILURE_RETRY_TEXT,
  metaCapiRejectionText,
  pickMetaCapiRejectionError,
  safeMetaDestinationReason,
  storedMetaCapiRejectionError,
} from "../../src/conversion-events/meta-capi-rejection";

/**
 * Motivo legível da recusa da Meta (Fase 6): a recusa guarda só code,
 * error_subcode, type e fbtrace_id do erro da Graph; message, error_user_title
 * e error_user_msg (que podem repetir dados do lead) nunca são guardados.
 * Dados sintéticos; nenhuma chamada real à Meta.
 */

const SENSITIVE_PHONE = "+55 11 98888-7777";
const SENSITIVE_EMAIL = "lead.sintetico@example.com";

const input = (
  overrides: Partial<MetaCapiSendEventInput> = {},
): MetaCapiSendEventInput => ({
  accessToken: "synthetic-token",
  pixelId: "synthetic-pixel",
  pageId: "synthetic-page",
  eventName: "LeadSubmitted",
  dedupeKey: "synthetic-event",
  phoneHash: "a".repeat(64),
  adId: "synthetic-ad",
  ctwaClid: "synthetic-click",
  ...overrides,
});

const sensitiveError = (extra: Record<string, unknown> = {}) => ({
  error: {
    message: `Invalid parameter for ${SENSITIVE_PHONE}`,
    error_user_title: `Lead ${SENSITIVE_EMAIL}`,
    error_user_msg: `O telefone ${SENSITIVE_PHONE} não confere`,
    type: "OAuthException",
    code: 100,
    error_subcode: 2804019,
    is_transient: false,
    fbtrace_id: "AbC_12-xyz",
    ...extra,
  },
});

function rejectedWith(body: string, status = 400) {
  return new MetaCapiAdapter(
    {},
    vi.fn<typeof fetch>(async () => new Response(body, { status })),
  );
}

function expectNoFreeText(value: unknown) {
  const json = JSON.stringify(value);
  for (const fragment of [
    SENSITIVE_PHONE,
    SENSITIVE_EMAIL,
    "Invalid parameter",
    "não confere",
    "message",
    "error_user_msg",
    "error_user_title",
    "is_transient",
  ])
    expect(json).not.toContain(fragment);
}

describe("MetaCapiAdapter: o que a recusa guarda", () => {
  it("guarda só code, error_subcode, type e fbtrace_id de uma resposta 400", async () => {
    const result = await rejectedWith(
      JSON.stringify(sensitiveError()),
    ).sendEvent(input());

    expect(result).toMatchObject({
      status: "error",
      errorCode: "MetaCapiRejected",
      errorMessage: "Meta CAPI request failed",
    });
    expect(result.responseSummary).toEqual({
      httpStatus: 400,
      error: {
        code: 100,
        error_subcode: 2804019,
        type: "OAuthException",
        fbtrace_id: "AbC_12-xyz",
      },
    });
    expectNoFreeText(result.responseSummary);
    expectNoFreeText(result.errorMessage);
  });

  it.each([
    ["type com espaço", { type: "OAuth Exception" }],
    ["type com marcação", { type: "<b>OAuth</b>" }],
    ["type longo demais", { type: "A".repeat(65) }],
    ["type que não é texto", { type: 42 }],
  ])("descarta %s", async (_label, extra) => {
    const result = await rejectedWith(
      JSON.stringify(sensitiveError(extra)),
    ).sendEvent(input());
    expect(result.responseSummary).toEqual({
      httpStatus: 400,
      error: { code: 100, error_subcode: 2804019, fbtrace_id: "AbC_12-xyz" },
    });
  });

  it.each([
    ["fbtrace_id com espaço e texto", `trace ${SENSITIVE_EMAIL}`],
    ["fbtrace_id longo demais", "a".repeat(257)],
    ["fbtrace_id vazio", ""],
    ["fbtrace_id que não é texto", 123],
  ])("descarta %s", async (_label, fbtrace_id) => {
    const result = await rejectedWith(
      JSON.stringify(sensitiveError({ fbtrace_id })),
    ).sendEvent(input());
    expect(result.responseSummary).toEqual({
      httpStatus: 400,
      error: { code: 100, error_subcode: 2804019, type: "OAuthException" },
    });
    expectNoFreeText(result.responseSummary);
  });

  it("aceita fbtrace_id de 256 caracteres seguros e descarta subcódigo inválido", async () => {
    const trace = "A".repeat(256);
    const result = await rejectedWith(
      JSON.stringify(
        sensitiveError({ fbtrace_id: trace, error_subcode: "abc" }),
      ),
    ).sendEvent(input());
    expect(result.responseSummary).toEqual({
      httpStatus: 400,
      error: { code: 100, type: "OAuthException", fbtrace_id: trace },
    });
  });

  it("corpo inválido, sem erro ou enorme não quebra", async () => {
    const html = await rejectedWith("<html>bad gateway</html>", 502).sendEvent(
      input(),
    );
    expect(html).toMatchObject({ errorCode: "MetaCapiRejected" });
    expect(html.responseSummary).toEqual({ httpStatus: 502 });

    const noError = await rejectedWith(JSON.stringify({ ok: false })).sendEvent(
      input(),
    );
    expect(noError.responseSummary).toEqual({ httpStatus: 400 });

    const arrayError = await rejectedWith(
      JSON.stringify({ error: [1, 2] }),
    ).sendEvent(input());
    expect(arrayError.responseSummary).toEqual({ httpStatus: 400 });

    const huge = await rejectedWith(
      JSON.stringify(
        sensitiveError({
          message: `${SENSITIVE_PHONE} ${"x".repeat(2_000_000)}`,
          error_user_msg: "y".repeat(500_000),
        }),
      ),
    ).sendEvent(input());
    expect(huge.responseSummary).toEqual({
      httpStatus: 400,
      error: {
        code: 100,
        error_subcode: 2804019,
        type: "OAuthException",
        fbtrace_id: "AbC_12-xyz",
      },
    });
    expect(JSON.stringify(huge).length).toBeLessThan(5_000);
    expectNoFreeText(huge.responseSummary);
  });

  it('190/102 continua sinalizado para o "Reenviar bloqueados"', async () => {
    const result = await rejectedWith(
      JSON.stringify(sensitiveError({ code: 190, error_subcode: 463 })),
    ).sendEvent(input());
    expect(result).toMatchObject({
      errorCode: "MetaCapiRejected",
      errorMessage:
        "Meta CAPI authentication failed (code 190/102): reconnect Meta and resend",
    });
    const stored = {
      status: "error",
      errorCode: "MetaCapiRejected",
      sourceTrigger: "inbound_webhook:waha:message_phrase",
      eventOccurredAt: new Date(),
      providerResponseSummary: result.responseSummary,
    };
    expect(isMetaAuthFailureConversionEvent(stored)).toBe(true);
    expect(canRetryConversionEvent(stored)).toBe(true);
    expect(conversionEventRejectionText(stored)).toBe(
      META_AUTH_FAILURE_RETRY_TEXT,
    );
  });
});

describe("MetaCapiAdapter em lote: o que a recusa guarda", () => {
  const batchEnv = {
    META_GRAPH_API_VERSION: "v21.0",
    META_CAPI_BATCH_ENABLED: "true",
    META_CAPI_BATCH_WINDOW_MS: "10000",
  };

  it("recusa do lote inteiro (limite) guarda os mesmos campos seguros", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify(
            sensitiveError({ code: 80004, error_subcode: 2446079 }),
          ),
          { status: 400 },
        ),
    );
    const adapter = new MetaCapiAdapter(batchEnv, fetchMock);
    const pending = Promise.all([
      adapter.sendEvent(input({ dedupeKey: "synthetic-event-1" })),
      adapter.sendEvent(input({ dedupeKey: "synthetic-event-2" })),
    ]);
    await adapter.flushAllBatches();
    const results = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const result of results) {
      // Revisão do #121: limite de uso no lote volta para a fila (classe
      // retentável); a resposta guardada continua só com os campos seguros.
      expect(result.errorCode).toBe("MetaCapiNetworkError");
      expect(result.responseSummary).toEqual({
        httpStatus: 400,
        error: {
          code: 80004,
          error_subcode: 2446079,
          type: "OAuthException",
          fbtrace_id: "AbC_12-xyz",
        },
      });
    }
    expectNoFreeText(results);
  });

  it("recusa de um evento do lote (100) reenviada um a um também guarda só os campos seguros", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(sensitiveError()), { status: 400 }),
    );
    const adapter = new MetaCapiAdapter(batchEnv, fetchMock);
    const pending = Promise.all([
      adapter.sendEvent(input({ dedupeKey: "synthetic-event-1" })),
      adapter.sendEvent(input({ dedupeKey: "synthetic-event-2" })),
    ]);
    await adapter.flushAllBatches();
    const results = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const result of results)
      expect(result.responseSummary).toEqual({
        httpStatus: 400,
        error: {
          code: 100,
          error_subcode: 2804019,
          type: "OAuthException",
          fbtrace_id: "AbC_12-xyz",
        },
      });
    expectNoFreeText(results);
  });
});

describe("motivo legível da recusa", () => {
  it.each([
    [
      { code: 190, error_subcode: 463, fbtrace_id: "T1" },
      "A Meta recusou o evento (código 190, subcódigo 463): o token de acesso da Meta expirou. Reconecte a Meta em Integrações (Trocar token no card do BM). Identificador para suporte da Meta: T1",
    ],
    [
      { code: 102 },
      "A Meta recusou o evento (código 102): o login ou o token da conexão Meta expirou ou foi revogado. Reconecte a Meta em Integrações (Trocar token no card do BM).",
    ],
    [
      { code: 200 },
      "A Meta recusou o evento (código 200): o token da conexão Meta não tem permissão sobre este conjunto de dados (pixel). No Gerenciador de Negócios, dê ao usuário do sistema (ou ao app) acesso ao conjunto de dados do pixel e confira se o token tem as permissões pedidas na conexão.",
    ],
    [
      { code: 4 },
      "A Meta recusou o evento (código 4): o limite de chamadas da Meta foi atingido. Aguarde alguns minutos; os próximos eventos devem passar sozinhos.",
    ],
  ])("texto completo para %j", (error, text) => {
    expect(metaCapiRejectionText(error)).toBe(text);
  });

  it.each([
    [{ code: 10 }, "não tem permissão sobre este conjunto de dados"],
    [{ code: 3 }, "não tem permissão sobre este conjunto de dados"],
    [{ code: 294 }, "ads_management"],
    [{ code: 17 }, "limite de chamadas"],
    [{ code: 32 }, "limite de chamadas"],
    [{ code: 341 }, "limite de chamadas"],
    [{ code: 613 }, "limite de chamadas"],
    [{ code: 80004, error_subcode: 2446079 }, "limite de chamadas"],
    [{ code: 1 }, "erro temporário"],
    [{ code: 2 }, "erro temporário"],
    [{ code: 368 }, "violação de política"],
    [{ code: 100, error_subcode: 2804019 }, "parâmetro do evento inválido"],
    [{ code: 190, error_subcode: 460 }, "senha"],
    [{ code: 190, error_subcode: 459 }, "aviso de segurança"],
  ])("mapa: %j", (error, fragment) => {
    const text = metaCapiRejectionText(error);
    expect(text.startsWith("A Meta recusou o evento (código")).toBe(true);
    expect(text).toContain(fragment);
  });

  it("código desconhecido mostra o texto genérico com código, subcódigo e identificador", () => {
    expect(
      metaCapiRejectionText({
        code: 12345,
        error_subcode: 678,
        fbtrace_id: "AbC_12-xyz",
      }),
    ).toBe(
      "A Meta recusou o evento (código 12345, subcódigo 678). Identificador para suporte da Meta: AbC_12-xyz",
    );
    expect(metaCapiRejectionText({ code: 12345 })).toBe(
      "A Meta recusou o evento (código 12345).",
    );
    expect(metaCapiRejectionText({ fbtrace_id: "T" })).toBe(
      "A Meta recusou o evento. Identificador para suporte da Meta: T",
    );
  });

  it("re-higieniza o que já está guardado (linhas antigas ou do formulário Meta)", () => {
    expect(
      storedMetaCapiRejectionError({
        httpStatus: 400,
        fbtraceId: "CrmTrace",
        error: { code: 100, error_subcode: 33, message: SENSITIVE_EMAIL },
      }),
    ).toEqual({ code: 100, error_subcode: 33, fbtrace_id: "CrmTrace" });
    expect(storedMetaCapiRejectionError({ httpStatus: 400 })).toBeNull();
    expect(storedMetaCapiRejectionError(null)).toBeNull();
    expect(pickMetaCapiRejectionError("not an object")).toBeNull();
    expect(pickMetaCapiRejectionError({ error: { message: "x" } })).toBeNull();
  });

  it("evento guardado: 190 de Kommo (não reenviável) usa o mapa; sem dado da Meta devolve null", () => {
    const base = {
      status: "error",
      errorCode: "MetaCapiRejected",
      providerResponseSummary: {
        httpStatus: 400,
        error: { code: 190, fbtrace_id: "T" },
      },
    };
    expect(
      conversionEventRejectionText({ ...base, sourceTrigger: "kommo_stage" }),
    ).toBe(
      "A Meta recusou o evento (código 190): o login ou o token da conexão Meta expirou ou foi revogado. Reconecte a Meta em Integrações (Trocar token no card do BM). Identificador para suporte da Meta: T",
    );
    expect(
      conversionEventRejectionText({
        ...base,
        providerResponseSummary: { httpStatus: 400 },
      }),
    ).toBeNull();
    expect(
      conversionEventRejectionText({
        ...base,
        errorCode: "MetaCapiNetworkError",
      }),
    ).toBeNull();
  });

  it("motivo do destino: só textos conhecidos do resolvedor", () => {
    expect(safeMetaDestinationReason("Conta Meta inativa")).toBe(
      "Conta Meta inativa",
    );
    expect(
      safeMetaDestinationReason("Meta CAPI pixel id or page id not configured"),
    ).toBe("Pixel ou página do destino Meta não configurados");
    expect(safeMetaDestinationReason(`Erro ${SENSITIVE_EMAIL}`)).toBeNull();
    expect(safeMetaDestinationReason(null)).toBeNull();
  });
});
