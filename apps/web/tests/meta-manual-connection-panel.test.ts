import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  MetaManualConnectionPanel,
  parseMetaAdAccountIds,
} from "../src/app/(app)/integrations/meta-manual-connection-panel";

const actions = {
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
};

const capabilities = {
  enabledModes: ["oauth", "manual"] as Array<"oauth" | "manual">,
  oauthEnabled: true,
  manualEnabled: true,
};

describe("Meta manual connection panel", () => {
  it("normalizes direct ad account IDs without accepting arbitrary text", () => {
    expect(
      parseMetaAdAccountIds(
        "1234567890, act_9876543210\nACT_9876543210 conta-invalida",
      ),
    ).toEqual(["act_1234567890", "act_9876543210"]);
  });

  it("locks manual setup when the workspace already uses OAuth", () => {
    const html = renderToStaticMarkup(
      createElement(MetaManualConnectionPanel, {
        workspaceId: "workspace_1",
        capabilities,
        initialConfiguration: null,
        legacyConnected: true,
        canManage: true,
        ...actions,
      }),
    );

    expect(html).toContain("Desconectar OAuth");
    expect(html).toContain("Desconectar e usar token");
    expect(html).toContain("DESCONECTAR META");
    expect(html).toContain("Eventos, campanhas e auditorias");
    expect(html).not.toContain('name="accessToken"');
  });

  it("keeps OAuth BM mappings in shadow mode until explicit activation", () => {
    const html = renderToStaticMarkup(
      createElement(MetaManualConnectionPanel, {
        workspaceId: "workspace_1",
        capabilities,
        initialConfiguration: {
          workspaceId: "workspace_1",
          connectionMode: "oauth",
          advancedRoutingEnabled: false,
          unmappedActiveAccountCount: 0,
          credentials: [
            {
              id: "credential_oauth",
              workspaceId: "workspace_1",
              source: "oauth",
              label: "Login social Meta",
              fingerprint: "1234567890abcdef",
              tokenLast4: "cret",
              tokenType: "bearer",
              scopes: ["ads_read", "business_management"],
              expiresAt: null,
              status: "active",
              lastValidatedAt: "2026-07-17T12:00:00.000Z",
              validationError: null,
              rotatedAt: null,
              createdAt: "2026-07-17T12:00:00.000Z",
              updatedAt: "2026-07-17T12:00:00.000Z",
            },
          ],
          businessConnections: [
            {
              id: "connection_oauth",
              workspaceId: "workspace_1",
              credentialId: "credential_oauth",
              businessManagerId: "business_1",
              businessManagerName: "BM Cliente",
              status: "active",
              defaultConversionDestinationId: "destination_1",
              reportingAccountCount: 2,
              activeReportingAccountCount: 2,
              lastValidatedAt: "2026-07-17T12:00:00.000Z",
              validationError: null,
              lastSyncedAt: null,
              createdAt: "2026-07-17T12:00:00.000Z",
              updatedAt: "2026-07-17T12:00:00.000Z",
            },
          ],
          destinations: [
            {
              id: "destination_1",
              workspaceId: "workspace_1",
              label: "Destino BM Cliente",
              ownerBusinessManagerId: "business_1",
              pixelId: "pixel_1",
              pixelName: "Pixel Cliente",
              pageId: "page_1",
              pageName: "Pagina Cliente",
              status: "configured",
              lastValidatedAt: "2026-07-17T12:00:00.000Z",
              validationError: null,
            },
            {
              id: "destination_2",
              workspaceId: "workspace_1",
              label: "Destino BM Cliente 2",
              ownerBusinessManagerId: "business_1",
              pixelId: "pixel_2",
              pixelName: "Pixel Cliente 2",
              pageId: "page_2",
              pageName: "Pagina Cliente 2",
              status: "configured",
              lastValidatedAt: "2026-07-17T12:00:00.000Z",
              validationError: null,
            },
          ],
          reportingAccounts: [
            {
              id: "reporting_1",
              workspaceId: "workspace_1",
              businessId: "business_1",
              businessName: "BM Cliente",
              adAccountId: "act_123",
              adAccountName: "Conta Cliente",
              currency: "BRL",
              timezoneName: "America/Sao_Paulo",
              businessConnectionId: "connection_oauth",
              conversionDestinationId: null,
              conversionDestinationIds: undefined as unknown as string[],
              active: true,
              syncStatus: "synced",
              lastSyncedAt: null,
              lastSyncSince: null,
              lastSyncUntil: null,
              syncError: null,
            },
            {
              id: "reporting_2",
              workspaceId: "workspace_1",
              businessId: "business_1",
              businessName: "BM Cliente",
              adAccountId: "act_456",
              adAccountName: "Conta Cliente 2",
              currency: "BRL",
              timezoneName: "America/Sao_Paulo",
              businessConnectionId: "connection_oauth",
              conversionDestinationId: "destination_2",
              conversionDestinationIds: ["destination_2"],
              active: true,
              syncStatus: "pending",
              lastSyncedAt: null,
              lastSyncSince: null,
              lastSyncUntil: null,
              syncError: null,
            },
          ],
        },
        legacyConnected: true,
        canManage: true,
        ...actions,
      }),
    );

    expect(html).toContain("Vincular Pixel e Pagina por BM");
    expect(html).toContain("Estruturas salvas sem alterar a rota atual");
    expect(html).toContain("Ativar roteamento por BM");
    expect(html).not.toContain("Roteamento por BM ativo");
    expect(html).toContain("1 BM");
    expect(html).toContain("2 contas");
    expect(html).toContain("2 destinos");
    expect(html).toContain("2 vinculo(s) ativo(s)");
    expect(html).toContain("2 destino(s) salvo(s)");
    expect(html).toContain("Conta Cliente");
    expect(html).toContain("Conta Cliente 2");
    expect(html).toContain("Pixel Cliente");
    expect(html).toContain("Pixel Cliente 2");
    expect(html).toContain("Pagina Cliente");
    expect(html).toContain("Pagina Cliente 2");
    expect(html).toContain("Destinos salvos nesta BM");
  });

  it("shows the permanent-token entry without exposing setup to analysts", () => {
    const html = renderToStaticMarkup(
      createElement(MetaManualConnectionPanel, {
        workspaceId: "workspace_1",
        capabilities,
        initialConfiguration: {
          workspaceId: "workspace_1",
          connectionMode: "manual",
          advancedRoutingEnabled: false,
          unmappedActiveAccountCount: 0,
          credentials: [],
          businessConnections: [],
          destinations: [],
          reportingAccounts: [],
        },
        legacyConnected: false,
        canManage: false,
        ...actions,
      }),
    );

    expect(html).toContain("Usar token permanente");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/);
    expect(html).not.toContain('name="accessToken"');
  });

  it("keeps a saved manual structure visible with sync health and management actions", () => {
    const html = renderToStaticMarkup(
      createElement(MetaManualConnectionPanel, {
        workspaceId: "workspace_1",
        capabilities,
        initialConfiguration: {
          workspaceId: "workspace_1",
          connectionMode: "manual",
          advancedRoutingEnabled: false,
          unmappedActiveAccountCount: 0,
          credentials: [
            {
              id: "credential_1",
              workspaceId: "workspace_1",
              source: "manual",
              label: "Token BM Cliente",
              fingerprint: "1234567890abcdef",
              tokenLast4: "cret",
              tokenType: "system_user",
              scopes: ["ads_read", "ads_management"],
              expiresAt: null,
              status: "active",
              lastValidatedAt: "2026-07-14T12:00:00.000Z",
              validationError: null,
              rotatedAt: null,
              createdAt: "2026-07-14T12:00:00.000Z",
              updatedAt: "2026-07-14T12:00:00.000Z",
            },
          ],
          businessConnections: [
            {
              id: "connection_1",
              workspaceId: "workspace_1",
              credentialId: "credential_1",
              businessManagerId: "business_1",
              businessManagerName: "BM Cliente",
              status: "active",
              defaultConversionDestinationId: "destination_1",
              reportingAccountCount: 1,
              activeReportingAccountCount: 1,
              lastValidatedAt: "2026-07-14T12:00:00.000Z",
              validationError: null,
              lastSyncedAt: null,
              createdAt: "2026-07-14T12:00:00.000Z",
              updatedAt: "2026-07-14T12:00:00.000Z",
            },
          ],
          destinations: [
            {
              id: "destination_1",
              workspaceId: "workspace_1",
              label: "Pixel cliente",
              ownerBusinessManagerId: "business_1",
              pixelId: "pixel_1",
              pixelName: "Pixel cliente",
              pageId: "page_1",
              pageName: "Pagina cliente",
              status: "configured",
              lastValidatedAt: "2026-07-14T12:00:00.000Z",
              validationError: null,
            },
          ],
          reportingAccounts: [
            {
              id: "reporting_1",
              workspaceId: "workspace_1",
              businessId: "business_1",
              businessName: "BM Cliente",
              adAccountId: "act_123",
              adAccountName: "Conta Cliente",
              currency: "BRL",
              timezoneName: "America/Sao_Paulo",
              businessConnectionId: "connection_1",
              conversionDestinationId: null,
              conversionDestinationIds: ["destination_1"],
              active: true,
              syncStatus: "error",
              lastSyncedAt: null,
              lastSyncSince: null,
              lastSyncUntil: null,
              syncError: "Permissao de Insights ausente",
            },
          ],
        },
        legacyConnected: false,
        canManage: true,
        ...actions,
      }),
    );

    expect(html).toContain("Tokens, BMs e destinos");
    expect(html).toContain("Ver estruturas");
    expect(html).toContain('class="meta-configured-structures"');
    expect(html).not.toContain(
      '<details class="meta-configured-structures" open="">',
    );
    expect(html).toContain("BM Cliente");
    expect(html).toContain("Permissao de Insights ausente");
    expect(html).toContain("Importar historico inicial");
    expect(html).toContain("Auditar roteamento");
    expect(html).toContain('aria-label="Editar BM Cliente"');
    expect(html).toContain('aria-label="Remover BM Cliente"');
  });
});
