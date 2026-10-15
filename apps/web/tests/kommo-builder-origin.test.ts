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
  it("does not offer Kommo when the manager link is absent (default, other providers untouched)", () => {
    renderBuilder();
    openBuilder();
    const values = Array.from(originSelect().options).map((option) => option.value);
    expect(values).toEqual(["message", "tag", "catalog"]);
    expect(screen.getByLabelText("Nome da regra")).toBeTruthy();
  });

  it("offers Kommo beside the existing origins when the manager link is provided", () => {
    renderBuilder({ kommoManagerHref: "/integrations?abrir=kommo" });
    openBuilder();
    const values = Array.from(originSelect().options).map((option) => option.value);
    expect(values).toEqual(["message", "tag", "catalog", "kommo"]);
    expect(
      screen.getByRole("option", { name: "Mudança de estágio no Kommo CRM" }),
    ).toBeTruthy();
  });

  it("choosing Kommo shows a pointer instead of the provider form and creates nothing", () => {
    const { action } = renderBuilder({ kommoManagerHref: "/integrations?abrir=kommo" });
    openBuilder();
    fireEvent.change(originSelect(), { target: { value: "kommo" } });

    expect(screen.getByTestId("kommo-origin-pointer")).toBeTruthy();
    expect(screen.queryByLabelText("Nome da regra")).toBeNull();
    expect(screen.getByRole("link", { name: "Abrir Kommo em Integrações" })).toBeTruthy();
    expect(originSelect().value).toBe("kommo");
    expect((screen.getByLabelText("Evento enviado a Meta") as HTMLSelectElement).disabled).toBe(
      true,
    );
    expect(action).not.toHaveBeenCalled();
  });

  it("switching back restores the untouched provider form and every other origin", () => {
    renderBuilder({ kommoManagerHref: "/integrations?abrir=kommo" });
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

  it("points to the Kommo card in the Integrations hub instead of a local manager", () => {
    renderBuilder({ kommoManagerHref: "/integrations?abrir=kommo" });
    openBuilder();
    fireEvent.change(originSelect(), { target: { value: "kommo" } });
    const link = screen.getByRole("link", { name: "Abrir Kommo em Integrações" });

    expect(link.getAttribute("href")).toBe("/integrations?abrir=kommo");
    expect(screen.queryByRole("button", { name: "Abrir gerenciador Kommo" })).toBeNull();
    expect(document.querySelectorAll("#crm-configurado")).toHaveLength(0);
  });

  it("closing and reopening the builder returns to the provider default", () => {
    renderBuilder({ kommoManagerHref: "/integrations?abrir=kommo" });
    openBuilder();
    fireEvent.change(originSelect(), { target: { value: "kommo" } });
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(screen.queryByTestId("kommo-origin-pointer")).toBeNull();
    openBuilder();
    expect(screen.getByTestId("kommo-origin-pointer")).toBeTruthy();
  });
});

describe("integrations page wiring (structural)", () => {
  const page = readFileSync(
    resolve(__dirname, "../src/app/(app)/integrations/page.tsx"),
    "utf8",
  );
  const settingsPage = readFileSync(
    resolve(__dirname, "../src/app/(app)/settings/page.tsx"),
    "utf8",
  );

  it("mounts the Kommo manager exactly once, in the hub page only", () => {
    expect(page.match(/<KommoCrmManager\b/g)).toHaveLength(1);
    expect(settingsPage).not.toContain("<KommoCrmManager");
    expect(settingsPage).not.toContain("listKommoConnectionsAction");
  });

  it("mounts it outside every WhatsApp connection loop", () => {
    const managerIndex = page.indexOf("<KommoCrmManager");
    const loopIndex = page.indexOf("inboundWebhookData.connections.map(");
    expect(managerIndex).toBeGreaterThan(-1);
    // The manager never sits inside a per-connection .map in the hub page.
    expect(loopIndex === -1 || managerIndex < loopIndex).toBe(true);
  });

  it("gates the manager only by workspace/viewer (zero-WhatsApp entry preserved)", () => {
    const managerIndex = page.indexOf("<KommoCrmManager");
    const guard = page.lastIndexOf("workspace && kommoViewerId", managerIndex);
    expect(guard).toBeGreaterThan(-1);
    expect(managerIndex - guard).toBeLessThan(200);
  });

  it("settings still hands the builder a link to the hub Kommo card", () => {
    expect(settingsPage).toContain("kommoManagerHref");
    expect(settingsPage).toContain("/integrations?abrir=kommo");
  });
});
