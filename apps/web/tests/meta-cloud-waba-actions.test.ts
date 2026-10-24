import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, serverApiFetch } from "../src/lib/server-api";
import {
  lookupMetaCloudWabaAction,
  subscribeMetaCloudWabaAction,
} from "../src/app/(app)/integrations/meta-cloud-waba-actions";

vi.mock("../src/lib/server-api", async () => {
  class MockApiRequestError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string,
    ) {
      super(message);
    }
  }
  return {
    ApiRequestError: MockApiRequestError,
    isApiRequestError: (error: unknown) => error instanceof MockApiRequestError,
    serverApiFetch: vi.fn(),
  };
});

const TOKEN = "EAAGsyntheticActionToken" + "K".repeat(30);
const WABA = "102290129340398";
const status = {
  connectionId: "conn",
  wabaId: WABA,
  thisAppId: "111222333444555",
  thisAppSubscribed: true,
  apps: [{ appId: "111222333444555", name: null, isThisApp: true }],
  phoneNumbers: [],
  channelCheck: { status: "no_real_channel", mismatchedChannels: 0 },
  outcome: "lookup",
  checkedAt: "2026-10-24T12:00:00.000Z",
};

beforeEach(() => vi.resetAllMocks());

describe("server actions da inscrição na WABA", () => {
  it("consulta e inscreve por POST, com o token só no corpo", async () => {
    vi.mocked(serverApiFetch).mockResolvedValue(status);

    expect(await lookupMetaCloudWabaAction("conn", { wabaId: WABA, accessToken: TOKEN })).toEqual({
      ok: true,
      data: status,
    });
    await subscribeMetaCloudWabaAction("conn", { wabaId: WABA, accessToken: TOKEN, confirm: true });

    expect(serverApiFetch).toHaveBeenNthCalledWith(
      1,
      "/integrations/inbound-webhooks/conn/meta-cloud/waba-subscription/lookup",
      { method: "POST", body: JSON.stringify({ wabaId: WABA, accessToken: TOKEN }) },
    );
    expect(serverApiFetch).toHaveBeenNthCalledWith(
      2,
      "/integrations/inbound-webhooks/conn/meta-cloud/waba-subscription",
      { method: "POST", body: JSON.stringify({ wabaId: WABA, accessToken: TOKEN, confirm: true }) },
    );
    for (const call of vi.mocked(serverApiFetch).mock.calls) {
      expect(call[0]).not.toContain(TOKEN);
    }
  });

  it("valida a entrada antes de chamar a API", async () => {
    const result = await lookupMetaCloudWabaAction("conn", { wabaId: "abc", accessToken: TOKEN });
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      await subscribeMetaCloudWabaAction("conn", { wabaId: WABA, accessToken: TOKEN, confirm: false as never }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("repassa a mensagem e o code da API sem o token", async () => {
    vi.mocked(serverApiFetch).mockRejectedValue(
      new ApiRequestError("Este token foi gerado para outro app Meta.", 422, "token_app_mismatch"),
    );
    const result = await subscribeMetaCloudWabaAction("conn", { wabaId: WABA, accessToken: TOKEN, confirm: true });
    expect(result).toEqual({
      ok: false,
      status: 422,
      code: "token_app_mismatch",
      message: "Este token foi gerado para outro app Meta.",
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("403 e 423 chegam com status; falha inesperada vira mensagem genérica", async () => {
    vi.mocked(serverApiFetch).mockRejectedValueOnce(new ApiRequestError("Sem permissão", 403));
    expect(await lookupMetaCloudWabaAction("conn", { wabaId: WABA, accessToken: TOKEN })).toMatchObject({
      ok: false,
      status: 403,
      message: "Sem permissão",
    });
    vi.mocked(serverApiFetch).mockRejectedValueOnce(new ApiRequestError("Licença bloqueada", 423));
    expect(await lookupMetaCloudWabaAction("conn", { wabaId: WABA, accessToken: TOKEN })).toMatchObject({
      status: 423,
    });
    vi.mocked(serverApiFetch).mockRejectedValueOnce(new Error(`boom ${TOKEN}`));
    const generic = await lookupMetaCloudWabaAction("conn", { wabaId: WABA, accessToken: TOKEN });
    expect(generic.ok).toBe(false);
    expect(JSON.stringify(generic)).not.toContain(TOKEN);
  });
});
