import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { revalidatePath, serverApiFetch } = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  serverApiFetch: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/lib/server-api", () => ({
  serverApiFetch,
  isApiRequestError: () => false,
}));

import {
  createMetaManualConnectionAction,
  createMetaManualCredentialAction,
  disconnectMetaOAuthAction,
  removeMetaManualConnectionAction,
  syncMetaManualHistoryAction,
} from "../src/app/(app)/integrations/meta-manual-actions";

const initialPeriod = {
  since: "2026-07-08",
  until: "2026-07-14",
  anchorSource: "whatsapp_instance" as const,
  lookbackDaysApplied: 7,
};

const discovery = {
  credential: {
    id: "credential_1",
    workspaceId: "workspace_1",
    source: "manual",
    label: "Token BM Cliente",
    fingerprint: "1234567890abcdef",
    tokenLast4: "cret",
    tokenType: "system_user",
    scopes: ["ads_read"],
    expiresAt: null,
    status: "active",
    lastValidatedAt: "2026-07-14T12:00:00.000Z",
    validationError: null,
    rotatedAt: null,
    createdAt: "2026-07-14T12:00:00.000Z",
    updatedAt: "2026-07-14T12:00:00.000Z",
  },
  businesses: [],
  selectedBusinessId: null,
  adAccounts: [],
  pixels: [],
  pages: [],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-14T15:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  revalidatePath.mockReset();
  serverApiFetch.mockReset();
});

describe("Meta manual server actions", () => {
  it("disconnects OAuth only from the expected workspace", async () => {
    serverApiFetch.mockResolvedValueOnce({
      workspaceId: "workspace_1",
      status: "not_connected",
      disconnectedAt: "2026-07-15T04:30:00.000Z",
      preserved: {
        assetSnapshots: 2,
        reportingAccounts: 1,
        conversionDestinations: 1,
      },
    });

    const result = await disconnectMetaOAuthAction(
      "workspace_1",
      "DESCONECTAR META",
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/meta/oauth/disconnect",
      {
        method: "POST",
        body: JSON.stringify({
          expectedWorkspaceId: "workspace_1",
          confirmation: "DESCONECTAR META",
        }),
      },
    );
    expect(result).toMatchObject({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/integrations");
  });

  it("submits the token once and never returns it in action state", async () => {
    const accessToken = "EAAB-manual-token-super-secret";
    serverApiFetch.mockResolvedValueOnce(discovery);
    const formData = new FormData();
    formData.set("label", "Token BM Cliente");
    formData.set("accessToken", accessToken);

    const result = await createMetaManualCredentialAction(formData);

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/meta/manual/credentials",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ label: "Token BM Cliente", accessToken }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(result).toMatchObject({
      ok: true,
      discovery,
      message:
        "Token validado e protegido. A Meta nao listou as BMs; informe o ID da estrutura.",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/integrations");
  });

  it("builds the advanced matrix destination payload with explicit IDs", async () => {
    serverApiFetch
      .mockResolvedValueOnce({
        workspaceId: "workspace_1",
        credentials: [],
        businessConnections: [],
        destinations: [],
        reportingAccounts: [],
      })
      .mockResolvedValueOnce(initialPeriod)
      .mockResolvedValueOnce({ status: "queued" });
    const formData = new FormData();
    formData.set("credentialId", "credential_1");
    formData.set("businessManagerId", "business_advertiser");
    formData.set("businessManagerName", "BM Anunciante");
    formData.append("adAccountIds", "act_1");
    formData.append("adAccountIds", "act_2");
    formData.set("destinationMode", "new");
    formData.set("destinationLabel", "Pixel matriz");
    formData.set("ownerBusinessManagerId", "business_matrix");
    formData.set("pixelId", "pixel_matrix");
    formData.set("pageId", "page_matrix");

    await createMetaManualConnectionAction(formData);

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/meta/manual/connections",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          credentialId: "credential_1",
          businessManagerId: "business_advertiser",
          businessManagerName: "BM Anunciante",
          adAccountIds: ["act_1", "act_2"],
          accountSelectionMode: "merge",
          destination: {
            label: "Pixel matriz",
            ownerBusinessManagerId: "business_matrix",
            pixelId: "pixel_matrix",
            pageId: "page_matrix",
          },
        }),
      }),
    );
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/reports/meta/initial-sync-period",
    );
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/reports/meta/sync?since=2026-07-08&until=2026-07-14",
      { method: "POST" },
    );
  });

  it("queues a new history import for an already saved structure", async () => {
    serverApiFetch
      .mockResolvedValueOnce(initialPeriod)
      .mockResolvedValueOnce({ status: "queued" });

    const result = await syncMetaManualHistoryAction();

    expect(result).toMatchObject({ ok: true });
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/reports/meta/initial-sync-period",
    );
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/reports/meta/sync?since=2026-07-08&until=2026-07-14",
      { method: "POST" },
    );
    expect(revalidatePath).toHaveBeenCalledWith("/reports");
  });

  it("removes a saved structure with its exact BM confirmation", async () => {
    serverApiFetch.mockResolvedValueOnce({
      workspaceId: "workspace_1",
      credentials: [],
      businessConnections: [],
      destinations: [],
      reportingAccounts: [],
    });

    const result = await removeMetaManualConnectionAction(
      "connection_1",
      "business_1",
    );

    expect(result).toMatchObject({ ok: true });
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/meta/manual/connections/connection_1",
      {
        method: "DELETE",
        body: JSON.stringify({ businessManagerId: "business_1" }),
      },
    );
  });
});
