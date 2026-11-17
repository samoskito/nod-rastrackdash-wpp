import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UazapiAdapter } from "../../src/integrations/uazapi/uazapi.adapter";

/**
 * Etiquetas da Uazapi: a lista vem do servidor Uazapi do aluno (URL salva na
 * conexão), com UAZAPI_BASE_URL só como reserva. Falha nunca derruba a
 * avaliação, mas sempre deixa o motivo no log (sem token, URL ou telefone).
 * Dados fictícios.
 */
const studentToken = "token-ficticio-do-aluno";
const envBase = {
  UAZAPI_BASE_URL: "https://env-uazapi.example.test",
  UAZAPI_TOKEN: "token-ficticio-env",
};

function recordingFetch(response: () => Response | Promise<Response>) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    urls.push(String(url));
    return response();
  }) as typeof fetch;
  return { urls, fetchImpl };
}

function warnLogs() {
  return vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UazapiAdapter.listLabels base URL", () => {
  it("uses the student's saved instance URL, not the env URL", async () => {
    const { urls, fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify([{ id: "7", name: "Comprou" }])),
    );
    const adapter = new UazapiAdapter(envBase, fetchImpl);

    const result = await adapter.listLabels("instancia_1", studentToken, {
      baseUrl: "https://aluno.uazapi.example.test/",
    });

    expect(result.status).toBe("success");
    expect(result.labels).toEqual([
      { id: "7", name: "Comprou", colorHex: null, labelId: null },
    ]);
    expect(urls).toEqual(["https://aluno.uazapi.example.test/labels"]);
  });

  it("falls back to env UAZAPI_BASE_URL only when the instance has no URL", async () => {
    const { urls, fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify([])),
    );
    const adapter = new UazapiAdapter(envBase, fetchImpl);

    await adapter.listLabels("instancia_1", studentToken, { baseUrl: null });
    await adapter.listLabels("instancia_1", studentToken);

    expect(urls).toEqual([
      "https://env-uazapi.example.test/labels",
      "https://env-uazapi.example.test/labels",
    ]);
  });
});

describe("UazapiAdapter.listLabels failure logging", () => {
  it("returns an empty catalog and logs the HTTP status on a non-200", async () => {
    const warn = warnLogs();
    const { fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
    const adapter = new UazapiAdapter({}, fetchImpl);

    const result = await adapter.listLabels("instancia_1", studentToken, {
      baseUrl: "https://aluno.uazapi.example.test",
    });

    expect(result).toMatchObject({
      status: "error",
      labels: [],
      failureReason: "http_error",
      httpStatus: 401,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0]![0]));
    expect(logged).toEqual({
      event: "uazapi_label_list_failed",
      reason: "http_error",
      httpStatus: 401,
      baseUrlSource: "connection",
    });
    expect(String(warn.mock.calls[0]![0])).not.toContain(studentToken);
    expect(String(warn.mock.calls[0]![0])).not.toContain("aluno.uazapi");
  });

  it("logs an invalid (non-list) body instead of silently returning no labels", async () => {
    const warn = warnLogs();
    const { fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ labels: "nope" })),
    );
    const adapter = new UazapiAdapter({}, fetchImpl);

    const result = await adapter.listLabels("instancia_1", studentToken, {
      baseUrl: "https://aluno.uazapi.example.test",
    });

    expect(result).toMatchObject({
      status: "error",
      labels: [],
      failureReason: "invalid_body",
    });
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({
      event: "uazapi_label_list_failed",
      reason: "invalid_body",
    });
  });

  it("logs an invalid saved URL and an unreachable server", async () => {
    const warn = warnLogs();
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const adapter = new UazapiAdapter({}, failing);

    const invalid = await adapter.listLabels("instancia_1", studentToken, {
      baseUrl: "not a url",
    });
    const unreachable = await adapter.listLabels("instancia_1", studentToken, {
      baseUrl: "https://aluno.uazapi.example.test",
    });

    expect(invalid).toMatchObject({ labels: [], failureReason: "invalid_base_url" });
    expect(unreachable).toMatchObject({
      labels: [],
      failureReason: "request_failed",
    });
    const reasons = warn.mock.calls.map(
      (call) => JSON.parse(String(call[0])).reason,
    );
    expect(reasons).toEqual(["invalid_base_url", "request_failed"]);
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toContain(studentToken);
    }
  });
});
