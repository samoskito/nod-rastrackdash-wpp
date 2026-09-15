import { describe, expect, it } from "vitest";
import {
  backofficeInboundWebhookDeliveryListSchema,
  backofficeInboundWebhookDeliveryQuerySchema,
  backofficeInboundWebhookDeliverySummaryQuerySchema,
  backofficeInboundWebhookDeliverySummarySchema,
  backofficeInboundWebhookParserRecoveryInputSchema,
  backofficeInboundWebhookParserRecoveryPreviewSchema,
  backofficeInboundWebhookParserRecoveryResultSchema,
  backofficeInboundWebhookPayloadSchema,
  backofficeProviderConversionRolloutModeInputSchema,
  backofficeProviderConversionRolloutQuerySchema,
  backofficeProviderConversionRolloutSchema,
  backofficeProviderConversionReevaluationInputSchema,
  inboundWebhookChannelSchema,
  inboundWebhookChannelRouteInputSchema,
  inboundWebhookChannelRouteSchema,
  inboundWebhookChannelRoutesUpdateInputSchema,
  inboundWebhookCapabilitiesSchema,
  inboundWebhookConnectionOverviewSchema,
  inboundWebhookConnectionCreateInputSchema,
  inboundWebhookConnectionCreateResultSchema,
  inboundWebhookConnectionListSchema,
  inboundWebhookConnectionRotateSecretResultSchema,
  inboundWebhookConnectionStatusUpdateInputSchema,
  inboundWebhookEventClassificationSchema,
  inboundWebhookNormalizedObservationSchema,
  inboundWebhookProviderSchema,
} from "../src/schemas/inbound-webhooks";

const timestamp = "2026-07-17T12:00:00.000Z";

