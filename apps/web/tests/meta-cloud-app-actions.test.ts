import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, serverApiFetch } from "../src/lib/server-api";
import {
  removeMetaCloudAppAction,
  saveMetaCloudAppAction,
} from "../src/app/(app)/integrations/meta-cloud-app-actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
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
    isLicenseLockedError: (error: unknown) =>
      error instanceof MockApiRequestError && error.status === 423,
    serverApiFetch: vi.fn(),
  };
});

const APP_ID = "1234567890123456";
const SECRET = "0123456789abcdef0123456789abcdef";
const at = "2026-10-30T12:00:00.000Z";
const connection = {
  id: "conn",
  workspaceId: "ws",
  provider: "meta_cloud",
  displayName: "Meta oficial",
  parserVersion: "v1",
  status: "observation",
  productionActivatedAt: null,
  lastDeliveryAt: null,
  lastSuccessfulParseAt: null,
  createdAt: at,
  updatedAt: at,
  metaApp: {
    appId: APP_ID,
    appSecretConfigured: true,
    appSecretSource: "connection",
    appSecretUpdatedAt: at,
  },
};

beforeEach(() => vi.resetAllMocks());

describe("server actions do app Meta da conexão", () => {
  it("salva por PUT com o segredo só no corpo", async () => {
    vi.mocked(serverApiFetch).mockResolvedValue(connection);
    const result = await saveMetaCloudAppAction("conn", {
      appId: APP_ID,
      appSecret: `  ${SECRET}  `,
    });

    expect(result).toEqual({
      ok: true,
      message: expect.stringContaining("App Secret salvo"),
      metaApp: connection.metaApp,
    });
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/inbound-webhooks/conn/meta-cloud/app",
      { method: "PUT", body: JSON.stringify({ appId: APP_ID, appSecret: SECRET }) },
    );
    expect(vi.mocked(serverApiFetch).mock.calls[0][0]).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("valida antes de chamar a API (App ID numérico, segredo sem espaço)", async () => {
    expect(
      await saveMetaCloudAppAction("conn", { appId: "abc", appSecret: SECRET }),
    ).toMatchObject({ ok: false });
    expect(
      await saveMetaCloudAppAction("conn", { appId: APP_ID, appSecret: "   " }),
    ).toMatchObject({ ok: false });
    expect(
      await saveMetaCloudAppAction("conn", {
        appId: APP_ID,
        appSecret: "0123456789 abcdef0123456789",
      }),
    ).toMatchObject({ ok: false });
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("remove por DELETE e repassa a recusa 409 da API", async () => {
    vi.mocked(serverApiFetch).mockRejectedValueOnce(
      new ApiRequestError("Esta conexão está enviando e o servidor não tem META_APP_SECRET de reserva.", 409),
    );
    expect(await removeMetaCloudAppAction("conn")).toEqual({
      ok: false,
      message: "Esta conexão está enviando e o servidor não tem META_APP_SECRET de reserva.",
    });
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/inbound-webhooks/conn/meta-cloud/app",
      { method: "DELETE" },
    );
  });

  it("licença bloqueada vira a mensagem de licença", async () => {
    vi.mocked(serverApiFetch).mockRejectedValueOnce(new ApiRequestError("Locked", 423));
    const result = await saveMetaCloudAppAction("conn", { appId: APP_ID, appSecret: SECRET });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("Licença bloqueada") });
  });
});
