import { Injectable } from "@nestjs/common";
import type {
  ProviderConversionDecisionConversionDto,
  ProviderConversionDecisionDto,
  ProviderConversionDecisionOccurrenceDto,
  StructuredCatalogTestMessageResultDto,
} from "@wpptrack/shared";
import {
  matchProviderMessageTrigger,
  matchStructuredCatalogMessage,
  providerMessageAuthorAllowed,
} from "./structured-catalog-message.parser";
import type { ProviderConversionDecisionInput } from "./provider-conversion-decision.types";

export const PROVIDER_CONVERSION_LEGACY_ENGINE_VERSION = "legacy-v1";
const PURCHASE_DEDUPE_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Frozen compatibility evaluator used only during the channel rollout.
 * It intentionally preserves the previous "no paid lead, no decision" behavior.
 */
@Injectable()
export class ProviderConversionLegacyDecisionEngine {
  evaluate(
    input: ProviderConversionDecisionInput,
  ): ProviderConversionDecisionDto | null {
    if (
      !input.rule.active ||
      input.occurrence.eventName !== input.rule.eventName ||
      input.leadResolution.status !== "resolved"
    ) {
      return null;
    }

    if (input.rule.triggerType === "structured_catalog") {
      return this.evaluateCatalog(input);
    }
    if (input.rule.triggerType === "message_phrase") {
      return this.evaluateAverageValueMessage(input);
    }
    if (input.rule.triggerType === "provider_automation") {
      return this.evaluateAutomation(input);
    }

    return null;
  }

  private evaluateCatalog(
    input: ProviderConversionDecisionInput,
  ): ProviderConversionDecisionDto | null {
    if (
      input.occurrence.source !== "message" ||
      !input.catalog?.catalog.active ||
      !input.occurrence.authorType ||
      !providerMessageAuthorAllowed(
        input.rule.authorScope ?? "team",
        input.occurrence.authorType,
      )
    ) {
      return null;
    }

    const match = matchStructuredCatalogMessage(
      input.catalog.catalog,
      input.occurrence.messageText,
      { triggerPhrases: input.rule.triggerPhrases },
    );
    if (match.classification === "ignored") return null;

    return match.matched
      ? this.eligible(input, match, "catalog_matched")
      : this.review(input, match, match.reasonCode);
  }

  private evaluateAverageValueMessage(
    input: ProviderConversionDecisionInput,
  ): ProviderConversionDecisionDto | null {
    if (
      input.occurrence.source !== "message" ||
      !input.occurrence.authorType ||
      !providerMessageAuthorAllowed(
        input.rule.authorScope ?? "team",
        input.occurrence.authorType,
      )
    ) {
      return null;
    }

    const matchedTriggerPhrase = matchProviderMessageTrigger(
      input.occurrence.messageText,
      input.rule.triggerPhrases,
    );
    if (
      !matchedTriggerPhrase ||
      !input.rule.defaultValueCents ||
      !input.rule.defaultCurrency
    ) {
      return null;
    }

    return this.eligible(
      input,
      this.averageValueMatch(input, matchedTriggerPhrase),
      "average_value_message_matched",
    );
  }

  private evaluateAutomation(
    input: ProviderConversionDecisionInput,
  ): ProviderConversionDecisionDto | null {
    if (input.occurrence.source !== "automation") return null;

    if (input.rule.eventName === "QualifiedLead") {
      return this.eligible(
        input,
        this.qualifiedLeadMatch(),
        "automation_matched",
      );
    }
    if (!input.rule.defaultValueCents || !input.rule.defaultCurrency) {
      return null;
    }

    return this.eligible(
      input,
      this.averageValueMatch(input, null),
      "automation_matched",
    );
  }

  private eligible(
    input: ProviderConversionDecisionInput,
    match: StructuredCatalogTestMessageResultDto,
    reasonCode: string,
  ): ProviderConversionDecisionDto {
    if (input.leadResolution.status !== "resolved") {
      throw new Error("Legacy eligible decisions require a resolved paid lead");
    }

    return {
      ...this.base(input, this.conversion(match)),
      decisionCode: "eligible",
      reasonCode,
      leadResolution: input.leadResolution,
    };
  }

