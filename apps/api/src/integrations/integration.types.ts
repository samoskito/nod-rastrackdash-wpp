export type IntegrationEnv = Record<string, string | undefined>;
export const INTEGRATION_ENV = Symbol("INTEGRATION_ENV");

export type IntegrationProvider = "meta" | "uazapi";
export type IntegrationStatus =
  | "connected"
  | "disconnected"
  | "syncing"
  | "error"
  | "pending_payment"
  | "needs_reconnect";

export interface IntegrationHealthDto {
  provider: IntegrationProvider;
  status: IntegrationStatus;
  checkedAt: string;
  message?: string;
}

export interface IntegrationAdapter {
  readonly provider: IntegrationProvider;
  getHealth(): Promise<IntegrationHealthDto>;
}
