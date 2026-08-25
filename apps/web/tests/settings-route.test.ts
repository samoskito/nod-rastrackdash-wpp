import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsPage from "../src/app/(app)/settings/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

function funnelConfigurationResponse() {
  return new Response(
    JSON.stringify({
      stages: [
        {
          eventName: "LeadSubmitted",
          label: "Conversas reais iniciadas",
          position: 1,
          visible: true,
        },
        {
          eventName: "QualifiedLead",
          label: "Oportunidade qualificada",
          position: 2,
          visible: true,
        },
        {
          eventName: "Purchase",
          label: "Vendas",
          position: 3,
          visible: false,
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function workspacePermissions(
  role: "owner" | "admin" | "member",
  delegatedManager = false,
) {
  const canManageMembers =
    role === "owner" || (role === "admin" && delegatedManager);

  return {
    canInviteMembers: canManageMembers,
    canManageMembers,
    canGrantMemberManager: role === "owner",
    canManageBilling: role === "owner",
    canManageIntegrations: role === "owner" || role === "admin",
    canManageWorkspaceSettings: role === "owner" || role === "admin",
    canTransferOwnership: role === "owner",
    canViewReports: true,
    canExportReports: true,
  };
}

function mockSettingsFetch(options: {
  rulesBody: unknown;
  rulesStatus?: number;
  providerConnections?: unknown[];
  providerRules?: unknown[];
  providerChannels?: Record<string, unknown[]>;
  workspaceStatus?: number;
  workspaceRole?: "owner" | "admin" | "member";
  workspaceCanManageMembers?: boolean;
  workspaceAccessMode?: "member" | "platform_support";
  workspacePlatformRole?: "platform_owner" | "platform_operator" | null;
  membersStatus?: number;
  authStatus?: number;
  opsAlertSettings?: unknown;
  opsAlertSettingsStatus?: number;
  opsAlertSettingsEmptyBody?: boolean;
}) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const role = options.workspaceRole ?? "owner";

    if (url.endsWith("/ops-alerts/settings")) {
      if (options.opsAlertSettingsEmptyBody) {
        return new Response(null, { status: 200 });
      }

      return new Response(JSON.stringify(options.opsAlertSettings ?? null), {
        status: options.opsAlertSettingsStatus ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/integrations/inbound-webhooks")) {
      return new Response(JSON.stringify(options.providerConnections ?? []), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const providerChannelMatch = url.match(
      /\/integrations\/inbound-webhooks\/([^/]+)\/channels$/u,
    );
    if (providerChannelMatch) {
      return new Response(
        JSON.stringify(
          options.providerChannels?.[
            decodeURIComponent(providerChannelMatch[1])
          ] ?? [],
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (url.endsWith("/conversion-rules/providers")) {
      return new Response(JSON.stringify(options.providerRules ?? []), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/conversion-rules")) {
      return new Response(JSON.stringify(options.rulesBody), {
        status: options.rulesStatus ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/conversion-rules/funnel")) {
      return funnelConfigurationResponse();
    }

    if (url.endsWith("/auth/me")) {
      return new Response(
        JSON.stringify({
          user: {
            id: "user_1",
            email: "samuel@example.com",
            name: "Samuel",
            authProvider: "email",
            emailVerifiedAt: null,
          },
          workspaces: [],
        }),
        {
          status: options.authStatus ?? 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (url.endsWith("/workspaces/current")) {
      return new Response(
        JSON.stringify({
          id: "workspace_1",
          name: "Loja Samuel",
          slug: "loja-samuel",
          role,
          accessMode: options.workspaceAccessMode ?? "member",
          platformRole: options.workspacePlatformRole ?? null,
          permissions: workspacePermissions(
            role,
            options.workspaceCanManageMembers,
          ),
        }),
        {
          status: options.workspaceStatus ?? 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (url.endsWith("/workspaces/current/members")) {
      return new Response(
        JSON.stringify([
          {
            id: "member_1",
            userId: "user_1",
            email: "samuel@example.com",
            name: "Samuel",
            role,
            canManageMembers:
              role === "admin" && options.workspaceCanManageMembers === true,
            joinedAt: "2026-07-02T10:00:00.000Z",
          },
        ]),
        {
          status: options.membersStatus ?? 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (url.endsWith("/workspaces/current/invites")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ message: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  });
}

describe("settings route", () => {
  it("renders workspace, members and invite controls from backend data", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);

      if (url.endsWith("/ops-alerts/settings")) {
        return new Response(JSON.stringify(null), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/conversion-rules")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/conversion-rules/funnel")) {
        return funnelConfigurationResponse();
      }

      if (url.endsWith("/auth/me")) {
        return new Response(
          JSON.stringify({
            user: {
              id: "user_1",
              email: "samuel@example.com",
              name: "Samuel",
              authProvider: "email",
              emailVerifiedAt: null,
            },
            workspaces: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/workspaces/current")) {
        return new Response(
          JSON.stringify({
            id: "workspace_1",
            name: "Loja Samuel",
            slug: "loja-samuel",
            role: "owner",
            permissions: workspacePermissions("owner"),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/workspaces/current/members")) {
        return new Response(
          JSON.stringify([
            {
              id: "member_1",
              userId: "user_1",
              email: "samuel@example.com",
              name: "Samuel",
              role: "owner",
              canManageMembers: false,
              joinedAt: "2026-07-02T10:00:00.000Z",
            },
            {
              id: "member_2",
              userId: "user_2",
              email: "trafego@example.com",
              name: null,
              role: "admin",
              canManageMembers: false,
              joinedAt: "2026-07-02T11:00:00.000Z",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/workspaces/current/invites")) {
        return new Response(
          JSON.stringify([
            {
              id: "invite_1",
              email: "convite@example.com",
              role: "member",
              status: "pending",
              expiresAt: "2026-07-09T10:00:00.000Z",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ message: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });

    const element = await SettingsPage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/workspaces/current",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/workspaces/current/members",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/workspaces/current/invites",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/auth/me",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).toContain("Loja Samuel");
    expect(html).toContain("loja-samuel");
    expect(html).toContain("Owner");
    expect(html).toContain("Administrador");
    expect(html).toContain("Analista");
    expect(html).toContain('name="workspaceName"');
    expect(html).toContain("Salvar nome");
    expect(html).not.toContain("Permissao atual");
    expect(html).toContain("samuel@example.com");
    expect(html).toContain("Email pendente");
    expect(html).toContain("Enviar verificacao");
    expect(html).toContain("trafego@example.com");
    expect(html).toContain("convite@example.com");
    expect(html).toContain("Pendente");
    expect(html).not.toContain("secret-token-not-for-list");
    expect(html).toContain("Convidar membro");
    expect(html).toContain("Nivel de acesso");
    expect(html).toContain("Gerenciar equipe");
    expect(html).not.toContain("3 usuarios ativos");
    expect(html).toContain("Central de configuracoes");
    expect(html).toContain("Mapa das configuracoes");
    expect(html).toContain('aria-label="Atalhos das configuracoes"');
    expect(html).toContain('href="#configuracao-conta"');
    expect(html).toContain('href="#configuracao-equipe"');
    expect(html).toContain('href="#configuracao-conversoes"');
    expect(html).toContain('href="#configuracao-operacao"');
    expect(html).toContain('href="#configuracao-trocar-cliente"');
    expect(html).toContain('id="configuracao-conta"');
    expect(html).toContain('id="configuracao-equipe"');
    expect(html).toContain('id="configuracao-conversoes"');
    expect(html).toContain('id="configuracao-operacao"');
    expect(html).toContain('id="configuracao-trocar-cliente"');
    expect(html).toContain("Trocar de cliente");
    expect(html.match(/class="settings-domain-section/g)).toHaveLength(5);
    expect(
      html.match(/class="surface-panel settings-automation-details [^"]+"/g),
    ).toHaveLength(2);
    expect(html).toMatch(/<details[^>]*id="whatsapp-triggers"[^>]*open=""/);
    expect(html).toContain("Regras por conexao e canal");
    expect(html).not.toContain("Regras antigas sem conexao");
    expect(html).not.toContain("Criar regra legada (sem conexao)");
    expect(html).toContain("Nenhuma conexao WhatsApp disponivel");
    expect(html).toContain('href="/integrations"');
    expect(html).toContain("Jornada do funil");
    expect(html).toContain("Salvar jornada");
    expect(html.match(/name="stageProduct:/g)).toHaveLength(1);
  });

  it("keeps regular admins operational without sending team controls in HTML", async () => {
    mockSettingsFetch({
      workspaceRole: "admin",
      workspaceCanManageMembers: false,
      rulesBody: [],
    });

    const element = await SettingsPage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Administrador");
    expect(html).toContain("Operacao e integracoes");
    expect(html).toContain("Apenas gestores da equipe podem convidar.");
    expect(html).not.toContain('placeholder="pessoa@empresa.com"');
    expect(html).not.toContain("member-role-form");
    expect(html).not.toContain("member-manager-toggle");
    expect(html).not.toContain('id="configuracao-trocar-cliente"');
    expect(html).not.toContain("Trocar de cliente...");
  });

  it("lets delegated admins manage the team without granting delegation", async () => {
    mockSettingsFetch({
      workspaceRole: "admin",
      workspaceCanManageMembers: true,
      rulesBody: [],
    });

    const element = await SettingsPage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Operacao, integracoes e gestao da equipe");
    expect(html).toContain('placeholder="pessoa@empresa.com"');
    expect(html).toContain("member-role-form");
    expect(html).not.toContain("member-manager-toggle");
  });

  it("counts backend conversion rules without rendering the legacy rule UI", async () => {
    mockSettingsFetch({
      rulesBody: [
        {
          id: "rule_1",
          workspaceId: "workspace_1",
          name: "Lead qualificado por palavra",
          triggerType: "keyword",
          triggerValue: "quero comprar",
          matchMode: "contains",
          eventName: "QualifiedLead",
          pixelId: null,
          defaultValueCents: 9900,
          defaultCurrency: "BRL",
          defaultContentName: "Consultoria inicial",
          defaultItems: null,
          active: true,
          createdAt: "2026-07-02T03:00:00.000Z",
          updatedAt: "2026-07-02T03:00:00.000Z",
        },
      ],
    });

    const element = await SettingsPage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/conversion-rules",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).toContain("1/1 ativos");
    expect(html).not.toContain("Lead qualificado por palavra");
    expect(html).not.toContain("Palavra-chave");
    expect(html).not.toContain("quero comprar");
    expect(html).not.toContain("Consultoria inicial");
    expect(html).not.toContain("Criar gatilho");
    expect(html).not.toContain("Nome interno opcional");
    expect(html).not.toContain("Mensagem contem palavra ou frase");
    expect(html).not.toContain("Etiqueta e aplicada");
    expect(html).not.toContain(
      '<option value="OrderDelivered">Pedido entregue</option>',
    );
    expect(html).not.toContain("Pausar");
    expect(html).not.toContain("Editar valor");
    expect(html).toContain("Regras por conexao e canal");
    expect(html).toContain("Nenhuma conexao WhatsApp disponivel");
    expect(html).toContain('href="/integrations"');
  });

  it("centralizes Umbler rules by connection without legacy adaptation controls", async () => {
    mockSettingsFetch({
      rulesBody: [
        {
          id: "legacy_purchase_1",
          workspaceId: "workspace_1",
          name: "Compra por aviso",
          triggerType: "keyword",
          triggerValue: "AVISO DE COMPRA",
          matchMode: "exact",
          eventName: "Purchase",
          pixelId: null,
          defaultValueCents: 9990,
          defaultCurrency: "BRL",
          defaultContentName: "Pedido medio",
          defaultItems: null,
          active: true,
          createdAt: "2026-07-22T12:00:00.000Z",
          updatedAt: "2026-07-22T12:00:00.000Z",
        },
      ],
      providerConnections: [
        {
          id: "connection_umbler_1",
          workspaceId: "workspace_1",
          provider: "umbler",
          displayName: "Umbler Comercial",
          parserVersion: "umbler/v1",
          parserReleaseStatus: "certified",
          status: "production",
          productionActivatedAt: "2026-07-22T12:00:00.000Z",
          lastDeliveryAt: "2026-07-22T12:00:00.000Z",
          lastSuccessfulParseAt: "2026-07-22T12:00:00.000Z",
          createdAt: "2026-07-22T12:00:00.000Z",
          updatedAt: "2026-07-22T12:00:00.000Z",
        },
      ],
      providerChannels: {
        connection_umbler_1: [
          {
            id: "channel_umbler_1",
            connectionId: "connection_umbler_1",
            organizationId: "organization_1",
            providerChannelId: "provider_channel_1",
            connectedPhone: "+5511999990001",
            channelName: "Vendas",
            status: "active",
            productionActivatedAt: "2026-07-22T12:00:00.000Z",
            firstSeenAt: "2026-07-22T12:00:00.000Z",
            lastSeenAt: "2026-07-22T12:00:00.000Z",
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
            createdAt: "2026-07-22T12:00:00.000Z",
            updatedAt: "2026-07-22T12:00:00.000Z",
          },
        ],
      },
    });

    const element = await SettingsPage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Umbler Comercial");
    expect(html).toContain("1 canal(is) descoberto(s)");
    expect(html).toContain("Regras por conexao e canal");
    expect(html).toContain('href="/integrations"');
    expect(html).not.toContain("Compra por aviso");
    expect(html).not.toContain("Adaptar para conexao");
    expect(html).not.toContain("Regras antigas sem conexao");
    expect(html).not.toContain("Criar regra legada (sem conexao)");
    expect(html).not.toContain("legacy-trigger-section");
  });

  it("stops loading WhatsApp label suggestions once the legacy builder is gone", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);

      if (url.endsWith("/ops-alerts/settings")) {
        return new Response(JSON.stringify(null), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/conversion-rules")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/conversion-rules/funnel")) {
        return funnelConfigurationResponse();
      }

      if (url.endsWith("/auth/me")) {
        return new Response(
          JSON.stringify({
            user: {
              id: "user_1",
              email: "samuel@example.com",
              name: "Samuel",
              authProvider: "email",
              emailVerifiedAt: null,
            },
            workspaces: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/workspaces/current")) {
        return new Response(
          JSON.stringify({
            id: "workspace_1",
            name: "Loja Samuel",
            slug: "loja-samuel",
            role: "owner",
            permissions: workspacePermissions("owner"),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/workspaces/current/members")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/workspaces/current/invites")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/integrations/whatsapp/instances")) {
        return new Response(
          JSON.stringify([
            {
              id: "wpp_active",
              name: "Vendas",
              provider: "uazapi",
              billingStatus: "active",
              providerInstanceId: "provider_instance_1",
              checkoutUrl: null,
              createdAt: "2026-07-02T03:00:00.000Z",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/integrations/whatsapp/instances/wpp_active/labels")) {
        return new Response(
          JSON.stringify([
            {
              id: "label_uuid_1",
              name: "Venda fechada",
              colorHex: "#fed428",
              labelId: "10",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ message: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });

    const element = await SettingsPage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      "http://localhost:3333/integrations/whatsapp/instances",
      expect.anything(),
    );
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      "http://localhost:3333/integrations/whatsapp/instances/wpp_active/labels",
      expect.anything(),
    );
    expect(html).not.toContain("Venda fechada");
    expect(html).not.toContain('id="whatsapp-label-options"');
  });

  it("hides conversion rule mutation controls for workspace members", async () => {
    mockSettingsFetch({
      workspaceRole: "member",
      rulesBody: [
        {
          id: "rule_1",
          workspaceId: "workspace_1",
          name: "Lead qualificado por palavra",
          triggerType: "keyword",
          triggerValue: "quero comprar",
          matchMode: "contains",
          eventName: "QualifiedLead",
          pixelId: null,
          active: true,
          createdAt: "2026-07-02T03:00:00.000Z",
          updatedAt: "2026-07-02T03:00:00.000Z",
        },
      ],
    });

    const element = await SettingsPage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).not.toContain("Lead qualificado por palavra");
    expect(html).not.toContain("Sem permissao para editar regras");
    expect(html).not.toContain("Criar gatilho");
    expect(html).not.toContain("Criar regra legada (sem conexao)");
    expect(html).not.toContain("Pausar");
    expect(html).toContain("Regras por conexao e canal");
  });

  it("lets the platform owner manage the team and resend owner access in support mode", async () => {
    mockSettingsFetch({
      workspaceAccessMode: "platform_support",
      workspacePlatformRole: "platform_owner",
      workspaceRole: "owner",
      rulesBody: [],
    });

    const element = await SettingsPage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Suporte da plataforma");
    expect(html).toContain("Acesso interno ao workspace do cliente");
    expect(html).toContain('placeholder="pessoa@empresa.com"');
    expect(html).toContain("Reenviar e-mail de acesso");
    expect(html).not.toContain("Slug loja-samuel com papel owner");
  });

  it("keeps platform operators read-only for customer team management", async () => {
    mockSettingsFetch({
      workspaceAccessMode: "platform_support",
      workspacePlatformRole: "platform_operator",
      workspaceRole: "owner",
      rulesBody: [],
    });

    const element = await SettingsPage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Suporte da plataforma");
    expect(html).toContain("Apenas gestores da equipe podem convidar.");
    expect(html).not.toContain('placeholder="pessoa@empresa.com"');
    expect(html).not.toContain("Reenviar e-mail de acesso");
  });

  it("renders an unavailable state without demo rules when conversion rules fail", async () => {
    mockSettingsFetch({
      rulesBody: { message: "unavailable" },
      rulesStatus: 503,
      workspaceStatus: 503,
      membersStatus: 503,
    });

    const element = await SettingsPage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("API indisponivel");
    expect(html).toContain("Regras indisponiveis");
    expect(html).not.toContain("Nao foi possivel carregar regras");
    expect(html).toMatch(
      /<details[^>]*class="[^"]*conversion-rules-panel[^"]*"[^>]*open/,
    );
    expect(html).not.toContain("Novo lead");
    expect(html).not.toContain("Compra confirmada");
    expect(html).not.toContain("Venda fechada");
  });

  it("renders an empty state without demo rules when no conversion rules exist", async () => {
    mockSettingsFetch({ rulesBody: [] });

    const element = await SettingsPage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Nenhuma conexao WhatsApp disponivel");
    expect(html).toContain('href="/integrations"');
    expect(html).not.toContain("Nenhuma regra configurada");
    expect(html).not.toContain("Novo lead");
    expect(html).not.toContain("Compra confirmada");
    expect(html).not.toContain("Venda fechada");
  });

  it("renders configured ops alert settings for an owner", async () => {
    mockSettingsFetch({
      rulesBody: [],
      opsAlertSettings: {
        id: "ops_alert_1",
        workspaceId: "workspace_1",
        enabled: true,
        alertPhonesE164: ["5511999999999", "5511888888888"],
        alertPhoneE164: "5511999999999",
        disconnectAlerts: true,
        webhookSilenceAlerts: false,
        silenceThresholdHours: 48,
        debounceHours: 3,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    });

    const element = await SettingsPage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Alertas WhatsApp");
    expect(html).toContain("Ativar alertas");
    expect(html).toContain('name="workspaceId"');
    expect(html).toContain('value="workspace_1"');
    expect(html).toContain('value="5511999999999"');
    expect(html).toContain('value="5511888888888"');
    expect(html).toContain('name="alertPhones"');
    expect(html).toMatch(
      /name="enabled"[^>]*checked|checked[^>]*name="enabled"/,
    );
    expect(html).toMatch(
      /name="disconnectAlerts"[^>]*checked|checked[^>]*name="disconnectAlerts"/,
    );
    expect(html).toContain('name="webhookSilenceAlerts"');
    expect(html).not.toMatch(
      /name="webhookSilenceAlerts"[^>]*checked|checked[^>]*name="webhookSilenceAlerts"/,
    );
    expect(html).toContain('name="silenceThresholdHours"');
    expect(html).toContain('value="48"');
    expect(html).toContain('name="debounceHours"');
    expect(html).toContain('value="3"');
    expect(html).toContain("Salvar alertas");
    expect(html).toContain("Ativado");
  });

  it("shows defaults when ops alert settings were never configured", async () => {
    mockSettingsFetch({ rulesBody: [], opsAlertSettings: null });

    const element = await SettingsPage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).not.toMatch(
      /name="enabled"[^>]*checked|checked[^>]*name="enabled"/,
    );
    expect(html).toMatch(
      /name="disconnectAlerts"[^>]*checked|checked[^>]*name="disconnectAlerts"/,
    );
    expect(html).toMatch(
      /name="webhookSilenceAlerts"[^>]*checked|checked[^>]*name="webhookSilenceAlerts"/,
    );
    expect(html).toContain('name="silenceThresholdHours"');
    expect(html).toContain('value="24"');
    expect(html).toContain('name="debounceHours"');
    expect(html).toContain('value="6"');
    expect(html).toContain("Desativado");
    expect(html).toContain("Nenhum telefone cadastrado");
    expect(html).not.toContain('name="alertPhones"');
  });

  it("renders the ops alert form when a legacy API returns an empty body", async () => {
    mockSettingsFetch({
      rulesBody: [],
      opsAlertSettingsEmptyBody: true,
    });

    const element = await SettingsPage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain('name="workspaceId"');
    expect(html).toContain('value="workspace_1"');
    expect(html).toContain("Salvar alertas");
    expect(html).toContain("Desativado");
    expect(html).not.toContain(
      "Nao foi possivel carregar as configuracoes de alerta.",
    );
  });

  it("keeps ops alert settings read-only for workspace members without loading the endpoint", async () => {
    mockSettingsFetch({ rulesBody: [], workspaceRole: "member" });

    const element = await SettingsPage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain(
      "Sem permissao para gerenciar alertas operacionais.",
    );
    expect(html).not.toContain("Salvar alertas");
    expect(html).not.toContain('name="alertPhones"');
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/ops-alerts/settings"),
      expect.anything(),
    );
  });
});