  private review(
    input: ProviderConversionDecisionInput,
    match: StructuredCatalogTestMessageResultDto,
    reasonCode: string,
  ): ProviderConversionDecisionDto {
    if (input.leadResolution.status !== "resolved") {
      throw new Error("Legacy review decisions require a resolved paid lead");
    }

    return {
      ...this.base(input, this.conversion(match)),
      decisionCode: "review_required",
      reasonCode,
      leadResolution: input.leadResolution,
    };
  }

  private base(
    input: ProviderConversionDecisionInput,
    conversion: ProviderConversionDecisionConversionDto,
  ) {
    return {
      engineVersion: PROVIDER_CONVERSION_LEGACY_ENGINE_VERSION,
      parserVersion: input.parserVersion,
      occurrence: this.occurrence(input),
      rule: input.rule,
      catalog: input.catalog,
      conversion,
    };
  }

  private occurrence(
    input: ProviderConversionDecisionInput,
  ): ProviderConversionDecisionOccurrenceDto {
    const lead = input.leadResolution;
    if (lead.status !== "resolved") {
      throw new Error("Legacy occurrences require a resolved paid lead");
    }
    const scopeKey = [
      input.rule.eventName,
      input.occurrence.workspaceId,
      lead.lead.id,
    ].join(":");

    return {
      source: input.occurrence.source,
      provider: input.occurrence.provider,
      workspaceId: input.occurrence.workspaceId,
      connectionId: input.occurrence.connectionId,
      channelId: input.occurrence.channelId,
      externalDeliveryId: input.occurrence.externalDeliveryId,
      externalEventId: input.occurrence.externalEventId,
      externalMessageId: input.occurrence.externalMessageId,
      occurrenceKey: input.occurrence.occurrenceKey,
      ...(input.occurrence.purchaseKey
        ? { purchaseKey: input.occurrence.purchaseKey }
        : {}),
      businessDedupePolicy:
        input.occurrence.provider === "payt" && input.occurrence.purchaseKey
          ? { mode: "lifetime", scopeKey: input.occurrence.purchaseKey }
          : input.rule.eventName === "QualifiedLead"
            ? {
                mode: "lifetime",
                scopeKey,
              }
            : {
                mode: "rolling_window",
                scopeKey,
                windowSeconds: PURCHASE_DEDUPE_WINDOW_SECONDS,
              },
      eventName: input.occurrence.eventName,
      occurredAt: input.occurrence.occurredAt,
      authorType: input.occurrence.authorType,
      contactIdentityHash: input.contactIdentityHash,
    };
  }

  private conversion(
    match: StructuredCatalogTestMessageResultDto,
  ): ProviderConversionDecisionConversionDto {
    return {
      matchedTriggerPhrase: match.matchedTriggerPhrase,
      items: match.items,
      valueCents: match.calculatedValueCents,
      observedPaymentValueCents: match.observedPaymentValueCents,
      currency: match.currency,
      contentName: match.contentName,
    };
  }

  private averageValueMatch(
    input: ProviderConversionDecisionInput,
    matchedTriggerPhrase: string | null,
  ): StructuredCatalogTestMessageResultDto {
    return {
      matched: true,
      reasonCode: "matched",
      classification: "recognized",
      matchedTriggerPhrase,
      parsedAttributes: [],
      items: [],
      parsedValueCents: input.rule.defaultValueCents,
      calculatedValueCents: input.rule.defaultValueCents,
      observedPaymentValueCents: null,
      catalogVariantId: null,
      contentName: input.rule.defaultContentName,
      currency: input.rule.defaultCurrency,
    };
  }

  private qualifiedLeadMatch(): StructuredCatalogTestMessageResultDto {
    return {
      matched: true,
      reasonCode: "matched",
      classification: "recognized",
      matchedTriggerPhrase: null,
      parsedAttributes: [],
      items: [],
      parsedValueCents: null,
      calculatedValueCents: null,
      observedPaymentValueCents: null,
      catalogVariantId: null,
      contentName: null,
      currency: null,
    };
  }
}
