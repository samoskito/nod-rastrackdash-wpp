import type { CurrencyCode, CurrentWorkspaceDto } from "@wpptrack/shared";
import { getWorkspaceCurrencySettings } from "./currency-settings";
import { fetchLicenseStatus, licenseLockReason } from "./license-status";
import { serverApiFetch } from "./server-api";

export type ManualConversionAccess = {
  canManage: boolean;
  currency: CurrencyCode;
  /** nod: licença bloqueada (a API responde 423 a qualquer escrita). */
  licenseLocked: boolean;
};

/**
 * Manual conversion (tarefa 21) and CRM Kanban moves: only owners/admins
 * (canManageIntegrations); the API enforces it again. Never throws: any
 * failure hides the action. With the license locked the action stays visible
 * but disabled (the API answers 423 to every write).
 */
export async function getManualConversionAccess(): Promise<ManualConversionAccess> {
  try {
    const workspace =
      await serverApiFetch<CurrentWorkspaceDto>("/workspaces/current");
    if (!workspace?.permissions?.canManageIntegrations)
      return { canManage: false, currency: "BRL", licenseLocked: false };
    const [settings, license] = await Promise.all([
      getWorkspaceCurrencySettings(),
      fetchLicenseStatus().catch(() => null),
    ]);
    return {
      canManage: true,
      currency: settings?.conversionCurrency ?? "BRL",
      licenseLocked: Boolean(license && licenseLockReason(license) !== null),
    };
  } catch {
    return { canManage: false, currency: "BRL", licenseLocked: false };
  }
}
