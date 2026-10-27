import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  listWorkspaceScopeChannels,
  samePhoneChannels,
} from "../conversion-rules/provider-rule-scope";
import { InboundConversionAutomationIngestionService } from "./inbound-conversion-automation-ingestion.service";
import {
  loadRoutingRules,
  pickRoutedRuleOutcome,
} from "./integration-endpoint-routing";
import { isRoichatPurchasePayload } from "./providers/roichat/roichat-payload";
import type {
  RoichatPurchaseIngressHandler,
  RoichatPurchaseIngressInput,
  RoichatPurchaseIngressResult,
} from "./roichat-purchase-ingress.token";

/**
 * ROI Chat: one URL per number receives both the lead entry and the purchase.
 * A purchase (`event_name: "Purchase"`) is routed here, to the rule
 * "Compra no ROI Chat" that owns THE URL'S NUMBER (a specific rule of that
 * number wins over the rule for all ROI Chat numbers; two rules of the same
 * tier hold the purchase instead of guessing). The rule pipeline then repeats
 * every check (lead from an ad, certification, production, dedupe).
 *
 * Nothing here logs payload fields or secrets.
 */
@Injectable()
export class RoichatPurchaseIngressService
  implements RoichatPurchaseIngressHandler
{
  private readonly logger = new Logger(RoichatPurchaseIngressService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InboundConversionAutomationIngestionService)
    private readonly automation: InboundConversionAutomationIngestionService,
  ) {}

  async ingestPurchase(
    input: RoichatPurchaseIngressInput,
  ): Promise<RoichatPurchaseIngressResult | null> {
    let payload: unknown;
    try {
      payload = JSON.parse(input.rawBody.toString("utf8"));
    } catch {
      return null;
    }
    if (!isRoichatPurchasePayload(payload)) return null;

    const workspaceId = input.connection.workspaceId;
    const channels = (
      await listWorkspaceScopeChannels(this.prisma, workspaceId)
    ).filter((channel) => channel.provider === "roichat");
    // The connection's own number: one connection = one number = one URL.
    const channel = channels.find(
      (candidate) => candidate.connectionId === input.connection.id,
    );
    if (!channel) return this.unrouted(input, "number_missing");

    const rules = await loadRoutingRules(this.prisma, {
      workspaceId,
      provider: "roichat",
      eventName: "Purchase",
    });
    const outcome = pickRoutedRuleOutcome(rules, channel, {
      phoneChannels: samePhoneChannels(channels, channel.id),
      productCodes: null,
    });
    if (outcome.status !== "picked") {
      return this.unrouted(
        input,
        outcome.status === "ambiguous" ? "multiple_rules" : "no_rule",
      );
    }

    const result = await this.automation.ingestFromConnection({
      workspaceId,
      providerRuleId: outcome.rule.id,
      rawBody: input.rawBody,
      providerAttempt: input.providerAttempt,
      origin: { connectionId: channel.connectionId, channelId: channel.id },
    });
    if (!result) return this.unrouted(input, "rule_unavailable");
    return { ...result, providerRuleId: outcome.rule.id };
  }

  private unrouted(
    input: RoichatPurchaseIngressInput,
    reason: string,
  ): null {
    this.logger.log(
      JSON.stringify({
        event: "roichat_purchase.unrouted",
        workspaceId: input.connection.workspaceId,
        connectionId: input.connection.id,
        reason,
      }),
    );
    return null;
  }
}
