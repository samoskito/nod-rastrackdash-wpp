import type { ExecutionContext } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import {
  canRetryConversionEvent,
  isMetaAuthFailureConversionEvent,
  isStalledReadyToSendConversionEvent,
  metaGraphErrorCodeFromResponse,
  STALLED_READY_TO_SEND_MS,
} from "../../src/conversion-events/conversion-event-retry";
import { MetaCapiAdapter } from "../../src/conversion-events/meta-capi.adapter";
import { LicenseSoftlockGuard } from "../../src/licensing-client/license-softlock.guard";
import type { LicenseClientService } from "../../src/licensing-client/license-client.service";

/**
 * Porte do #181 (4d2fbf83) e da parte "ready_to_send parado" do 7ac17df7.
 *
 * Adaptação nod: o adapter da CAPI do nod nunca guardou o corpo de uma
 * recusa (pode ter PII), só { httpStatus }. Para o "Reenviar bloqueados"
 * reconhecer a falha de login da Meta, a recusa passa a guardar também o
 * error.code numérico da Graph, e nada além dele.
 */

const input = {
  accessToken: "synthetic-token",
  pixelId: "synthetic-pixel",
  pageId: "synthetic-page",
  eventName: "LeadSubmitted" as const,
  dedupeKey: "synthetic-event",
  phoneHash: "a".repeat(64),
  adId: "synthetic-ad",
  ctwaClid: "synthetic-click",
};

function rejectedWith(body: string, status = 400) {
  return new MetaCapiAdapter(
    {},
    vi.fn<typeof fetch>(async () => new Response(body, { status })),
  );
}

describe("MetaCapiAdapter: recusa por falha de login da Meta (#181)", () => {
  it.each([
    [190, 459],
    [190, 463],
    [102, undefined],
  ])(
    "guarda só o código %s (subcode %s) e sinaliza o login na mensagem",
    async (code, subcode) => {
      const body = JSON.stringify({
        error: {
          message: "You cannot access the app till you log in to www.facebook.com",
          type: "OAuthException",
          code,
          ...(subcode ? { error_subcode: subcode } : {}),
          fbtrace_id: "synthetic-trace",
        },
      });
      const result = await rejectedWith(body).sendEvent(input);
      expect(result).toMatchObject({
        status: "error",
        errorCode: "MetaCapiRejected",
        errorMessage:
          "Meta CAPI authentication failed (code 190/102): reconnect Meta and resend",
      });
      expect(result.responseSummary).toEqual({
        httpStatus: 400,
        error: { code },
      });
      expect(JSON.stringify(result.responseSummary)).not.toContain("log in");
      expect(JSON.stringify(result.responseSummary)).not.toContain("trace");
    },
  );

  it("mantém a mensagem genérica para outros códigos (100) e corpo sem JSON", async () => {
    const invalid = await rejectedWith(
      JSON.stringify({ error: { code: 100, message: "Invalid parameter" } }),
    ).sendEvent(input);
    expect(invalid).toMatchObject({
      errorCode: "MetaCapiRejected",
      errorMessage: "Meta CAPI request failed",
      responseSummary: { httpStatus: 400, error: { code: 100 } },
    });

    const html = await rejectedWith("<html>bad gateway</html>", 502).sendEvent(
      input,
    );
    expect(html).toMatchObject({
      errorCode: "MetaCapiRejected",
      errorMessage: "Meta CAPI request failed",
    });
    expect(html.responseSummary).toEqual({ httpStatus: 502 });
  });
});

