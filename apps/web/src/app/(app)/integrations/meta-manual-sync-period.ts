export type InitialManualMetaSyncPeriod = {
  since: string;
  until: string;
  anchorSource: "whatsapp_instance" | "inbound_webhook_connection" | null;
  lookbackDaysApplied: number;
};
