// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboundWebhookChannelDto } from "@wpptrack/shared";
import {
  ProviderConversionRulePanel,
  type ProviderConversionRulePanelProps,
} from "../src/app/(app)/integrations/provider-conversion-rule-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

const channel = {
  id: "channel_1",
  connectionId: "connection_1",
  organizationId: "organization_1",
  providerChannelId: "provider_channel_1",
  connectedPhone: "+5511999990000",
  channelName: "Comercial",
  whatsappInstanceId: null,
  status: "active",
  productionActivatedAt: null,
  firstSeenAt: "2026-07-21T10:00:00.000Z",
  lastSeenAt: "2026-07-21T11:00:00.000Z",
  routes: [],
  readiness: {
    state: "ready",
    blockers: [],
    routeCount: 1,
    validRouteCount: 1,
    totalCtwa: 1,
    routedCtwa: 1,
    unresolvedCtwa: 0,
    retainedCtwa: 1,
    retainedRoutedCtwa: 1,
    payloadUnavailableCtwa: 0,
    alreadyMaterializedCtwa: 0,
    nextPayloadExpiresAt: null,
  },
  createdAt: "2026-07-21T10:00:00.000Z",
  updatedAt: "2026-07-21T11:00:00.000Z",
} satisfies InboundWebhookChannelDto;

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function renderBuilder(overrides: Partial<ProviderConversionRulePanelProps> = {}) {
  const action = vi.fn(async (_formData: FormData) => ({ ok: true as const, message: "ok" }));
  const props: ProviderConversionRulePanelProps = {
    connectionId: "connection_1",
    connectionProvider: "umbler",
    channels: [channel],
    rules: [],
    enabled: true,
    canManage: true,
    createAction: action,
    updateAction: action,
    rotateEndpointAction: action,
    loadAutomationAuditAction: action,
    loadAutomationPayloadAction: action,
    loadPurchaseAuditAction: action,
    loadExecutionAuditAction: action,
    reprocessAutomationCallbacksAction: action,
    removeAction: action,
    testMessageAction: action,
    ...overrides,
  };
  return { action, ...render(createElement(ProviderConversionRulePanel, props)) };
}

function openBuilder() {
  fireEvent.click(screen.getByRole("button", { name: "Nova regra" }));
}

function originSelect() {
  return screen.getByLabelText("Origem do gatilho") as HTMLSelectElement;
}

describe("Kommo as an opt-in origin in the existing builder", () => {
  it("does not offer Kommo when the manager is not mounted (default, other providers untouched)", () => {
    renderBuilder();
    openBuilder();
    const values = Array.from(originSelect().options).map((option) => option.value);
    expect(values).toEqual(["message", "tag", "catalog"]);
    expect(screen.getByLabelText("Nome da regra")).toBeTruthy();
  });

  it("offers Kommo beside the existing origins when the manager anchor is provided", () => {
    renderBuilder({ kommoManagerAnchorId: "crm-configurado" });
    openBuilder();
    const values = Array.from(originSelect().options).map((option) => option.value);
    expect(values).toEqual(["message", "tag", "catalog", "kommo"]);
    expect(
      screen.getByRole("option", { name: "Mudança de estágio no Kommo CRM" }),
    ).toBeTruthy();
  });

  it("choosing Kommo shows a pointer instead of the provider form and creates nothing", () => {
    const { action } = renderBuilder({ kommoManagerAnchorId: "crm-configurado" });
    openBuilder();
    fireEvent.change(originSelect(), { target: { value: "kommo" } });

    expect(screen.getByTestId("kommo-origin-pointer")).toBeTruthy();
    expect(screen.queryByLabelText("Nome da regra")).toBeNull();
    expect(screen.getByRole("button", { name: "Abrir gerenciador Kommo" })).toBeTruthy();
    expect(originSelect().value).toBe("kommo");
    expect((screen.getByLabelText("Evento enviado a Meta") as HTMLSelectElement).disabled).toBe(
      true,
    );
    expect(action).not.toHaveBeenCalled();
  });

  it("switching back restores the untouched provider form and every other origin", () => {
    renderBuilder({ kommoManagerAnchorId: "crm-configurado" });
    openBuilder();
    for (const origin of ["tag", "catalog", "message"]) {
      fireEvent.change(originSelect(), { target: { value: "kommo" } });
      expect(screen.queryByLabelText("Nome da regra")).toBeNull();
      fireEvent.change(originSelect(), { target: { value: origin } });
      expect(screen.queryByTestId("kommo-origin-pointer")).toBeNull();
      expect(screen.getByLabelText("Nome da regra")).toBeTruthy();
      expect(originSelect().value).toBe(origin);
    }
  });

  it("opens the single manager, focuses its summary and never duplicates it", () => {
    const manager = document.createElement("details");
    manager.id = "crm-configurado";
    const summary = document.createElement("summary");
    summary.tabIndex = 0;
    manager.appendChild(summary);
    document.body.appendChild(manager);
    manager.scrollIntoView = vi.fn();

    renderBuilder({ kommoManagerAnchorId: "crm-configurado" });
    openBuilder();
    fireEvent.change(originSelect(), { target: { value: "kommo" } });
    fireEvent.click(screen.getByRole("button", { name: "Abrir gerenciador Kommo" }));

    expect(manager.open).toBe(true);
    expect(manager.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(summary);
    expect(document.querySelectorAll("#crm-configurado")).toHaveLength(1);
  });

  it("closing and reopening the builder returns to the provider default", () => {
    renderBuilder({ kommoManagerAnchorId: "crm-configurado" });
    openBuilder();
    fireEvent.change(originSelect(), { target: { value: "kommo" } });
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(screen.queryByTestId("kommo-origin-pointer")).toBeNull();
    openBuilder();
    expect(screen.getByTestId("kommo-origin-pointer")).toBeTruthy();
  });
});

describe("settings page wiring (structural)", () => {
  const page = readFileSync(
    resolve(__dirname, "../src/app/(app)/settings/page.tsx"),
    "utf8",
  );

  it("mounts the Kommo manager exactly once", () => {
    expect(page.match(/<KommoCrmManager\b/g)).toHaveLength(1);
  });

  it("mounts it outside every WhatsApp connection card loop", () => {
    const managerIndex = page.indexOf("<KommoCrmManager");
    const loopIndex = page.indexOf("inboundConnections.map(({ connection, channels })");
    const loopEnd = page.indexOf("})}", loopIndex);
    expect(loopIndex).toBeGreaterThan(-1);
    expect(managerIndex).toBeGreaterThan(loopEnd);
  });

  it("gates the manager only by workspace/viewer (zero-WhatsApp entry preserved)", () => {
    const managerIndex = page.indexOf("<KommoCrmManager");
    const guard = page.lastIndexOf("workspace && kommoViewerId", managerIndex);
    expect(guard).toBeGreaterThan(-1);
    expect(managerIndex - guard).toBeLessThan(200);
  });
});
