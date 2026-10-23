import { afterEach, describe, expect, it, vi } from "vitest";

const { isApiRequestError, revalidatePath, serverApiFetch } = vi.hoisted(
  () => ({
    isApiRequestError: vi.fn(
      (error: unknown) =>
        error instanceof Error && error.name === "ApiRequestError",
    ),
    revalidatePath: vi.fn(),
    serverApiFetch: vi.fn(),
  }),
);

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/lib/server-api", () => ({
  isApiRequestError,
  serverApiFetch,
}));

import { saveOpsAlertSettingsAction } from "../src/app/(app)/settings/ops-alert-settings-actions";
import { initialBackofficeActionState } from "../src/components/backoffice-action-form";

afterEach(() => {
  revalidatePath.mockReset();
  serverApiFetch.mockReset();
});

describe("ops alert settings server action", () => {
  it("maps the phone to digits and saves the toggles for the workspace", async () => {
    serverApiFetch.mockResolvedValueOnce({});

    const result = await saveOpsAlertSettingsAction(
      initialBackofficeActionState,
      form(
        {
          workspaceId: "workspace_1",
          enabled: "on",
          disconnectAlerts: "on",
          webhookSilenceAlerts: "on",
          silenceThresholdHours: "48",
          debounceHours: "3",
        },
        { alertPhones: ["(55) 11 99999-9999"] },
      ),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/workspaces/workspace_1/ops-alerts/settings",
      {
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          alertPhones: ["5511999999999"],
          alertPhone: "5511999999999",
          disconnectAlerts: true,
          webhookSilenceAlerts: true,
          silenceThresholdHours: 48,
          debounceHours: 3,
        }),
      },
    );
    expect(result).toEqual({
      status: "success",
      message: "Alertas de operação atualizados.",
      nonce: expect.any(Number),
    });
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("saves multiple phones, deduping and stripping non-digit characters", async () => {
    serverApiFetch.mockResolvedValueOnce({});

    await saveOpsAlertSettingsAction(
      initialBackofficeActionState,
      form(
        { workspaceId: "workspace_1", enabled: "on" },
        {
          alertPhones: ["5511999999999", "(55) 11 88888-8888", "5511999999999"],
        },
      ),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/workspaces/workspace_1/ops-alerts/settings",
      {
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          alertPhones: ["5511999999999", "5511888888888"],
          alertPhone: "5511999999999",
          disconnectAlerts: false,
          webhookSilenceAlerts: false,
          silenceThresholdHours: 24,
          debounceHours: 6,
        }),
      },
    );
  });

  it("rejects enabling alerts without a phone before calling the API", async () => {
    const result = await saveOpsAlertSettingsAction(
      initialBackofficeActionState,
      form({ workspaceId: "workspace_1", enabled: "on" }),
    );

    expect(result.status).toBe("error");
    expect(result.message).toContain("telefone");
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("defaults unchecked boxes to false and keeps default thresholds", async () => {
    serverApiFetch.mockResolvedValueOnce({});

    await saveOpsAlertSettingsAction(
      initialBackofficeActionState,
      form({ workspaceId: "workspace_1" }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/workspaces/workspace_1/ops-alerts/settings",
      {
        method: "PUT",
        body: JSON.stringify({
          enabled: false,
          alertPhones: [],
          alertPhone: "",
          disconnectAlerts: false,
          webhookSilenceAlerts: false,
          silenceThresholdHours: 24,
          debounceHours: 6,
        }),
      },
    );
  });

  it("requires a workspace id before calling the API", async () => {
    const result = await saveOpsAlertSettingsAction(
      initialBackofficeActionState,
      form({}),
    );

    expect(result.status).toBe("error");
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("surfaces a permission message when the API forbids the update", async () => {
    const error = new Error("Forbidden");
    error.name = "ApiRequestError";
    Object.assign(error, { status: 403 });
    serverApiFetch.mockRejectedValueOnce(error);

    const result = await saveOpsAlertSettingsAction(
      initialBackofficeActionState,
      form({ workspaceId: "workspace_1" }),
    );

    expect(result).toEqual({
      status: "error",
      message: "Sem permissão para gerenciar alertas operacionais.",
      nonce: expect.any(Number),
    });
  });
});

function form(
  values: Record<string, string>,
  multiValues: Record<string, string[]> = {},
): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) {
    formData.set(key, value);
  }
  for (const [key, values2] of Object.entries(multiValues)) {
    for (const value of values2) {
      formData.append(key, value);
    }
  }
  return formData;
}
