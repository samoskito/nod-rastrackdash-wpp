import type {
  AdAccountCurrencyListDto,
  WorkspaceCurrencySettingsDto,
} from "@wpptrack/shared";
import { serverApiFetch } from "./server-api";

/** GET /workspaces/current/currency; null quando indisponível (nunca trava a página). */
export async function getWorkspaceCurrencySettings(): Promise<WorkspaceCurrencySettingsDto | null> {
  try {
    const settings = await serverApiFetch<WorkspaceCurrencySettingsDto>(
      "/workspaces/current/currency",
    );

    return settings && typeof settings.conversionCurrency === "string"
      ? settings
      : null;
  } catch {
    return null;
  }
}

/** GET /workspaces/current/currency/ad-accounts; null quando indisponível. */
export async function getAdAccountCurrencies(): Promise<AdAccountCurrencyListDto | null> {
  try {
    const list = await serverApiFetch<AdAccountCurrencyListDto>(
      "/workspaces/current/currency/ad-accounts",
    );

    return list && Array.isArray(list.accounts) ? list : null;
  } catch {
    return null;
  }
}
