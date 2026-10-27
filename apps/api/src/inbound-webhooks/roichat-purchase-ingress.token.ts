/**
 * DI contract between the generic number-URL ingestion
 * (InboundWebhookIngestionService) and the ROI Chat purchase router
 * (RoichatPurchaseIngressService). Kept in its own file so the ingestion
 * service never imports the automation pipeline (no import cycle).
 */
export const ROICHAT_PURCHASE_INGRESS = Symbol("ROICHAT_PURCHASE_INGRESS");

export type RoichatPurchaseIngressInput = {
  connection: { id: string; workspaceId: string };
  rawBody: Buffer;
  providerAttempt: number | null;
};

export type RoichatPurchaseIngressResult = {
  status: "accepted";
  deliveryId: string;
  duplicate: boolean;
  observationStatus: string;
  providerRuleId: string;
};

export interface RoichatPurchaseIngressHandler {
  /**
   * Null when the body is not a purchase or no rule owns the number: the
   * caller then stores it as a normal delivery of the connection (audit; the
   * v1 parser records "compra sem regra").
   */
  ingestPurchase(
    input: RoichatPurchaseIngressInput,
  ): Promise<RoichatPurchaseIngressResult | null>;
}