const connection = {
  id: "connection_1",
  workspaceId: "workspace_1",
  provider: "umbler",
  displayName: "Umbler Comercial",
  parserVersion: "v1",
  status: "observation",
  productionActivatedAt: null,
  lastDeliveryAt: null,
  lastSuccessfulParseAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe("inbound webhook contracts", () => {
  it("accepts bounded parser recovery batches and redacted previews", () => {
    expect(
      backofficeInboundWebhookParserRecoveryInputSchema.parse({
        confirmation: "Unidade Itaborai",
        selection: "batch_500",
      }),
    ).toEqual({
      confirmation: "Unidade Itaborai",
      selection: "batch_500",
    });
    expect(() =>
      backofficeInboundWebhookParserRecoveryInputSchema.parse({
        confirmation: "Unidade Itaborai",
        selection: "all",
      }),
    ).toThrow();

    const preview = backofficeInboundWebhookParserRecoveryPreviewSchema.parse({
      workspace: {
        id: "workspace_1",
        name: "MC Itaborai",
      },
      connection: {
        ...connection,
        provider: "gupshup",
        parserReleaseStatus: "certified",
      },
      counts: {
        awaitingParser: 3374,
        recoverable: 2058,
        expired: 1316,
        unavailable: 0,
        inFlight: 0,
      },
      maxBatchSize: 500,
      secret: "must-be-removed",
    });

    expect(preview.counts.recoverable).toBe(2058);
    expect(preview).not.toHaveProperty("secret");
    expect(
      backofficeInboundWebhookParserRecoveryResultSchema.parse({
        connectionId: "connection_1",
        selection: "canary_10",
        requestedLimit: 10,
        selected: 10,
        claimed: 10,
        queued: 10,
        existing: 0,
        queueFailures: 0,
        remainingRecoverable: 2048,
      }),
    ).toMatchObject({
      requestedLimit: 10,
      queued: 10,
      remainingRecoverable: 2048,
    });
  });

  it("accepts the dedicated ignored empty-template classification", () => {
    expect(
      inboundWebhookEventClassificationSchema.parse("ignored_empty_template"),
    ).toBe("ignored_empty_template");
  });

  it("accepts only bounded provider-conversion reevaluation request keys", () => {
    expect(
      backofficeProviderConversionReevaluationInputSchema.parse({
        requestKey: "backoffice:decision_1:request_123456",
      }),
    ).toEqual({
      requestKey: "backoffice:decision_1:request_123456",
    });
    expect(() =>
      backofficeProviderConversionReevaluationInputSchema.parse({
        requestKey: "short",
      }),
    ).toThrow();
    expect(() =>
      backofficeProviderConversionReevaluationInputSchema.parse({
        requestKey: "backoffice:decision_1:\nrequest_123456",
      }),
    ).toThrow();
  });

  it("accepts protected provider-conversion rollout controls", () => {
    expect(backofficeProviderConversionRolloutQuerySchema.parse({})).toEqual({
      onlyMismatches: false,
      comparisonResult: "all",
      decisionPresence: "all",
      limit: 30,
      offset: 0,
    });
    expect(
      backofficeProviderConversionRolloutQuerySchema.parse({
        comparisonResult: "mismatches",
        decisionPresence: "with_decision",
        decisionCode: "review_required",
        eventName: "Purchase",
        createdFrom: "2026-07-24T10:30",
        createdUntil: "2026-07-24T11:00",
        limit: "20",
        offset: "40",
      }),
    ).toEqual({
      onlyMismatches: false,
      comparisonResult: "mismatches",
      decisionPresence: "with_decision",
      decisionCode: "review_required",
      eventName: "Purchase",
      createdFrom: "2026-07-24T10:30",
      createdUntil: "2026-07-24T11:00",
      limit: 20,
      offset: 40,
    });
    expect(() =>
      backofficeProviderConversionRolloutQuerySchema.parse({
        createdFrom: "2026-07-24T11:00",
        createdUntil: "2026-07-24T10:30",
      }),
    ).toThrow();
    expect(
      backofficeProviderConversionRolloutModeInputSchema.parse({
        mode: "canonical",
        confirmation: "Central de Vendas",
        acknowledgedComparisonCount: 25,
        acknowledgedMismatchCount: 2,
      }),
    ).toEqual({
      mode: "canonical",
      confirmation: "Central de Vendas",
      acknowledgedComparisonCount: 25,
      acknowledgedMismatchCount: 2,
    });
    expect(() =>
      backofficeProviderConversionRolloutModeInputSchema.parse({
        mode: "enabled",
        confirmation: "Central de Vendas",
      }),
    ).toThrow();
  });

  it("accepts append-only shadow comparison summaries", () => {
    const rollout = backofficeProviderConversionRolloutSchema.parse({
      channel: {
        id: "channel_1",
        displayName: "Central de Vendas",
        connectedPhone: "+5511999999999",
        mode: "shadow",
      },
      counts: {
        comparisons: 10,
        matches: 9,
        mismatches: 1,
      },
      filteredCounts: {
        comparisons: 1,
        matches: 0,
        mismatches: 1,
      },
      pagination: {
        offset: 0,
        limit: 20,
        total: 1,
        hasPrevious: false,
        hasNext: false,
      },
      mismatchReasons: [
        {
          code: "applicability_mismatch",
          count: 1,
        },
      ],
      latestComparisonAt: timestamp,
      canActivateCanonical: true,
      canonicalBlocker: null,
      comparisons: [
        {
          id: "comparison_1",
          occurrenceKey: "occurrence_1",
          eventName: "Purchase",
          authoritativeEngine: "legacy",
          matches: false,
          mismatchCode: "applicability_mismatch",
          legacy: {
            engineVersion: null,
            decisionCode: null,
            reasonCode: null,
          },
          canonical: {
            engineVersion: "decision-v1",
            decisionCode: "ignored_empty_template",
            reasonCode: "empty_template",
          },
          sourceDeliveryId: "delivery_1",
          createdAt: timestamp,
        },
      ],
    });

    expect(rollout.channel.mode).toBe("shadow");
    expect(rollout.counts.mismatches).toBe(1);
    expect(rollout.comparisons[0]?.canonical.decisionCode).toBe(
      "ignored_empty_template",
    );
  });

  it("accepts bounded delivery pagination with safe defaults", () => {
    expect(backofficeInboundWebhookDeliveryQuerySchema.parse({})).toMatchObject(
      {
        limit: 50,
        offset: 0,
      },
    );
    expect(
      backofficeInboundWebhookDeliveryQuerySchema.parse({
        limit: "51",
        offset: "150",
      }),
    ).toMatchObject({
      limit: 51,
      offset: 150,
    });
    expect(() =>
      backofficeInboundWebhookDeliveryQuerySchema.parse({ offset: "-1" }),
    ).toThrow();
  });

  it("accepts an exact-minute backoffice period and rejects reversed ranges", () => {
    const period = {
      receivedFrom: "2026-07-23T10:36",
      receivedUntil: "2026-07-23T10:36",
    };

    expect(backofficeInboundWebhookDeliveryQuerySchema.parse(period)).toEqual({
      ...period,
      limit: 50,
      offset: 0,
    });
    expect(
      backofficeInboundWebhookDeliverySummaryQuerySchema.parse(period),
    ).toEqual(period);
    expect(() =>
      backofficeInboundWebhookDeliveryQuerySchema.parse({
        receivedFrom: "2026-07-23T10:37",
        receivedUntil: "2026-07-23T10:36",
      }),
    ).toThrow("O fim do periodo deve ser posterior ao inicio");
  });

  it("accepts the registered observation providers", () => {
    expect(inboundWebhookProviderSchema.parse("umbler")).toBe("umbler");
    expect(inboundWebhookProviderSchema.parse("gupshup")).toBe("gupshup");
    expect(inboundWebhookProviderSchema.parse("meta_cloud")).toBe("meta_cloud");
    expect(() => inboundWebhookProviderSchema.parse("data_crazy")).toThrow();
  });

  it("accepts a bounded safe display name", () => {
    const parsed = inboundWebhookConnectionCreateInputSchema.parse({
      provider: "umbler",
      displayName: "  Umbler Comercial (SP) - 01  ",
    });

    expect(parsed.displayName).toBe("Umbler Comercial (SP) - 01");
    expect(() =>
      inboundWebhookConnectionCreateInputSchema.parse({
        provider: "umbler",
        displayName: "Comercial\n<script>",
      }),
    ).toThrow();
    expect(() =>
      inboundWebhookConnectionCreateInputSchema.parse({
        provider: "umbler",
        displayName: "x".repeat(121),
      }),
    ).toThrow();
  });

  it("accepts controlled observation, production and pause status updates", () => {
    expect(
      inboundWebhookConnectionStatusUpdateInputSchema.parse({
        status: "observation",
      }),
    ).toEqual({ status: "observation" });
    expect(
      inboundWebhookConnectionStatusUpdateInputSchema.parse({
        status: "paused",
      }),
    ).toEqual({ status: "paused" });
    expect(
      inboundWebhookConnectionStatusUpdateInputSchema.parse({
        status: "production",
      }),
    ).toEqual({ status: "production" });
  });

  it("supports many BMs per channel and the same BM on many channels", () => {
    const firstChannel = inboundWebhookChannelRoutesUpdateInputSchema.parse({
      routes: [
        {
          metaBusinessConnectionId: "business_connection_1",
        },
        {
          metaBusinessConnectionId: "business_connection_2",
          metaReportingAccountId: "reporting_account_2",
          metaConversionDestinationId: "destination_2",
        },
      ],
    });
    const secondChannel = inboundWebhookChannelRoutesUpdateInputSchema.parse({
      routes: [
        {
          metaBusinessConnectionId: "business_connection_1",
          metaReportingAccountId: null,
          metaConversionDestinationId: null,
        },
      ],
    });

    expect(firstChannel.routes).toHaveLength(2);
    expect(firstChannel.routes[0]).toEqual({
      metaBusinessConnectionId: "business_connection_1",
    });
    expect(secondChannel.routes[0]?.metaBusinessConnectionId).toBe(
      "business_connection_1",
    );
  });

  it("requires a BM when creating a route but allows a removed persisted BM", () => {
    expect(() => inboundWebhookChannelRouteInputSchema.parse({})).toThrow();
    expect(() =>
      inboundWebhookChannelRouteInputSchema.parse({
        metaBusinessConnectionId: null,
      }),
    ).toThrow();

    const persisted = inboundWebhookChannelRouteSchema.parse({
      id: "route_1",
      channelId: "channel_1",
      metaBusinessConnectionId: null,
      metaReportingAccountId: null,
      metaConversionDestinationId: null,
      active: false,
      validationStatus: "asset_removed",
      validationErrorCode: "meta_business_connection_removed",
      lastValidatedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(persisted.metaBusinessConnectionId).toBeNull();
  });

  it("keeps channel readiness redacted and rejects unknown states", () => {
    const sensitiveValues = {
      ctwaClid: "full-ctwa-value",
      contactPhone: "+5511999999999",
      encryptedPayload: "encrypted-payload",
      payloadIv: "payload-iv",
      payloadTag: "payload-tag",
    };
    const channel = inboundWebhookChannelSchema.parse({
      id: "channel_1",
      connectionId: connection.id,
      organizationId: "organization_1",
      providerChannelId: "provider_channel_1",
      connectedPhone: "+551143377011",
      channelName: "Central de Vendas",
      status: "discovered",
      productionActivatedAt: null,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      routes: [],
      readiness: {
        state: "blocked",
        blockers: ["route_not_configured", "ctwa_unresolved"],
        routeCount: 0,
        validRouteCount: 0,
        totalCtwa: 7,
        routedCtwa: 0,
        unresolvedCtwa: 7,
        retainedCtwa: 7,
        retainedRoutedCtwa: 0,
        payloadUnavailableCtwa: 0,
        alreadyMaterializedCtwa: 0,
        nextPayloadExpiresAt: timestamp,
        ...sensitiveValues,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(channel.readiness).not.toHaveProperty("ctwaClid");
    expect(channel.readiness).not.toHaveProperty("contactPhone");
    expect(channel.readiness).not.toHaveProperty("encryptedPayload");
    expect(JSON.stringify(channel.readiness)).not.toContain("full-ctwa-value");
    expect(() =>
      inboundWebhookChannelSchema.parse({
        ...channel,
        readiness: {
          ...channel.readiness,
          state: "production",
        },
      }),
    ).toThrow();
  });

  it("keeps one-time secrets out of ordinary connection listings", () => {
    const secret = "s".repeat(43);
    const webhookUrl = `https://api.wpptrack.test/webhooks/inbound/connection_1?token=${secret}`;
    const list = inboundWebhookConnectionListSchema.parse([
      {
        ...connection,
        secret,
        webhookUrl,
      },
    ]);
    const created = inboundWebhookConnectionCreateResultSchema.parse({
      connection,
      secret,
      webhookUrl,
    });
    const rotated = inboundWebhookConnectionRotateSecretResultSchema.parse({
      connectionId: connection.id,
      provider: "umbler",
      secret,
      webhookUrl,
      rotatedAt: timestamp,
    });

    expect(list[0]).not.toHaveProperty("secret");
    expect(list[0]).not.toHaveProperty("webhookUrl");
    expect(created.secret).toBe(secret);
    expect(rotated.secret).toBe(secret);
  });

  it("exposes only safe feature capabilities and observation counters", () => {
    const capabilities = inboundWebhookCapabilitiesSchema.parse({
      enabled: true,
      productionEnabled: false,
      providers: [
        {
          provider: "umbler",
          parserVersion: "v1",
          parserReleaseStatus: "observation_only",
          creationEnabled: true,
          accessToken: "must-be-removed",
        },
      ],
    });
    const overview = inboundWebhookConnectionOverviewSchema.parse({
      connection,
      counters: {
        eligibleRouted: 4,
        eligibleUnresolved: 2,
        ignoredNoCtwa: 8,
        duplicate: 3,
        invalid: 1,
      },
      rawPayload: "must-be-removed",
    });

    expect(capabilities.providers[0]).not.toHaveProperty("accessToken");
    expect(overview).not.toHaveProperty("rawPayload");
    expect(overview.counters).toEqual({
      eligibleRouted: 4,
      eligibleUnresolved: 2,
      ignoredNoCtwa: 8,
      duplicate: 3,
      invalid: 1,
    });
  });

  it("strips sensitive provider data from normalized observations", () => {
    const sensitiveValues = {
      ctwaClid: "full-ctwa-value",
      message: "full message content",
      contactPhone: "+5511999999999",
      mediaUrl: "https://cdn.example.test/private-media.jpg",
      secret: "webhook-secret",
    };
    const parsed = inboundWebhookNormalizedObservationSchema.parse({
      id: "event_1",
      connectionId: connection.id,
      deliveryId: "delivery_1",
      channelId: "channel_1",
      provider: "umbler",
      providerEventType: "Message",
      externalMessageId: "message_1",
      occurredAt: timestamp,
      connectedPhoneSuffix: "4321",
      contactIdentityHash: "a".repeat(64),
      adId: "ad_1",
      hasCtwa: true,
      classification: "eligible_route_unresolved",
      classificationReason: "route_not_configured",
      resolvedBusinessConnectionId: null,
      resolvedReportingAccountId: null,
      resolvedConversionDestinationId: null,
      createdAt: timestamp,
      ...sensitiveValues,
    });

    expect(parsed.hasCtwa).toBe(true);
    expect(parsed.connectedPhoneSuffix).toBe("4321");
    for (const key of Object.keys(sensitiveValues)) {
      expect(parsed).not.toHaveProperty(key);
    }
    expect(JSON.stringify(parsed)).not.toContain("full-ctwa-value");
    expect(JSON.stringify(parsed)).not.toContain("full message content");
    expect(JSON.stringify(parsed)).not.toContain("+5511999999999");
    expect(JSON.stringify(parsed)).not.toContain("private-media.jpg");
    expect(JSON.stringify(parsed)).not.toContain("webhook-secret");
  });

  it("keeps webhook credentials out of platform inspection contracts", () => {
    const delivery = {
      id: "delivery_1",
      workspaceId: "workspace_1",
      workspaceName: "Workspace de teste",
      connectionId: "connection_1",
      connectionName: "Umbler Comercial",
      provider: "umbler",
      providerEventType: "Message",
      parserVersion: "v1",
      parserReleaseStatus: "observation_only",
      purpose: "message_observation",
      status: "processed",
      classification: "eligible_route_unresolved",
      firstReceivedAt: timestamp,
      lastReceivedAt: timestamp,
      attemptCount: 1,
      payloadAvailable: true,
      payloadExpiresAt: timestamp,
      providerConversionsObservedAt: null,
      parseErrorCode: null,
      routingErrorCode: "route_not_configured",
      normalizedSummary: { eventCount: 1 },
      eventCount: 1,
      channels: [
        {
          id: "channel_1",
          displayName: "Atendimento",
          connectedPhone: "+5511999999999",
        },
      ],
      secretHash: "must-be-removed",
      webhookUrl:
        "https://api.example.test/webhooks/inbound/connection_1?token=secret",
    };
    const list = backofficeInboundWebhookDeliveryListSchema.parse([delivery]);
    const payload = backofficeInboundWebhookPayloadSchema.parse({
      delivery,
      payload: { Type: "Message", Payload: { Content: "private" } },
      events: [],
      secret: "must-be-removed",
      webhookUrl:
        "https://api.example.test/webhooks/inbound/connection_1?token=secret",
    });

    expect(list[0]).not.toHaveProperty("secretHash");
    expect(list[0]).not.toHaveProperty("webhookUrl");
    expect(payload).not.toHaveProperty("secret");
    expect(payload).not.toHaveProperty("webhookUrl");
    expect(payload.payload).toEqual({
      Type: "Message",
      Payload: { Content: "private" },
    });
  });

  it("accepts global backoffice delivery counters", () => {
    expect(
      backofficeInboundWebhookDeliverySummarySchema.parse({
        all: 423,
        ctwaPending: 50,
        ctwaRouted: 0,
        failed: 0,
        noCtwa: 373,
        automationCallbacks: 12,
        awaitingParser: 3,
      }),
    ).toEqual({
      all: 423,
      ctwaPending: 50,
      ctwaRouted: 0,
      failed: 0,
      noCtwa: 373,
      automationCallbacks: 12,
      awaitingParser: 3,
    });
  });
});
