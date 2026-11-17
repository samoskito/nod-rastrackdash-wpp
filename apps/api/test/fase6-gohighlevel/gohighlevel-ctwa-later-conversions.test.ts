import { describe, expect, it, vi } from "vitest";
import { providerConversionDecisionSchema } from "@wpptrack/shared";
import { offline } from "../fase4-unnichat/helpers/first-entry-offline";
import { ProviderConversionDecisionEngine } from "../../src/conversion-rules/provider-conversion-decision.engine";
import { ProviderConversionPaidLeadResolver } from "../../src/conversion-rules/provider-conversion-paid-lead-resolver.service";
import { ProviderConversionProductionService } from "../../src/inbound-webhook-production/provider-conversion-production.service";
import { parseGoHighLevelAutomationV1 } from "../../src/inbound-webhooks/providers/gohighlevel/gohighlevel-automation-v1.parser";
import { InboundWebhookParserRegistry } from "../../src/inbound-webhooks/providers/inbound-webhook-parser.registry";
import { InboundWebhookMetaRouteReaderService } from "../../src/inbound-webhooks/inbound-webhook-meta-route-reader.service";

/**
 * GoHighLevel: a Workflow step (ação Webhook) converts a lead that entered
 * through a CTWA ad WITHOUT ad id. Real entry production, paid-lead resolver,
 * decision engine, automation production, queue, processor and Meta adapter;
 * storage is a fake. Same path as the Unnichat no-ad later conversions.
 * Synthetic data only.
 */
