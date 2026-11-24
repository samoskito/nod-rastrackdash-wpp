import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  orphanRouteWarnings,
  routeSimulationMessage,
} from "../src/app/(app)/integrations/meta-orphan-route-text";
import { MetaManualConnectionPanel } from "../src/app/(app)/integrations/meta-manual-connection-panel";

const account = {
  adAccountId: "act_111",
  adAccountName: "Conta Cliente 2",
  reason: "account_inactive" as const,
  leadCount: 18,
  blockedEventCount: 4,
  campaignNames: ["Campanha Black", "Outra", "Mais uma"],
  campaignCount: 5,
};

describe("Meta orphan route texts", () => {
  it("builds the simulation text only when leads would be blocked", () => {
    expect(routeSimulationMessage([])).toBeNull();
    expect(routeSimulationMessage([{ ...account, leadCount: 0 }])).toBeNull();
    expect(routeSimulationMessage([account])).toBe(
      "A campanha Campanha Black (e mais 4) recebeu 18 leads nos últimos 7 dias nesta conta. Com esta mudança, os leads dela ficam bloqueados e não vão para a Meta.",
    );
  });

  it("builds the persistent warning for disabled and destination-less accounts", () => {
    const [disabled] = orphanRouteWarnings([account]);
    const [noDestination] = orphanRouteWarnings([
      { ...account, reason: "no_destination", campaignCount: 1, leadCount: 1 },
    ]);

    expect(disabled?.message).toBe(
      "18 leads dos últimos 7 dias vieram da campanha Campanha Black (e mais 4), na conta Conta Cliente 2, que está desativada. Esses leads ficam bloqueados.",
    );
    expect(disabled?.advice).toBe(
      "Ative a conta e vincule um destino a ela.",
    );
    expect(noDestination?.message).toContain("1 lead dos últimos 7 dias veio");
    expect(noDestination?.message).toContain("que está sem destino");
  });

  it("shows the warning on the Meta panel and points to Eventos only with blocked events", () => {
    const render = (blockedEventCount: number) =>
      renderToStaticMarkup(
        createElement(MetaManualConnectionPanel, {
          workspaceId: "workspace_1",
          capabilities: {
            enabledModes: ["oauth"],
            oauthEnabled: true,
            manualEnabled: false,
          },
          initialConfiguration: {
            workspaceId: "workspace_1",
            connectionMode: "oauth",
            advancedRoutingEnabled: true,
            unmappedActiveAccountCount: 0,
            credentials: [],
            businessConnections: [],
            destinations: [],
            reportingAccounts: [],
            orphanRoutes: { accounts: [account], blockedEventCount },
          },
          legacyConnected: true,
          canManage: true,
          disconnectOAuthAction: vi.fn(),
          prepareOAuthCredentialAction: vi.fn(),
          createCredentialAction: vi.fn(),
          discoverAssetsAction: vi.fn(),
          createConnectionAction: vi.fn(),
          rotateCredentialAction: vi.fn(),
          setConnectionStatusAction: vi.fn(),
          testConnectionAction: vi.fn(),
          removeConnectionAction: vi.fn(),
          syncHistoryAction: vi.fn(),
          setAccountDestinationAction: vi.fn(),
          loadAdRoutingAction: vi.fn(),
          setAdDestinationAction: vi.fn(),
          setOAuthRoutingAction: vi.fn(),
        }),
      );

    const withEvents = render(4);
    const withoutEvents = render(0);

    expect(withEvents).toContain("Leads bloqueados por falta de rota Meta");
    expect(withEvents).toContain("Reenviar bloqueados em Eventos");
    expect(withoutEvents).toContain("Leads bloqueados por falta de rota Meta");
    expect(withoutEvents).not.toContain("Reenviar bloqueados em Eventos");
  });
});