describe("conversion-event-retry: classes reenviáveis", () => {
  const day = 86_400_000;
  const now = Date.UTC(2026, 9, 26, 12);
  const rejected = (overrides: Record<string, unknown> = {}) => ({
    status: "error",
    errorCode: "MetaCapiRejected",
    sourceTrigger: "inbound_webhook:waha:message_phrase",
    eventOccurredAt: new Date(now - 2 * day),
    providerResponseSummary: { httpStatus: 400, error: { code: 190 } },
    ...overrides,
  });

  it("lê o error.code numérico ou em texto e ignora o resto", () => {
    expect(metaGraphErrorCodeFromResponse({ error: { code: 190 } })).toBe(190);
    expect(metaGraphErrorCodeFromResponse({ error: { code: " 102 " } })).toBe(
      102,
    );
    expect(metaGraphErrorCodeFromResponse({ httpStatus: 400 })).toBeNull();
    expect(metaGraphErrorCodeFromResponse(null)).toBeNull();
    expect(metaGraphErrorCodeFromResponse({ error: { code: 1.5 } })).toBeNull();
  });

  it("reenvia 190/102 dentro de 7 dias; nunca Kommo/Pipedrive, 100, expirado ou recusa antiga sem código", () => {
    expect(canRetryConversionEvent(rejected(), now)).toBe(true);
    expect(
      canRetryConversionEvent(
        rejected({ providerResponseSummary: { error: { code: 102 } } }),
        now,
      ),
    ).toBe(true);
    expect(
      canRetryConversionEvent(
        rejected({ eventOccurredAt: new Date(now - 8 * day) }),
        now,
      ),
    ).toBe(false);
    expect(
      isMetaAuthFailureConversionEvent(
        rejected({ providerResponseSummary: { error: { code: 100 } } }),
      ),
    ).toBe(false);
    for (const sourceTrigger of ["kommo_stage", "pipedrive_stage"])
      expect(
        isMetaAuthFailureConversionEvent(rejected({ sourceTrigger })),
      ).toBe(false);
    expect(
      isMetaAuthFailureConversionEvent(
        rejected({ providerResponseSummary: { httpStatus: 400 } }),
      ),
    ).toBe(false);
  });

  it("considera parado um ready_to_send sem erro há mais de 10 minutos (7ac17df7)", () => {
    const ready = (createdAt: Date | null, errorCode: string | null = null) => ({
      status: "ready_to_send",
      errorCode,
      createdAt,
    });
    expect(
      isStalledReadyToSendConversionEvent(
        ready(new Date(now - STALLED_READY_TO_SEND_MS)),
        now,
      ),
    ).toBe(true);
    expect(
      isStalledReadyToSendConversionEvent(ready(new Date(now - 60_000)), now),
    ).toBe(false);
    expect(isStalledReadyToSendConversionEvent(ready(null), now)).toBe(false);
    expect(
      isStalledReadyToSendConversionEvent(ready(null, "CtwaSendSkipped"), now),
    ).toBe(true);
  });
});

describe("licença bloqueada: reenviar e reprocessar são escritas (423)", () => {
  const blocked = {
    getLockState: vi.fn().mockResolvedValue({
      inert: false,
      locked: true,
      reason: "revoked",
      state: {
        status: "blocked",
        softLock: true,
        hardLock: true,
        usable: false,
        expiresAt: null,
        validUntil: null,
        source: "cache",
        reason: "revoked",
        interval: null,
      },
    }),
  } as unknown as LicenseClientService;
  const context = (method: string, path: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ method, path }),
        getResponse: () => ({}),
      }),
    }) as unknown as ExecutionContext;

  it.each([
    "/reports/conversions/audit/retry-blocked",
    "/reports/conversions/audit/event_1/retry",
    "/conversion-rules/providers/rule_1/reprocess-blocked",
  ])("POST %s responde 423 e a leitura continua liberada", async (path) => {
    const guard = new LicenseSoftlockGuard(blocked);
    const write = guard.canActivate(context("POST", path));
    await expect(write).rejects.toBeInstanceOf(HttpException);
    await write.catch((error: HttpException) =>
      expect(error.getStatus()).toBe(423),
    );
    await expect(
      guard.canActivate(context("GET", "/reports/conversions/audit")),
    ).resolves.toBe(true);
  });
});
