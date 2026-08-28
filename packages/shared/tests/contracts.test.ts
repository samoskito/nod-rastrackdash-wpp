import { describe, expect, it } from "vitest";
import {
  adReportOverviewSchema,
  adSetReportOverviewSchema,
  backofficeWorkspaceCreateResultSchema,
  canManageIntegrations,
  canManageWorkspaceBilling,
  canViewReports,
  campaignReportRowSchema,
  clientWorkspaceProvisionInputSchema,
  clientOwnerActivationLinkResultSchema,
  clientOwnerSetPasswordInputSchema,
  clientOwnerSetPasswordResultSchema,
  backofficeClientWorkspaceSchema,
  clientNavigation,
  conversionAuditEventDetailSchema,
  conversionAuditEventSchema,
  conversionAuditOverviewSchema,
  conversionEventErrorCodeSchema,
  conversionEventLogStatusSchema,
  conversionEventNameSchema,
  conversionEventTestInputSchema,
  conversionRuleCreateInputSchema,
  conversionRuleSchema,
  conversionRuleUpdateInputSchema,
  conversionTriggerEvaluationInputSchema,
  conversionEventDisplayLabel,
  funnelConfigurationUpdateInputSchema,
  googleOAuthCallbackQuerySchema,
  googleOAuthCallbackResultSchema,
  googleOAuthStartSchema,
  googleOAuthStartResultSchema,
  emailVerificationConfirmInputSchema,
  emailVerificationConfirmSchema,
  emailVerificationStartSchema,
  externalConnectionTestResultSchema,
  externalConnectorReconciliationSchema,
  externalDataConnectorCreateInputSchema,
  externalDataConnectorSchema,
  externalDataConnectorUpdateInputSchema,
  currentWorkspaceSchema,
  diagnosticConversionEventTestInputSchema,
  diagnosticEventCreateSchema,
  diagnosticEventDetailSchema,
  diagnosticEventListQuerySchema,
  diagnosticRetryInputSchema,
  diagnosticRetryResultSchema,
  diagnosticWebhookPayloadSchema,
  funnelMetricKeys,
  integrationHealthSchema,
  integrationHealthSummarySchema,
  integrationPipelineOverviewSchema,
  metaConversionDestinationSchema,
  metaBudgetUpdateInputSchema,
  metaCapiTokenInputSchema,
  metaCapiTokenStatusSchema,
  metaEntityStatusUpdateInputSchema,
  metaWhatsappOverrideInputSchema,
  metaAssetSelectionInputSchema,
  metaAssetsSchema,
  metaReportingAccountSchema,
  metaStructureReportSchema,
  leadListItemSchema,
  leadDetailSchema,
  leadListQuerySchema,
  metaConnectionSchema,
  metaManualBusinessConnectionInputSchema,
  metaManualBusinessConnectionRemovalInputSchema,
  metaManualCredentialInputSchema,
  metaOAuthCallbackQuerySchema,
  metaOAuthCallbackResultSchema,
  metaOAuthDisconnectInputSchema,
  metaOAuthDisconnectResultSchema,
  integrationStartActionSchema,
  loginSchema,
  passwordResetConfirmInputSchema,
  passwordResetConfirmSchema,
  passwordResetRequestInputSchema,
  passwordResetRequestSchema,
  registerSchema,
  reportFiltersSchema,
  backofficePaymentChargeListSchema,
  backofficePaymentChargeSchema,
  backofficeSubscriptionPlanCreateInputSchema,
  backofficeSubscriptionPlanSchema,
  backofficeSubscriptionPlanUpdateInputSchema,
  splitReceiverCreateInputSchema,
  splitReceiverSchema,
  splitReceiverUpdateInputSchema,
  workspaceInviteInputSchema,
  workspaceUpdateInputSchema,
  workspaceBillingListSchema,
  workspaceBillingSchema,
  workspaceOperationalStatusUpdateInputSchema,
  workspaceBillingUpdateInputSchema,
  workspaceInviteAcceptInputSchema,
  workspaceInviteAcceptSchema,
  workspaceInviteInspectionSchema,
  workspaceInviteNewUserAcceptInputSchema,
  workspaceInviteSchema,
  workspaceMemberSchema,
  workspaceListSchema,
  workspaceSubscriptionSummarySchema,
  whatsappInstanceCheckoutInputSchema,
  whatsappInstanceCheckoutSchema,
  whatsappInstanceConnectionSchema,
  whatsappInstanceSummarySchema,
  whatsappInstanceQuoteSchema,
  whatsappConnectionCreateInputSchema,
  whatsappConnectionCredentialsUpdateSchema,
  whatsappConnectionTestResultSchema,
  whatsappConnectionUpdateInputSchema,
  whatsappConnectionWebhookTokenRotateResultSchema,
} from "../src";