describe("GoHighLevel workflow conversions of a no-ad CTWA lead", () => {
  it.each(["QualifiedLead", "Purchase", "LeadSubmitted"] as const)(
    "materializes and sends %s with the entry's page/pixel proof (receivedAt as event time)",
    async (eventName) => {
      const h = offline({ provider: "gohighlevel" });
      h.channel.conversionEngineMode = "canonical";
      // 1) The entry (v1) of the same location becomes the lead + LeadSubmitted.
      await h.production.processItem({ workspaceId: "w", productionItemId: "item" });
      expect(h.logs[0]).toMatchObject({
        eventName: "LeadSubmitted",
        sourceTrigger: "inbound_webhook:gohighlevel",
      });
      await h.processor.process(h.jobs[0]);

      h.prisma.inboundWebhookEvent.findFirst = vi.fn(async () => ({
        ...h.event,
        productionItem: h.item,
      }));
      // 2) The later Workflow call resolves the lead by the entry proof.
      const leadResolution = await new ProviderConversionPaidLeadResolver(
        h.prisma,
      ).resolve({
        workspaceId: "w",
        phone: h.payload.phone,
        channelId: "ch",
        connectionId: "c",
      });
      expect(leadResolution.status).toBe("resolved");
      const receivedAt = new Date();
      const automationPayload = {
        ...h.payload,
        workflow: { id: `workflow_${eventName}`, name: eventName },
      };
      const parsed = parseGoHighLevelAutomationV1(automationPayload, receivedAt);
      if (!parsed.ok) throw new Error("parse");
      // Never date_created (contact creation): the arrival of the call.
      expect(parsed.value.occurredAt.getTime()).toBe(receivedAt.getTime());
      const rule: any = {
        providerRuleId: "rule",
        conversionRuleId: "conversion_rule",
        version: new Date().toISOString(),
        triggerType: "provider_automation",
        eventName,
        mode: "production",
        active: true,
        authorScope: null,
        triggerPhrases: [],
        defaultValueCents: eventName === "Purchase" ? 25000 : null,
        defaultCurrency: eventName === "Purchase" ? "BRL" : null,
        defaultContentName: null,
        valueMode: "fixed",
        exampleMessage: null,
      };
      const decision = new ProviderConversionDecisionEngine().evaluate({
        parserVersion: "automation-v1",
        rule,
        catalog: null,
        leadResolution,
        contactIdentityHash: h.leads[0].phoneHash,
        occurrence: {
          source: "automation",
          provider: "gohighlevel",
          workspaceId: "w",
          connectionId: "c",
          channelId: "ch",
          externalDeliveryId: "automation_delivery",
          externalEventId: null,
          externalMessageId: null,
          occurrenceKey: parsed.value.externalExecutionKey,
          eventName,
          occurredAt: parsed.value.occurredAt.toISOString(),
          authorType: null,
          automation: "crm_movement",
        },
      } as any);
      expect(decision?.decisionCode).toBe("eligible");
      expect(providerConversionDecisionSchema.safeParse(decision).success).toBe(true);
      const execution: any = {
        id: "execution",
        workspaceId: "w",
        channelId: "ch",
        channel: h.channel,
        leadId: "lead",
        providerRuleId: "rule",
        sourceDeliveryId: "automation_delivery",
        externalExecutionKey: parsed.value.externalExecutionKey,
        status: "eligible",
        occurredAt: parsed.value.occurredAt,
        providerDecisionId: "decision",
        providerDecision: {
          id: "decision",
          workspaceId: "w",
          providerRuleId: "rule",
          sourceDeliveryId: "automation_delivery",
          decisionCode: "eligible",
          occurrenceKey: parsed.value.externalExecutionKey,
          eventName,
          occurredAt: parsed.value.occurredAt,
          leadId: "lead",
          decisionJson: decision,
        },
        providerRule: {
          ...rule,
          id: "rule",
          connectionId: "c",
          mode: "production",
          productionActivatedAt: h.channel.productionActivatedAt,
          removedAt: null,
          conversionRule: rule,
          parserRelease: {
            provider: "gohighlevel",
            version: "automation-v1",
            status: "certified",
          },
          connection: h.channel.connection,
          channels: [{ channelId: "ch" }],
        },
        sourceDelivery: {
          ...h.event.delivery,
          id: "automation_delivery",
          providerRuleEndpointId: "endpoint",
          purpose: "conversion_automation",
          parserVersion: "automation-v1",
          firstReceivedAt: receivedAt,
        },
        contactIdentityHash: h.leads[0].phoneHash,
        purchaseReview: null,
        normalizedResult: null,
      };
      h.prisma.providerConversionRuleExecution = {
        findFirst: vi.fn(async ({ where }: any) =>
          typeof where.id === "string" ? execution : null,
        ),
        findMany: vi.fn(async () => []),
        update: vi.fn(async ({ data }: any) => Object.assign(execution, data)),
        updateMany: vi.fn(async () => ({ count: 1 })),
      };
      h.prisma.purchaseReview = { updateMany: vi.fn(async () => ({ count: 0 })) };
      const service = new ProviderConversionProductionService(
        h.prisma,
        { decrypt: () => Buffer.from(JSON.stringify(automationPayload)) } as any,
        new InboundWebhookParserRegistry(),
        {} as any,
        new InboundWebhookMetaRouteReaderService(h.prisma),
        h.conversions,
        h.queue,
        // No billing module in this edition.
        {
          NODE_ENV: "test",
          INBOUND_WEBHOOKS_ENABLED: "true",
          INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
          INBOUND_CONVERSION_RULES_ENABLED: "true",
          INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
          API_PUBLIC_URL: "http://localhost:3333",
          INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
        },
      );
      const result = await service.processExecution({
        workspaceId: "w",
        providerConversionExecutionId: "execution",
      });
      if (eventName === "LeadSubmitted") {
        // The entry already sent Lead recebido for this lead and pixel:
        // the rule never sends it twice (once per lead).
        expect(result).toEqual({ status: "duplicate" });
        expect(h.calls).toHaveLength(1);
        return;
      }
      expect(result).toMatchObject({ status: "materialized" });
      expect(h.logs[1]).toMatchObject({
        eventName,
        adId: null,
        metaAccountId: null,
        status: "ready_to_send",
        eventOccurredAt: receivedAt,
        sourceTrigger: "inbound_webhook:gohighlevel:provider_automation",
      });
      expect(await h.processor.process(h.jobs[1])).toMatchObject({ status: "sent" });
      expect(h.calls).toHaveLength(2);
      expect(h.calls[1].body.data[0].event_time).toBe(
        Math.floor(receivedAt.getTime() / 1000),
      );
      expect(h.calls[1].body.data[0].user_data).toMatchObject({
        ctwa_clid: "synthetic-ghl-click",
      });
      expect(h.calls[1].body.data[0].custom_data).not.toHaveProperty("ad_id");
    },
  );
});