describe("shared contracts", () => {
  const approvedReportMetrics = {
    spendCents: 120000,
    metaConversationsStarted: 100,
    costPerMetaConversationCents: 1200,
    realConversations: 80,
    costPerRealConversationCents: 1500,
    organicLeads: 10,
    totalReceived: 90,
    trackingRate: 0.8889,
    qualifiedLead: 12,
    costPerQualifiedLeadCents: 10000,
    purchases: 5,
    firstPurchases: 3,
    repurchases: 2,
    costPerPurchaseCents: 24000,
    trafficRevenueCents: 450000,
    organicRevenueCents: 50000,
    totalRevenueCents: 500000,
    firstPurchaseRevenueCents: 300000,
    repurchaseRevenueCents: 200000,
    roasAcquisition: 3.75,
    roasWithRepurchase: 4.1667,
    funnelSteps: [
      {
        key: "real_conversations",
        label: "Conversas reais iniciadas",
        value: 80,
        costCents: 1500,
      },
      {
        key: "qualified_lead",
        label: "Lead qualificado",
        value: 12,
        costCents: 10000,
      },
      {
        key: "purchase",
        label: "Compras",
        value: 5,
        costCents: 24000,
      },
      {
        key: "first_purchase",
        label: "Primeira compra",
        value: 3,
      },
      {
        key: "repurchase",
        label: "Recompra",
        value: 2,
      },
    ],
  };

  it("does not include Clientes in client navigation", () => {
    expect(clientNavigation.map((item) => item.label)).not.toContain(
      "Clientes",
    );
  });

  it("keeps owner/admin/member permission basics", () => {
    expect(canManageWorkspaceBilling("owner")).toBe(true);
    expect(canManageWorkspaceBilling("admin")).toBe(false);
    expect(canManageIntegrations("admin")).toBe(true);
    expect(canViewReports("member")).toBe(true);
  });

  it("returns role and capabilities with every selectable workspace", () => {
    const workspaces = workspaceListSchema.parse([
      {
        id: "workspace_a",
        name: "Empresa A",
        slug: "empresa-a",
        role: "admin",
        operationalStatus: "active",
        permissions: {
          canInviteMembers: false,
          canManageMembers: false,
          canGrantMemberManager: false,
          canManageBilling: false,
          canManageIntegrations: true,
          canManageWorkspaceSettings: true,
          canTransferOwnership: false,
          canViewReports: true,
          canExportReports: true,
        },
      },
    ]);

    expect(workspaces[0]?.permissions.canManageBilling).toBe(false);
    expect(() =>
      workspaceListSchema.parse([
        {
          id: "workspace_a",
          name: "Empresa A",
          slug: "empresa-a",
          role: "admin",
          operationalStatus: "active",
        },
      ]),
    ).toThrow();
  });

  it("normalizes private provisioning and strips the legacy owner password", () => {
    const parsed = clientWorkspaceProvisionInputSchema.parse({
      workspaceName: "Empresa B",
      ownerName: "Responsavel Existente",
      ownerEmail: "OWNER@EMPRESA.COM",
      ownerPassword: "",
    });

    expect(parsed.ownerEmail).toBe("owner@empresa.com");
    expect(parsed).not.toHaveProperty("ownerPassword");
  });

  it("validates access recovery contracts without leaking secrets", () => {
    const link = clientOwnerActivationLinkResultSchema.parse({
      ok: true,
      mode: "activation",
      delivery: "link_only",
      activationUrl: "https://wpp.rastrack.app/login/activate?token=abc123",
      expiresAt: "2026-08-24T03:00:00.000Z",
      emailAttempted: false,
    });
    const passwordSet = clientOwnerSetPasswordResultSchema.parse({
      ok: true,
      userId: "user_owner",
      passwordSet: true,
    });
    const workspace = backofficeClientWorkspaceSchema.parse({
      id: "workspace_1",
      name: "Empresa Cliente",
      slug: "empresa-cliente",
      operationalStatus: "active",
      createdAt: "2026-08-17T03:00:00.000Z",
      owners: [
        {
          id: "user_owner",
          name: "Owner",
          email: "owner@empresa.com",
          hasPassword: false,
        },
      ],
      connectorCount: 0,
    });

    expect(link.activationUrl).toContain("/login/activate?token=");
    expect(passwordSet.passwordSet).toBe(true);
    expect(workspace.owners[0]?.hasPassword).toBe(false);
    expect(link).not.toHaveProperty("token");
    expect(passwordSet).not.toHaveProperty("password");
    expect(() =>
      clientOwnerSetPasswordInputSchema.parse({
        password: "strong-password",
        confirmPassword: "other-password",
        confirm: true,
      }),
    ).toThrow();
    expect(() =>
      clientOwnerSetPasswordInputSchema.parse({
        password: "strong-password",
        confirmPassword: "strong-password",
      }),
    ).toThrow();
    expect(() =>
      clientOwnerSetPasswordInputSchema.parse({
        password: "strong-password",
        confirmPassword: "strong-password",
        confirm: true,
        extra: true,
      }),
    ).toThrow();
  });

  it("supports an explicit manual activation-link requirement after workspace creation", () => {
    const result = backofficeWorkspaceCreateResultSchema.parse({
      id: "workspace_1",
      name: "Empresa Cliente",
      slug: "empresa-cliente",
      operationalStatus: "active",
      createdAt: "2026-08-26T03:00:00.000Z",
      responsible: {
        id: "user_owner",
        name: "Owner",
        email: "owner@empresa.com",
        role: "owner",
        status: "pending_activation",
      },
      reusedExistingUser: false,
      deliveryStatus: "manual_link_required",
    });

    expect(result.deliveryStatus).toBe("manual_link_required");
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("activationUrl");
  });

  it("validates campaign report rows", () => {
    const parsed = campaignReportRowSchema.parse({
      id: "cmp_1",
      name: "Black Friday WhatsApp",
      status: "active",
      businessId: "business_1",
      businessName: "BM Principal",
      adAccountId: "act_123",
      adAccountName: "Conta WhatsApp",
      whatsappClassification: "auto_whatsapp",
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
      budget: {
        owner: "campaign",
        type: "daily",
        amountCents: 49500,
        editable: true,
      },
      ...approvedReportMetrics,
      leadSubmitted: 30,
      purchase: 3,
      roas: 4.2,
    });

    expect(parsed.purchases).toBe(5);
    expect(parsed.firstPurchases).toBe(3);
    expect(parsed.repurchases).toBe(2);
    expect(parsed.totalRevenueCents).toBe(500000);
    expect(parsed.budget?.amountCents).toBe(49500);
    expect(parsed.funnelSteps.map((step) => step.key)).toEqual([
      "real_conversations",
      "qualified_lead",
      "purchase",
      "first_purchase",
      "repurchase",
    ]);
    expect("leadSubmitted" in parsed).toBe(false);
    expect("purchase" in parsed).toBe(false);
    expect("roas" in parsed).toBe(false);
  });

  it("validates campaign report rows without Meta account metadata", () => {
    const parsed = campaignReportRowSchema.parse({
      id: "cmp_1",
      name: "Black Friday WhatsApp",
      status: "active",
      ...approvedReportMetrics,
    });

    expect(parsed.purchases).toBe(5);
    expect(parsed.whatsappClassification).toBeUndefined();
  });

  it("exports approved dynamic funnel metric keys", () => {
    expect(funnelMetricKeys).toEqual([
      "real_conversations",
      "qualified_lead",
      "purchase",
      "first_purchase",
      "repurchase",
    ]);
  });

  it("validates ordered funnel configuration with human event labels", () => {
    const configuration = funnelConfigurationUpdateInputSchema.parse({
      stages: [
        {
          eventName: "OrderDelivered",
          label: "Pedidos entregues",
          position: 1,
          visible: true,
        },
        {
          eventName: "Purchase",
          label: "Vendas",
          position: 2,
          visible: false,
        },
      ],
    });

    expect(configuration.stages[0]?.eventName).toBe("OrderDelivered");
    expect(conversionEventDisplayLabel("OrderDelivered")).toBe(
      "Pedido entregue",
    );
    expect(conversionEventDisplayLabel("CustomEvent")).toBe("CustomEvent");
  });

  it("validates Meta conversion destination and reporting accounts", () => {
    const destination = metaConversionDestinationSchema.parse({
      workspaceId: "workspace_1",
      pixelId: "pixel_1",
      pixelName: "Pixel Principal",
      pageId: "page_1",
      pageName: "Pagina Principal",
      status: "configured",
      lastValidatedAt: "2026-07-09T12:00:00.000Z",
      validationError: null,
    });
    const account = metaReportingAccountSchema.parse({
      id: "reporting_1",
      workspaceId: "workspace_1",
      businessId: "business_1",
      businessName: "BM Principal",
      adAccountId: "act_123",
      adAccountName: "Conta WhatsApp",
      currency: "BRL",
      timezoneName: "America/Sao_Paulo",
      active: true,
      syncStatus: "synced",
      lastSyncedAt: "2026-07-09T12:00:00.000Z",
      syncError: null,
    });

    expect(destination.pageId).toBe("page_1");
    expect(account.active).toBe(true);
  });

  it("validates manual Meta credentials and destination choices", () => {
    const credential = metaManualCredentialInputSchema.parse({
      label: " Token BM Principal ",
      accessToken: "EAAB-permanent-system-user-token",
    });
    const directDestination = metaManualBusinessConnectionInputSchema.parse({
      credentialId: "credential_1",
      businessManagerId: "business_1",
      businessManagerName: "BM Principal",
      adAccountIds: ["act_1"],
      destination: {
        label: "Destino principal",
        pixelId: "pixel_1",
        pageId: "page_1",
      },
    });
    const sharedDestination = metaManualBusinessConnectionInputSchema.parse({
      credentialId: "credential_2",
      businessManagerId: "business_2",
      businessManagerName: "BM Anunciante",
      adAccountIds: ["act_2"],
      destination: { existingDestinationId: "destination_matrix" },
    });

    expect(credential.label).toBe("Token BM Principal");
    expect(directDestination.destination.pixelId).toBe("pixel_1");
    expect(sharedDestination.destination.existingDestinationId).toBe(
      "destination_matrix",
    );
    expect(
      metaManualBusinessConnectionRemovalInputSchema.parse({
        businessManagerId: " business_1 ",
      }),
    ).toEqual({ businessManagerId: "business_1" });
    expect(() =>
      metaManualBusinessConnectionRemovalInputSchema.parse({
        businessManagerId: " ",
      }),
    ).toThrow();
    expect(() =>
      metaManualBusinessConnectionInputSchema.parse({
        credentialId: "credential_1",
        businessManagerId: "business_1",
        businessManagerName: "BM Principal",
        adAccountIds: ["act_1"],
        destination: { pixelId: "pixel_without_page" },
      }),
    ).toThrow();
    expect(() =>
      metaManualCredentialInputSchema.parse({
        label: "Token curto",
        accessToken: "too-short",
      }),
    ).toThrow();
  });

  it("requires the exact workspace and confirmation for OAuth disconnect", () => {
    const input = metaOAuthDisconnectInputSchema.parse({
      expectedWorkspaceId: "workspace_1",
      confirmation: "DESCONECTAR META",
    });
    const result = metaOAuthDisconnectResultSchema.parse({
      workspaceId: "workspace_1",
      status: "not_connected",
      disconnectedAt: "2026-07-15T04:30:00.000Z",
      preserved: {
        assetSnapshots: 2,
        reportingAccounts: 1,
        conversionDestinations: 1,
      },
    });

    expect(input.expectedWorkspaceId).toBe("workspace_1");
    expect(result.preserved.assetSnapshots).toBe(2);
    expect(() =>
      metaOAuthDisconnectInputSchema.parse({
        expectedWorkspaceId: "workspace_1",
        confirmation: "desconectar",
      }),
    ).toThrow();
  });

  it("validates WhatsApp classification filters in reports", () => {
    const row = campaignReportRowSchema.parse({
      id: "cmp_1",
      name: "Campanha WhatsApp",
      status: "active",
      businessId: "business_1",
      businessName: "BM Principal",
      adAccountId: "act_123",
      adAccountName: "Conta WhatsApp",
      whatsappClassification: "auto_whatsapp",
      ...approvedReportMetrics,
    });

    expect(row.whatsappClassification).toBe("auto_whatsapp");
    expect(row.trackingRate).toBe(0.8889);
  });

  it("validates manual WhatsApp classification override input", () => {
    const include = metaWhatsappOverrideInputSchema.parse({
      level: "campaign",
      id: " cmp_1 ",
      override: "manual_include",
    });
    const reset = metaWhatsappOverrideInputSchema.parse({
      level: "ad",
      id: "ad_1",
      override: null,
    });

    expect(include.id).toBe("cmp_1");
    expect(include.override).toBe("manual_include");
    expect(reset.override).toBeNull();
    expect(() =>
      metaWhatsappOverrideInputSchema.parse({
        level: "business",
        id: "business_1",
        override: "manual_include",
      }),
    ).toThrow();
    expect(() =>
      metaWhatsappOverrideInputSchema.parse({
        level: "campaign",
        id: "   ",
        override: "manual_include",
      }),
    ).toThrow();
  });

  it("defaults report filters and accepts delivery with selected entities", () => {
    const filters = reportFiltersSchema.parse({});
    const narrowed = reportFiltersSchema.parse({
      delivery: "had_delivery",
      selectedEntityIds: ["cmp_1", "cmp_2"],
    });

    expect(filters.whatsappClassification).toBe("whatsapp");
    expect(filters.delivery).toBe("all");
    expect(narrowed).toMatchObject({
      delivery: "had_delivery",
      selectedEntityIds: ["cmp_1", "cmp_2"],
    });
  });

  it("validates controlled Meta status and budget operations", () => {
    const status = metaEntityStatusUpdateInputSchema.parse({
      level: "ad",
      id: " ad_1 ",
      expectedStatus: "PAUSED",
      targetStatus: "ACTIVE",
    });
    const budget = metaBudgetUpdateInputSchema.parse({
      level: "adset",
      id: "adset_1",
      budgetType: "daily",
      expectedBudgetCents: 45000,
      budgetCents: 65000,
    });

    expect(status.id).toBe("ad_1");
    expect(status.targetStatus).toBe("ACTIVE");
    expect(budget.budgetCents).toBe(65000);
    expect(() =>
      metaBudgetUpdateInputSchema.parse({
        level: "ad",
        id: "ad_1",
        budgetType: "daily",
        expectedBudgetCents: 0,
        budgetCents: 10000,
      }),
    ).toThrow();
    expect(() =>
      metaBudgetUpdateInputSchema.parse({
        level: "campaign",
        id: "cmp_1",
        budgetType: "daily",
        expectedBudgetCents: 45000,
        budgetCents: 0,
      }),
    ).toThrow();
  });

  it("validates ad set and ad performance report overviews", () => {
    const adSets = adSetReportOverviewSchema.parse({
      workspaceId: "workspace_1",
      rangeLabel: "2026-07-01 a 2026-07-02",
      adSets: [
        {
          id: "adset_1",
          campaignId: "cmp_1",
          campaignName: "Black Friday WhatsApp",
          name: "Publico quente",
          status: "active",
          businessId: "business_1",
          businessName: "BM Principal",
          adAccountId: "act_123",
          adAccountName: "Conta WhatsApp",
          whatsappClassification: "auto_whatsapp",
          configuredStatus: "ACTIVE",
          effectiveStatus: "ACTIVE",
          budget: {
            owner: "adset",
            type: "daily",
            amountCents: 45000,
            editable: true,
          },
          ...approvedReportMetrics,
        },
      ],
    });
    const ads = adReportOverviewSchema.parse({
      workspaceId: "workspace_1",
      rangeLabel: "2026-07-01 a 2026-07-02",
      ads: [
        {
          id: "ad_1",
          campaignId: "cmp_1",
          campaignName: "Black Friday WhatsApp",
          adSetId: "adset_1",
          adSetName: "Publico quente",
          name: "Criativo WhatsApp",
          status: "active",
          businessId: "business_1",
          businessName: "BM Principal",
          adAccountId: "act_123",
          adAccountName: "Conta WhatsApp",
          whatsappClassification: "creative_whatsapp",
          configuredStatus: "ACTIVE",
          effectiveStatus: "ACTIVE",
          thumbnailUrl: "https://cdn.example.test/ad-1.jpg",
          previewUrl: "https://cdn.example.test/ad-1-large.jpg",
          ...approvedReportMetrics,
        },
      ],
    });

    expect(adSets.adSets[0]?.campaignName).toBe("Black Friday WhatsApp");
    expect(adSets.adSets[0]?.funnelSteps[0]?.label).toBe(
      "Conversas reais iniciadas",
    );
    expect(adSets.adSets[0]?.budget?.owner).toBe("adset");
    expect(ads.ads[0]?.adSetName).toBe("Publico quente");
    expect(ads.ads[0]?.thumbnailUrl).toBe("https://cdn.example.test/ad-1.jpg");
    expect(ads.ads[0]?.previewUrl).toBe(
      "https://cdn.example.test/ad-1-large.jpg",
    );
    expect(ads.ads[0]?.roasWithRepurchase).toBe(4.1667);
  });

  it("validates Meta campaign/adset/ad structure reports", () => {
    const parsed = metaStructureReportSchema.parse({
      workspaceId: "workspace_1",
      campaigns: [
        {
          id: "cmp_1",
          name: "Black Friday WhatsApp",
          status: "ACTIVE",
          effectiveStatus: "ACTIVE",
          objective: "OUTCOME_SALES",
          adSets: [
            {
              id: "adset_1",
              name: "Publico quente",
              status: "ACTIVE",
              effectiveStatus: "ACTIVE",
              ads: [
                {
                  id: "ad_1",
                  name: "Criativo WhatsApp",
                  status: "ACTIVE",
                  effectiveStatus: "ACTIVE",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(parsed.campaigns[0]?.adSets[0]?.ads[0]?.name).toBe(
      "Criativo WhatsApp",
    );
  });

  it("validates integration health payloads", () => {
    const parsed = integrationHealthSchema.parse({
      provider: "meta",
      status: "disconnected",
      checkedAt: "2026-07-01T21:30:00.000Z",
      message: "Missing credentials",
    });

    expect(parsed.provider).toBe("meta");
    expect(parsed.status).toBe("disconnected");
  });

  it("rejects invalid integration health payloads", () => {
    expect(() =>
      integrationHealthSchema.parse({
        provider: "stripe",
        status: "online",
        checkedAt: "not-a-date",
      }),
    ).toThrow();
  });

  it("validates integration health summaries and start actions", () => {
    const summary = integrationHealthSummarySchema.parse({
      checkedAt: "2026-07-02T03:00:00.000Z",
      providers: [
        {
          provider: "meta",
          status: "disconnected",
          checkedAt: "2026-07-02T03:00:00.000Z",
          message: "Missing META_APP_ID or META_APP_SECRET",
        },
      ],
    });
    const action = integrationStartActionSchema.parse({
      provider: "meta",
      action: "configure_env",
      label: "Configurar app Meta",
      missingEnv: ["META_APP_ID", "META_APP_SECRET"],
    });

    expect(summary.providers[0]?.provider).toBe("meta");
    expect(action.missingEnv).toEqual(["META_APP_ID", "META_APP_SECRET"]);
  });

  it("validates integration pipeline overview contracts", () => {
    const overview = integrationPipelineOverviewSchema.parse({
      workspaceId: "workspace_1",
      rangeLabel: "Ultimos 7 dias",
      stages: [
        {
          key: "webhook",
          label: "Webhook",
          value: 12,
          detail: "Webhooks NOD API recebidos",
        },
        {
          key: "meta_sent",
          label: "Meta ACK",
          value: 7,
          detail: "Eventos enviados para Meta",
        },
      ],
    });

    expect(overview.stages[0]?.value).toBe(12);
    expect(overview.stages[1]?.key).toBe("meta_sent");
  });

  it("validates login payloads and normalizes email", () => {
    const parsed = loginSchema.parse({
      email: "  OWNER@WPPTRACK.COM  ",
      password: "secret123",
    });

    expect(parsed).toEqual({
      email: "owner@wpptrack.com",
      password: "secret123",
    });
  });

  it("rejects short login passwords", () => {
    expect(() =>
      loginSchema.parse({
        email: "owner@wpptrack.com",
        password: "short",
      }),
    ).toThrow();
  });

  it("validates register payloads", () => {
    const parsed = registerSchema.parse({
      name: "Samuel",
      email: "SAMUEL@WPPTRACK.COM",
      password: "strong-password",
      workspaceName: "WppTrack",
    });

    expect(parsed.email).toBe("samuel@wpptrack.com");
    expect(parsed.workspaceName).toBe("WppTrack");
  });

  it("rejects register payloads without a workspace name", () => {
    expect(() =>
      registerSchema.parse({
        name: "S",
        email: "samuel@wpptrack.com",
        password: "strong-password",
      }),
    ).toThrow();
  });

  it("validates google oauth start payloads without requiring oauth wiring", () => {
    const parsed = googleOAuthStartSchema.parse({
      redirectTo: "/dashboard",
    });
    const result = googleOAuthStartResultSchema.parse({
      provider: "google",
      action: "redirect",
      authorizationUrl:
        "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc",
      missingEnv: [],
      state: "state-token",
    });

    expect(parsed.redirectTo).toBe("/dashboard");
    expect(result.action).toBe("redirect");
  });

  it("validates google oauth callback scaffolding payloads", () => {
    const query = googleOAuthCallbackQuerySchema.parse({
      code: "oauth-code",
      state: "state-token",
    });
    const result = googleOAuthCallbackResultSchema.parse({
      provider: "google",
      action: "exchange_pending",
      missingEnv: [],
      codeReceived: true,
      redirectTo: "/overview",
    });

    expect(query.code).toBe("oauth-code");
    expect(result.action).toBe("exchange_pending");
  });

  it("validates completed google oauth callback payloads", () => {
    const result = googleOAuthCallbackResultSchema.parse({
      provider: "google",
      action: "authenticated",
      missingEnv: [],
      codeReceived: true,
      redirectTo: "/overview",
    });

    expect(result.action).toBe("authenticated");
  });

  it("validates Meta OAuth callback and sanitized exchange result payloads", () => {
    const query = metaOAuthCallbackQuerySchema.parse({
      code: "meta-code",
      state: "workspace-state",
    });
    const result = metaOAuthCallbackResultSchema.parse({
      provider: "meta",
      status: "connected",
      tokenType: "bearer",
      expiresInSeconds: 5183944,
      scopes: ["ads_read", "business_management"],
      message: "Meta OAuth conectado",
    });

    expect(query.code).toBe("meta-code");
    expect(
      metaOAuthCallbackQuerySchema.safeParse({ code: "meta-code" }).success,
    ).toBe(false);
    expect(result.status).toBe("connected");
    expect("accessToken" in result).toBe(false);
  });

  it("validates Meta connection status payloads without exposing tokens", () => {
    const connection = metaConnectionSchema.parse({
      workspaceId: "workspace_1",
      status: "connected",
      tokenType: "bearer",
      scopes: ["ads_read", "business_management"],
      expiresAt: "2026-09-01T03:00:00.000Z",
      connectedAt: "2026-07-02T03:00:00.000Z",
      selectedBusinessId: null,
      selectedAdAccountId: null,
      selectedPixelId: "pixel_1",
    });

    expect(connection.status).toBe("connected");
    expect(JSON.stringify(connection)).not.toContain("accessToken");
  });

  it("validates Meta assets and selected BM/account/pixel payloads", () => {
    const assets = metaAssetsSchema.parse({
      workspaceId: "workspace_1",
      status: "connected",
      businesses: [
        {
          id: "business_1",
          name: "BM Principal",
          verificationStatus: "verified",
        },
      ],
      adAccounts: [
        {
          id: "act_123",
          businessId: "business_1",
          name: "Conta WhatsApp",
          accountStatus: "1",
          currency: "BRL",
          timezoneName: "America/Sao_Paulo",
        },
      ],
      pixels: [
        {
          id: "pixel_1",
          businessId: "business_1",
          name: "Pixel Loja",
          code: "1234567890",
        },
      ],
      pages: [
        {
          id: "page_1",
          businessId: "business_1",
          name: "Pagina Principal",
        },
      ],
      conversionDestination: {
        workspaceId: "workspace_1",
        pixelId: "pixel_1",
        pixelName: "Pixel Loja",
        pageId: "page_1",
        pageName: "Pagina Principal",
        status: "configured",
        lastValidatedAt: "2026-07-02T12:00:00.000Z",
        validationError: null,
      },
      reportingAccounts: [
        {
          id: "reporting_1",
          workspaceId: "workspace_1",
          businessId: "business_1",
          businessName: "BM Principal",
          adAccountId: "act_123",
          adAccountName: "Conta WhatsApp",
          currency: "BRL",
          timezoneName: "America/Sao_Paulo",
          active: true,
          syncStatus: "synced",
          lastSyncedAt: "2026-07-02T12:00:00.000Z",
          syncError: null,
        },
      ],
      selection: {
        businessId: "business_1",
        adAccountId: "act_123",
        pixelId: "pixel_1",
      },
      lastSyncedAt: "2026-07-02T12:00:00.000Z",
      syncError: null,
    });
    const input = metaAssetSelectionInputSchema.parse({
      businessId: "business_1",
      adAccountId: "act_123",
      pixelId: "pixel_1",
    });

    expect(assets.businesses[0]?.name).toBe("BM Principal");
    expect(assets.adAccounts[0]?.currency).toBe("BRL");
    expect(assets.pixels[0]?.name).toBe("Pixel Loja");
    expect(input.pixelId).toBe("pixel_1");
    expect(JSON.stringify(assets)).not.toContain("accessToken");
  });

  it("validates legacy Meta assets without multi-account aggregates", () => {
    const assets = metaAssetsSchema.parse({
      workspaceId: "workspace_1",
      status: "connected",
      businesses: [
        {
          id: "business_1",
          name: "BM Principal",
          verificationStatus: "verified",
        },
      ],
      adAccounts: [
        {
          id: "act_123",
          businessId: "business_1",
          name: "Conta WhatsApp",
          accountStatus: "1",
          currency: "BRL",
          timezoneName: "America/Sao_Paulo",
        },
      ],
      pixels: [
        {
          id: "pixel_1",
          businessId: "business_1",
          name: "Pixel Loja",
          code: "1234567890",
        },
      ],
      selection: {
        businessId: "business_1",
        adAccountId: "act_123",
        pixelId: "pixel_1",
      },
      lastSyncedAt: "2026-07-02T12:00:00.000Z",
      syncError: null,
    });

    expect(assets.pixels[0]?.name).toBe("Pixel Loja");
    expect(assets.reportingAccounts).toBeUndefined();
  });

  it("validates Meta CAPI token configuration contracts without echoing secrets", () => {
    const saveInput = metaCapiTokenInputSchema.parse({
      accessToken: "EAAB-capi-token-secret",
    });
    const clearInput = metaCapiTokenInputSchema.parse({
      clear: true,
    });
    const status = metaCapiTokenStatusSchema.parse({
      workspaceId: "workspace_1",
      configured: true,
      updatedAt: "2026-07-02T03:00:00.000Z",
    });

    expect(saveInput.accessToken).toBe("EAAB-capi-token-secret");
    expect(clearInput.clear).toBe(true);
    expect(status.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain("EAAB-capi-token-secret");
  });

  it("validates password reset and email verification contracts", () => {
    const resetRequest = passwordResetRequestInputSchema.parse({
      email: " USER@WPPTRACK.COM ",
    });
    const resetResult = passwordResetRequestSchema.parse({
      ok: true,
      delivery: "not_configured",
      devToken: "reset-token-1234567890",
    });
    const resetConfirm = passwordResetConfirmInputSchema.parse({
      token: "reset-token-1234567890",
      password: "new-strong-password",
    });
    const resetConfirmed = passwordResetConfirmSchema.parse({ ok: true });
    const verificationStart = emailVerificationStartSchema.parse({
      ok: true,
      delivery: "not_configured",
      devToken: null,
    });
    const verificationConfirm = emailVerificationConfirmInputSchema.parse({
      token: "verify-token-1234567890",
    });
    const verified = emailVerificationConfirmSchema.parse({
      ok: true,
      emailVerifiedAt: "2026-07-02T03:00:00.000Z",
    });

    expect(resetRequest.email).toBe("user@wpptrack.com");
    expect(resetResult.devToken).toBe("reset-token-1234567890");
    expect(resetConfirm.password).toBe("new-strong-password");
    expect(resetConfirmed.ok).toBe(true);
    expect(verificationStart.ok).toBe(true);
    expect(verificationConfirm.token).toBe("verify-token-1234567890");
    expect(verified.ok).toBe(true);
  });

  it("validates current workspace, members and invites", () => {
    const workspace = currentWorkspaceSchema.parse({
      id: "workspace_1",
      name: "Comunidade NOD",
      slug: "comunidade-nod",
      role: "owner",
      operationalStatus: "blocked",
      platformRole: "platform_owner",
      permissions: {
        canInviteMembers: true,
        canManageMembers: true,
        canGrantMemberManager: true,
        canManageBilling: true,
        canManageIntegrations: true,
        canManageWorkspaceSettings: true,
        canTransferOwnership: true,
        canViewReports: true,
        canExportReports: true,
      },
    });
    const member = workspaceMemberSchema.parse({
      id: "member_1",
      userId: "user_1",
      email: "owner@wpptrack.com",
      name: "Owner",
      role: "owner",
      canManageMembers: false,
      joinedAt: "2026-07-02T03:00:00.000Z",
    });
    const inviteInput = workspaceInviteInputSchema.parse({
      email: " ADMIN@WPPTRACK.COM ",
      role: "admin",
    });
    const invite = workspaceInviteSchema.parse({
      id: "invite_1",
      email: "admin@wpptrack.com",
      role: "admin",
      status: "pending",
      expiresAt: "2026-07-09T03:00:00.000Z",
    });
    const acceptInput = workspaceInviteAcceptInputSchema.parse({
      token: "invite-token-1234567890",
    });
    const accepted = workspaceInviteAcceptSchema.parse({
      workspaceId: "workspace_1",
      memberId: "member_2",
      role: "admin",
      status: "accepted",
    });
    const newUserAccept = workspaceInviteNewUserAcceptInputSchema.parse({
      token: "invite-token-1234567890",
      name: " New Member ",
      password: "strong-password-123",
    });
    const inspection = workspaceInviteInspectionSchema.parse({
      state: "valid",
      workspaceName: "Comunidade NOD",
      emailHint: "ad***@wpptrack.com",
      role: "admin",
      accountMode: "login",
      expiresAt: "2026-07-09T03:00:00.000Z",
    });

    expect(workspace.permissions.canManageBilling).toBe(true);
    expect(workspace.operationalStatus).toBe("blocked");
    expect(workspace.platformRole).toBe("platform_owner");
    expect(member.role).toBe("owner");
    expect(inviteInput.email).toBe("admin@wpptrack.com");
    expect(invite.status).toBe("pending");
    expect(invite).not.toHaveProperty("acceptToken");
    const inviteWithLink = workspaceInviteSchema.parse({
      id: "invite_2",
      email: "admin@wpptrack.com",
      role: "admin",
      status: "pending",
      expiresAt: "2026-07-09T03:00:00.000Z",
      acceptUrl:
        "https://wpp.rastrack.app/invite/accept?token=invite-token-1234567890",
    });
    expect(inviteWithLink.acceptUrl).toContain("/invite/accept?token=");
    expect(acceptInput.token).toBe("invite-token-1234567890");
    expect(accepted.memberId).toBe("member_2");
    expect(newUserAccept.name).toBe("New Member");
    expect(inspection.state).toBe("valid");
  });

  it("validates workspace update input", () => {
    const input = workspaceUpdateInputSchema.parse({
      name: " Loja Samuel ",
    });

    expect(input.name).toBe("Loja Samuel");
  });

  it("validates workspace billing configuration for platform backoffice", () => {
    const input = workspaceBillingUpdateInputSchema.parse({
      asaasCustomerId: "cus_asaas_1",
    });
    const cleared = workspaceBillingUpdateInputSchema.parse({
      asaasCustomerId: null,
    });
    const billing = workspaceBillingSchema.parse({
      id: "workspace_1",
      name: "Comunidade NOD",
      slug: "comunidade-nod",
      asaasCustomerId: "cus_asaas_1",
      operationalStatus: "active",
      subscriptionStatus: "active",
      activeInstances: 2,
    });
    const statusInput = workspaceOperationalStatusUpdateInputSchema.parse({
      operationalStatus: "blocked",
    });

    expect(input.asaasCustomerId).toBe("cus_asaas_1");
    expect(cleared.asaasCustomerId).toBeNull();
    expect(billing.asaasCustomerId).toBe("cus_asaas_1");
    expect(billing.operationalStatus).toBe("active");
    expect(statusInput.operationalStatus).toBe("blocked");
    expect(billing.subscriptionStatus).toBe("active");
    expect(billing.activeInstances).toBe(2);
  });

  it("validates workspace billing list for platform backoffice", () => {
    const workspaces = workspaceBillingListSchema.parse([
      {
        id: "workspace_1",
        name: "Comunidade NOD",
        slug: "comunidade-nod",
        asaasCustomerId: "cus_asaas_1",
        operationalStatus: "active",
        subscriptionStatus: "active",
        activeInstances: 1,
      },
      {
        id: "workspace_2",
        name: "Clinica Norte",
        slug: "clinica-norte",
        asaasCustomerId: null,
        operationalStatus: "blocked",
        subscriptionStatus: "not_configured",
        activeInstances: 0,
      },
    ]);

    expect(workspaces).toHaveLength(2);
    expect(workspaces[1]?.asaasCustomerId).toBeNull();
  });

  it("rejects owner invites from client-facing workspace API", () => {
    expect(() =>
      workspaceInviteInputSchema.parse({
        email: "owner2@wpptrack.com",
        role: "owner",
      }),
    ).toThrow();
  });

  it("validates diagnostic event contracts", () => {
    const create = diagnosticEventCreateSchema.parse({
      workspaceId: "workspace_1",
      source: "meta",
      eventType: "pixel_event",
      status: "error",
      severity: "error",
      title: "Meta recusou evento",
      message: "Parametro currency ausente",
      summaryPayload: {
        authorization: "secret-token",
        currency: null,
      },
    });
    const query = diagnosticEventListQuerySchema.parse({
      source: "meta",
      q: "currency",
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-02T23:59:59.000Z",
      phoneHash: "phone_hash_1",
      campaignId: "cmp_1",
      errorCode: "MISSING_CURRENCY",
      limit: "25",
    });
    const detail = diagnosticEventDetailSchema.parse({
      id: "diag_1",
      workspaceId: "workspace_1",
      source: "meta",
      eventType: "pixel_event",
      severity: "error",
      status: "error",
      occurredAt: "2026-07-02T03:00:00.000Z",
      title: "Meta recusou evento",
      message: "Parametro currency ausente",
      leadId: null,
      phoneHash: null,
      campaignId: null,
      adSetId: null,
      adId: null,
      jobId: null,
      errorCode: "MISSING_CURRENCY",
      summaryPayload: {
        currency: null,
      },
      timeline: [
        {
          id: "diag_1",
          kind: "diagnostic_event",
          label: "Meta recusou evento",
          status: "error",
          occurredAt: "2026-07-02T03:00:00.000Z",
          summaryPayload: {
            currency: null,
          },
        },
        {
          id: "job_attempt_1",
          kind: "job_attempt",
          label: "retry-diagnostic-event",
          status: "queued",
          occurredAt: "2026-07-02T03:01:00.000Z",
          summaryPayload: null,
        },
      ],
    });

    expect(create.source).toBe("meta");
    expect(query).toMatchObject({
      source: "meta",
      q: "currency",
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-02T23:59:59.000Z",
      phoneHash: "phone_hash_1",
      campaignId: "cmp_1",
      errorCode: "MISSING_CURRENCY",
      limit: 25,
    });
    expect(detail.errorCode).toBe("MISSING_CURRENCY");
    expect(detail.timeline[1]?.kind).toBe("job_attempt");
  });

  it("validates diagnostic retry contracts", () => {
    const input = diagnosticRetryInputSchema.parse({
      reason: "Cliente relatou conversao faltando no relatorio",
    });
    const result = diagnosticRetryResultSchema.parse({
      ok: true,
      status: "queued",
      diagnosticEventId: "diag_1",
      auditLogId: "audit_1",
      jobAttemptId: "job_attempt_1",
    });

    expect(input.reason).toContain("conversao");
    expect(result.status).toBe("queued");
  });

  it("validates diagnostic webhook payload contract", () => {
    const payload = diagnosticWebhookPayloadSchema.parse({
      id: "webhook_1",
      workspaceId: "workspace_1",
      source: "uazapi",
      eventType: "message.received",
      externalEventId: "evt_1",
      status: "received",
      receivedAt: "2026-07-02T03:00:00.000Z",
      whatsappInstanceId: null,
      payloadKind: "summary",
      payloadAvailable: true,
      payload: {
        message: {
          text: "Venda fechada",
          token: "[redacted]",
        },
      },
    });

    expect(payload.payloadKind).toBe("summary");
    expect(payload.payloadAvailable).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("secret-token");
  });

  it("validates billing quote and checkout contracts", () => {
    const quote = whatsappInstanceQuoteSchema.parse({
      workspaceId: "workspace_1",
      activeInstances: 1,
      pricePerInstanceCents: 9900,
      nextInstanceAmountCents: 9900,
      currency: "BRL",
    });
    const input = whatsappInstanceCheckoutInputSchema.parse({
      instanceName: "Comercial",
      provider: "uazapi",
    });
    const checkout = whatsappInstanceCheckoutSchema.parse({
      workspaceId: "workspace_1",
      whatsappInstanceId: "wpp_1",
      activationId: "activation_1",
      chargeId: "charge_1",
      status: "pending_payment",
      amountCents: 9900,
      checkoutUrl: null,
      paymentProvider: "asaas",
      paymentProviderStatus: "not_configured",
      externalChargeId: null,
    });

    expect(quote.currency).toBe("BRL");
    expect(input.provider).toBe("uazapi");
    expect(checkout.status).toBe("pending_payment");
    expect(checkout.paymentProviderStatus).toBe("not_configured");
  });

  it("validates workspace subscription summary contract", () => {
    const subscription = workspaceSubscriptionSummarySchema.parse({
      workspaceId: "workspace_1",
      status: "active",
      planName: "Por instancia",
      activeInstances: 3,
      pricePerWhatsappInstanceCents: 9900,
      monthlyAmountCents: 29700,
      currentPeriodEnd: "2026-08-02T03:00:00.000Z",
      asaasSubscriptionId: "sub_asaas_1",
    });

    expect(subscription.monthlyAmountCents).toBe(29700);
  });

  it("validates lead list contracts", () => {
    const query = leadListQuerySchema.parse({
      search: "  mariana  ",
      status: "qualified",
      label: " Venda fechada ",
      campaignId: "cmp_1",
      adSetId: "adset_1",
      adId: "ad_1",
      since: "2026-07-01",
      until: "2026-07-02",
      limit: "25",
    });
    const lead = leadListItemSchema.parse({
      id: "lead_1",
      workspaceId: "workspace_1",
      name: "Mariana Alves",
      phoneDisplay: "+55 11 *****-1020",
      phoneHash: "phone_hash_1",
      status: "qualified",
      source: "uazapi",
      labels: ["Venda fechada", "VIP"],
      campaignId: "cmp_1",
      campaignName: "Black Friday WhatsApp",
      adSetId: "adset_1",
      adId: "ad_1",
      lastEventName: "QualifiedLead",
      firstMessageAt: "2026-07-02T03:00:00.000Z",
      lastMessageAt: "2026-07-02T03:10:00.000Z",
      createdAt: "2026-07-02T03:00:00.000Z",
      updatedAt: "2026-07-02T03:10:00.000Z",
    });

    expect(query).toMatchObject({
      search: "mariana",
      status: "qualified",
      label: "Venda fechada",
      campaignId: "cmp_1",
      adSetId: "adset_1",
      adId: "ad_1",
      since: "2026-07-01",
      until: "2026-07-02",
      limit: 25,
    });
    expect(lead.lastEventName).toBe("QualifiedLead");
    expect(lead.labels).toEqual(["Venda fechada", "VIP"]);
  });

  it("validates lead detail contracts with conversion and webhook timeline", () => {
    const detail = leadDetailSchema.parse({
      lead: {
        id: "lead_1",
        workspaceId: "workspace_1",
        name: "Mariana Alves",
        phoneDisplay: "+55 11 *****-1020",
        phoneHash: "phone_hash_1",
        status: "qualified",
        source: "uazapi",
        labels: ["Venda fechada"],
        campaignId: "cmp_1",
        campaignName: "Black Friday WhatsApp",
        adSetId: "adset_1",
        adId: "ad_1",
        lastEventName: "QualifiedLead",
        firstMessageAt: "2026-07-02T03:00:00.000Z",
        lastMessageAt: "2026-07-02T03:10:00.000Z",
        createdAt: "2026-07-02T03:00:00.000Z",
        updatedAt: "2026-07-02T03:10:00.000Z",
      },
      attribution: {
        campaignName: "Black Friday WhatsApp",
        adSetName: "Publico quente",
        adName: "Criativo WhatsApp",
        creative: {
          thumbnailUrl: "https://cdn.example.test/creative.jpg",
          destinationUrl: "https://www.instagram.com/p/creative/",
        },
      },
      conversionEvents: [
        {
          id: "conversion_1",
          eventName: "QualifiedLead",
          status: "sent",
          sourceTrigger: "keyword",
          pixelId: "pixel_1",
          campaignId: "cmp_1",
          adSetId: "adset_1",
          adId: "ad_1",
          errorCode: null,
          errorMessage: null,
          occurredAt: "2026-07-02T03:11:00.000Z",
          sentAt: "2026-07-02T03:13:00.000Z",
          createdAt: "2026-07-02T03:12:00.000Z",
        },
      ],
      webhookEvents: [
        {
          id: "webhook_1",
          source: "uazapi",
          eventType: "message",
          status: "processed",
          errorCode: null,
          errorMessage: null,
          receivedAt: "2026-07-02T03:01:00.000Z",
          processedAt: "2026-07-02T03:01:01.000Z",
        },
      ],
    });

    expect(detail.attribution.adName).toBe("Criativo WhatsApp");
    expect(detail.attribution.creative.thumbnailUrl).toBe(
      "https://cdn.example.test/creative.jpg",
    );
    expect(detail.conversionEvents[0]?.status).toBe("sent");
    expect(detail.webhookEvents[0]?.source).toBe("uazapi");
  });

  it("validates whatsapp instance connection status contracts", () => {
    const connection = whatsappInstanceConnectionSchema.parse({
      whatsappInstanceId: "wpp_1",
      provider: "uazapi",
      billingStatus: "active",
      connectionStatus: "qr_required",
      qrCode: "base64-or-text-qr",
      message: "Escaneie o QR Code no WhatsApp Business",
    });

    expect(connection.provider).toBe("uazapi");
    expect(connection.qrCode).toBe("base64-or-text-qr");
  });

  it("validates whatsapp instance summary contracts", () => {
    const instance = whatsappInstanceSummarySchema.parse({
      id: "wpp_1",
      name: "Comercial",
      provider: "uazapi",
      billingStatus: "active",
      providerInstanceId: "provider_instance_1",
      checkoutUrl: null,
      createdAt: "2026-07-02T03:00:00.000Z",
    });

    expect(instance.billingStatus).toBe("active");
    expect(instance.providerInstanceId).toBe("provider_instance_1");
    expect(instance.checkoutUrl).toBeNull();
  });

  it("validates split receiver contracts for platform backoffice", () => {
    const create = splitReceiverCreateInputSchema.parse({
      name: "Socio Operacional",
      walletId: "wallet_asaas_1",
      email: "socio@wpptrack.com",
      percentageBps: 2500,
    });
    const update = splitReceiverUpdateInputSchema.parse({
      active: false,
      percentageBps: 1500,
    });
    const receiver = splitReceiverSchema.parse({
      id: "receiver_1",
      name: "Socio Operacional",
      walletId: "wallet_asaas_1",
      email: "socio@wpptrack.com",
      percentageBps: 2500,
      active: true,
      createdAt: "2026-07-02T03:00:00.000Z",
      updatedAt: "2026-07-02T03:00:00.000Z",
    });

    expect(create.percentageBps).toBe(2500);
    expect(update.active).toBe(false);
    expect(receiver.walletId).toBe("wallet_asaas_1");
  });

  it("validates backoffice payment charge contracts", () => {
    const charge = backofficePaymentChargeSchema.parse({
      id: "charge_1",
      workspaceId: "workspace_1",
      workspaceName: "Comunidade NOD",
      provider: "asaas",
      externalChargeId: "pay_asaas_1",
      status: "paid",
      amountCents: 12900,
      description: "Ativacao da instancia WhatsApp Comercial",
      checkoutUrl: "https://sandbox.asaas.com/i/pay_asaas_1",
      dueAt: null,
      paidAt: "2026-07-02T12:00:00.000Z",
      createdAt: "2026-07-02T11:00:00.000Z",
      whatsappInstanceId: "wpp_1",
      whatsappInstanceName: "Comercial",
    });
    const charges = backofficePaymentChargeListSchema.parse([charge]);

    expect(charges[0]?.status).toBe("paid");
    expect(charges[0]?.amountCents).toBe(12900);
    expect(charges[0]?.workspaceName).toBe("Comunidade NOD");
  });

  it("validates backoffice subscription plan contracts", () => {
    const create = backofficeSubscriptionPlanCreateInputSchema.parse({
      name: "Plano Growth",
      slug: "growth",
      pricePerWhatsappInstanceCents: 12900,
      active: true,
    });
    const update = backofficeSubscriptionPlanUpdateInputSchema.parse({
      pricePerWhatsappInstanceCents: 14900,
      active: false,
    });
    const plan = backofficeSubscriptionPlanSchema.parse({
      id: "plan_1",
      name: "Plano Growth",
      slug: "growth",
      pricePerWhatsappInstanceCents: 12900,
      active: true,
      createdAt: "2026-07-02T03:00:00.000Z",
      updatedAt: "2026-07-02T03:00:00.000Z",
    });

    expect(create.slug).toBe("growth");
    expect(update.active).toBe(false);
    expect(plan.pricePerWhatsappInstanceCents).toBe(12900);
  });

  it("validates supported Meta CAPI WhatsApp event names", () => {
    expect(conversionEventNameSchema.parse("LeadSubmitted")).toBe(
      "LeadSubmitted",
    );
    expect(conversionEventNameSchema.parse("QualifiedLead")).toBe(
      "QualifiedLead",
    );
    expect(conversionEventNameSchema.parse("Purchase")).toBe("Purchase");
    expect(conversionEventNameSchema.parse("OrderDelivered")).toBe(
      "OrderDelivered",
    );
    expect(() => conversionEventNameSchema.parse("Contact")).toThrow();
  });

  it("validates conversion event statuses and error codes", () => {
    expect(conversionEventLogStatusSchema.parse("pending_meta_context")).toBe(
      "pending_meta_context",
    );
    expect(conversionEventLogStatusSchema.parse("pending_value")).toBe(
      "pending_value",
    );
    expect(conversionEventLogStatusSchema.parse("imported")).toBe("imported");
    expect(conversionEventLogStatusSchema.parse("shadow_observed")).toBe(
      "shadow_observed",
    );
    expect(conversionEventErrorCodeSchema.parse("MissingCtwaClid")).toBe(
      "MissingCtwaClid",
    );
    expect(conversionEventErrorCodeSchema.parse("MetaCapiRejected")).toBe(
      "MetaCapiRejected",
    );
  });

  it("validates conversion audit report events", () => {
    const event = conversionAuditEventSchema.parse({
      id: "audit_event_1",
      eventName: "Purchase",
      eventLabel: "Compras",
      deliveryState: "sent",
      statusLabel: "Enviado",
      statusDetail: "Recebido pela Meta",
      source: "external_integration",
      sourceLabel: "Integracao externa",
      leadId: "lead_1",
      leadName: "Mariana Alves",
      phoneDisplay: "+55 11 99999-1020",
      campaignId: "cmp_1",
      campaignName: "Campanha WhatsApp",
      adSetId: "adset_1",
      adSetName: "Conjunto aberto",
      adId: "ad_1",
      adName: "Anuncio 1",
      pixelId: "pixel_1",
      pageId: "page_1",
      occurredAt: "2026-07-02T03:00:00.000Z",
      sentAt: "2026-07-02T03:01:00.000Z",
      status: "sent",
      providerResponseSummary: "events_received: 1",
      errorCode: null,
      errorMessage: null,
    });
    const overview = conversionAuditOverviewSchema.parse({
      workspaceId: "workspace_1",
      rangeLabel: "2026-07-01 a 2026-07-02",
      summary: {
        total: 2,
        sent: 1,
        queued: 0,
        blocked: 0,
        failed: 1,
        notEligible: 0,
        shadowObserved: 0,
        historical: 0,
        discarded: 0,
      },
      pagination: {
        page: 1,
        pageSize: 25,
        totalItems: 2,
        totalPages: 1,
      },
      events: [
        event,
        {
          id: "audit_event_2",
          eventName: "QualifiedLead",
          eventLabel: "Lead qualificado",
          deliveryState: "failed",
          statusLabel: "Falhou",
          statusDetail: "O envio nao foi concluido",
          source: "whatsapp_automation",
          sourceLabel: "Automacao do WhatsApp",
          leadId: null,
          leadName: null,
          phoneDisplay: null,
          campaignId: null,
          campaignName: null,
          adSetId: null,
          adSetName: null,
          adId: null,
          adName: null,
          pixelId: "pixel_1",
          pageId: null,
          occurredAt: "2026-07-02T04:00:00.000Z",
          sentAt: null,
          status: "error",
          providerResponseSummary: null,
          errorCode: "MetaCapiRejected",
          errorMessage: "Invalid match key",
        },
      ],
    });

    expect(event.eventLabel).toBe("Compras");
    expect(event.canRetry).toBe(false);
    expect(overview.events[1]?.errorCode).toBe("MetaCapiRejected");
  });

  it("validates detailed conversion audit payload snapshots", () => {
    const detail = conversionAuditEventDetailSchema.parse({
      id: "audit_event_1",
      eventName: "QualifiedLead",
      eventLabel: "Lead qualificado",
      deliveryState: "sent",
      statusLabel: "Enviado",
      statusDetail: "Recebido pela Meta",
      source: "external_integration",
      sourceLabel: "Integracao externa",
      leadId: "lead_1",
      leadName: "Mariana Alves",
      phoneDisplay: "+55 11 99999-1020",
      campaignId: "cmp_1",
      campaignName: "Campanha WhatsApp",
      adSetId: "adset_1",
      adSetName: "Conjunto aberto",
      adId: "ad_1",
      adName: "Anuncio 1",
      pixelId: "pixel_1",
      pageId: "page_1",
      occurredAt: "2026-07-02T03:00:00.000Z",
      sentAt: "2026-07-02T03:01:00.000Z",
      status: "sent",
      providerResponseSummary: "Meta confirmou o recebimento",
      errorCode: null,
      errorMessage: null,
      valueSource: null,
      reasonCode: null,
      reason: null,
      missingFields: [],
      sourceSnapshot: {
        mode: "stored_normalized",
        label: "Entrada normalizada armazenada",
        payload: { ctwaClid: "ctwa_1" },
      },
      metaRequest: {
        mode: "stored",
        label: "Payload exato armazenado no envio",
        payload: { data: [{ event_name: "QualifiedLead" }] },
      },
      metaResponse: {
        mode: "stored",
        label: "Resposta armazenada da Meta",
        payload: { events_received: 1 },
      },
    });

    expect(detail.metaRequest.payload).toEqual({
      data: [{ event_name: "QualifiedLead" }],
    });
    expect(detail.sourceSnapshot.mode).toBe("stored_normalized");
  });

  it("validates conversion rules with value defaults for Purchase", () => {
    const input = conversionRuleCreateInputSchema.parse({
      name: "Compra por etiqueta",
      triggerType: "whatsapp_label",
      triggerValue: "Venda fechada",
      matchMode: "exact",
      eventName: "Purchase",
      defaultValueCents: 19900,
      defaultCurrency: "BRL",
      defaultContentName: "Plano mensal",
      defaultItems: [{ id: "plan_1", quantity: 1, item_price: 199 }],
    });

    expect(input.defaultValueCents).toBe(19900);
    expect(input.defaultCurrency).toBe("BRL");
  });

  it("validates a controlled Meta CAPI test input", () => {
    const input = conversionEventTestInputSchema.parse({
      workspaceId: "workspace_1",
      eventName: "QualifiedLead",
      phoneHash: "phone_hash_1",
      adId: "ad_1",
      ctwaClid: "clid_1",
      testEventCode: "TEST12345",
    });

    expect(input.testEventCode).toBe("TEST12345");
  });

  it("validates the diagnostic Meta CAPI test input contract", () => {
    const input = diagnosticConversionEventTestInputSchema.parse({
      workspaceId: "workspace_1",
      eventName: "Purchase",
      phoneHash: "phone_hash_1",
      adId: "ad_1",
      ctwaClid: "clid_1",
      valueCents: 19900,
      currency: "BRL",
      contentName: "Plano mensal",
      testEventCode: "TEST12345",
    });

    expect(input.eventName).toBe("Purchase");
    expect(input.valueCents).toBe(19900);
  });

  it("validates conversion rule contracts for keyword and WhatsApp labels", () => {
    const create = conversionRuleCreateInputSchema.parse({
      name: "Lead qualificado por palavra",
      triggerType: "keyword",
      triggerValue: "quero comprar",
      matchMode: "contains",
      eventName: "QualifiedLead",
      pixelId: "1234567890",
    });
    const update = conversionRuleUpdateInputSchema.parse({
      active: false,
      triggerValue: "VIP",
    });
    const rule = conversionRuleSchema.parse({
      id: "rule_1",
      workspaceId: "workspace_1",
      name: "Compra por etiqueta",
      triggerType: "whatsapp_label",
      triggerValue: "Venda fechada",
      matchMode: "exact",
      eventName: "Purchase",
      pixelId: null,
      active: true,
      createdAt: "2026-07-02T03:00:00.000Z",
      updatedAt: "2026-07-02T03:00:00.000Z",
    });
    const evaluation = conversionTriggerEvaluationInputSchema.parse({
      messageText: "Oi, quero comprar agora",
      labels: ["Venda fechada"],
    });

    expect(create.eventName).toBe("QualifiedLead");
    expect(update.active).toBe(false);
    expect(rule.triggerType).toBe("whatsapp_label");
    expect(evaluation.labels).toEqual(["Venda fechada"]);
  });

  it("validates external MySQL connector inputs without leaking credentials", () => {
    const create = externalDataConnectorCreateInputSchema.parse({
      workspaceId: "workspace_1",
      name: "Kinbox Barbieri",
      provider: "kinbox_mysql",
      timezone: "America/Sao_Paulo",
      sslMode: "required",
      credentials: {
        host: "mysql.internal",
        port: 3306,
        database: "tracking",
        username: "wpptrack_reader",
        password: "secret-value",
      },
      shadowMode: true,
      purchaseAverageValueCents: 400000,
      defaultCurrency: "brl",
    });
    const connector = externalDataConnectorSchema.parse({
      id: "connector_1",
      workspaceId: create.workspaceId,
      name: create.name,
      provider: create.provider,
      status: "draft",
      timezone: create.timezone,
      sslMode: create.sslMode,
      syncEnabled: false,
      shadowMode: true,
      capiSendEnabled: false,
      capiCutovers: [],
      purchaseAverageValueCents: create.purchaseAverageValueCents,
      defaultCurrency: create.defaultCurrency,
      hasCredentials: true,
      lastConnectionTestAt: null,
      lastConnectionStatus: null,
      lastSyncStartedAt: null,
      lastSyncCompletedAt: null,
      lastSyncStatus: null,
      lastSyncErrorCode: null,
      cursors: [],
      createdAt: "2026-07-11T17:00:00.000Z",
      updatedAt: "2026-07-11T17:00:00.000Z",
    });

    expect(create.defaultCurrency).toBe("BRL");
    expect(connector).not.toHaveProperty("credentials");
    expect(connector).not.toHaveProperty("password");
  });

  it("rejects unsafe external connector updates and validates safe health results", () => {
    expect(() =>
      externalDataConnectorUpdateInputSchema.parse({
        timezone: "Not/A_Timezone",
      }),
    ).toThrow();
    expect(() => externalDataConnectorUpdateInputSchema.parse({})).toThrow();

    const result = externalConnectionTestResultSchema.parse({
      ok: true,
      status: "connected",
      latencyMs: 42,
      leadsViewAvailable: true,
      eventsViewAvailable: true,
      errorCode: null,
      message: "Conexao estabelecida",
    });

    expect(result.latencyMs).toBe(42);
  });

  it("validates the external connector reconciliation gate", () => {
    const result = externalConnectorReconciliationSchema.parse({
      connectorId: "connector_1",
      workspaceId: "workspace_1",
      generatedAt: "2026-07-12T20:00:00.000Z",
      state: "ready",
      readyForCutover: true,
      meta: {
        connectionConfigured: true,
        destinationConfigured: true,
        pixelId: "pixel_1",
        pageId: "page_1",
      },
      events: ["conversation_started", "qualified_lead", "purchase"].map(
        (eventType) => ({
          eventType,
          sourceRows: 1,
          acceptedRows: 1,
          operationalRows: 1,
          historicalRows: 0,
          expectedMatchedRows: 1,
          matchedRows: 1,
          duplicateDeliveries: 0,
          rejectedRows: 0,
          quarantinedRows: 0,
          blockingRejectedRows: 0,
          pendingRows: 0,
          readyToSendRows: 1,
          sentRows: 0,
          importedRows: 0,
          notEligibleRows: 0,
          shadowObservedRows: 0,
          blockedDeliveryRows: 0,
          capiActive: false,
          readyForCutover: true,
          cutoverAt: null,
          firstOccurredAt: "2026-07-12T19:00:00.000Z",
          lastOccurredAt: "2026-07-12T19:00:00.000Z",
        }),
      ),
      blockers: [],
    });

    expect(result.readyForCutover).toBe(true);
    expect(result.events).toHaveLength(3);
  });

  it("validates WhatsApp provider credentials strictly", () => {
    expect(
      whatsappConnectionCreateInputSchema.parse({
        provider: "uazapi_byo",
        name: "Comercial",
        credentials: {
          baseUrl: "https://uazapi.example.test",
          token: "secret",
        },
      }),
    ).toMatchObject({ provider: "uazapi_byo" });
    expect(() =>
      whatsappConnectionCreateInputSchema.parse({
        provider: "uazapi_byo",
        name: "Comercial",
        credentials: {
          baseUrl: "ftp://uazapi.example.test",
          token: "secret",
        },
      }),
    ).toThrow();
    expect(() =>
      whatsappConnectionCreateInputSchema.parse({
        provider: "waha",
        name: "Comercial",
        credentials: {
          baseUrl: "https://waha.example.test",
          apiKey: "secret",
        },
        unexpected: true,
      }),
    ).toThrow();
    expect(() =>
      whatsappConnectionCredentialsUpdateSchema.parse({
        provider: "zapi",
        credentials: {
          baseUrl: "https://zapi.example.test",
          instanceId: "instance",
          token: "secret",
          unexpected: true,
        },
      }),
    ).toThrow();
    expect(
      whatsappConnectionTestResultSchema.parse({
        connectionId: "connection_1",
        provider: "waha",
        status: "connected",
        checkedAt: "2026-08-27T12:00:00.000Z",
      }),
    ).toMatchObject({ status: "connected" });
    expect(() =>
      whatsappConnectionUpdateInputSchema.parse({
        webhookUrl: "https://attacker.example.test/webhook",
      }),
    ).toThrow();
    expect(() =>
      whatsappConnectionCreateInputSchema.parse({
        provider: "nod_api",
        name: "NOD",
      }),
    ).toThrow();
  });

  it("keeps receiver contracts strict, HTTP(S), and free from tokens in the endpoint", () => {
    const rotated = whatsappConnectionWebhookTokenRotateResultSchema.parse({
      connection: {
        id: "connection_1",
        name: "Comercial",
        displayName: null,
        provider: "waha",
        status: "active",
        lastHealthStatus: null,
        lastHealthCheckedAt: null,
        createdAt: "2026-08-28T12:00:00.000Z",
      },
      webhookEndpoint:
        "https://api.example.test/webhooks/whatsapp/connection_1",
      webhookToken: "a".repeat(43),
    });
    expect(rotated.webhookEndpoint).not.toContain("token=");
    expect(() =>
      whatsappConnectionWebhookTokenRotateResultSchema.parse({
        ...rotated,
        webhookEndpoint:
          "ftp://api.example.test/webhooks/whatsapp/connection_1",
      }),
    ).toThrow();
  });
});
