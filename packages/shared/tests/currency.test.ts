import { describe, expect, it } from "vitest";
import {
  adAccountCurrencyListSchema,
  adAccountCurrencyOverrideInputSchema,
  currencyCodeSchema,
  effectiveAccountCurrency,
  formatMoney,
  normalizeCurrencyCode,
  resolveConversionCurrency,
  supportedCurrencyOptions,
  workspaceCurrencySettingsSchema,
  workspaceCurrencyUpdateInputSchema,
} from "../src";

describe("currency contracts (Fase 5.1)", () => {
  it("accepts only BRL, USD and EUR", () => {
    expect(currencyCodeSchema.parse("USD")).toBe("USD");
    expect(currencyCodeSchema.safeParse("GBP").success).toBe(false);
    expect(currencyCodeSchema.safeParse("usd").success).toBe(false);
    expect(normalizeCurrencyCode(" usd ")).toBe("USD");
    expect(normalizeCurrencyCode("GBP")).toBeNull();
    expect(normalizeCurrencyCode(null)).toBeNull();
  });

  it("formats money per currency in pt-BR", () => {
    expect(formatMoney(123456, "BRL")).toBe("R$ 1.234,56");
    expect(formatMoney(123456, "USD")).toBe("US$ 1.234,56");
    expect(formatMoney(123456, "EUR")).toBe("€ 1.234,56");
    expect(formatMoney(5, "BRL")).toBe("R$ 0,05");
    expect(formatMoney(-150, "USD")).toBe("-US$ 1,50");
    expect(formatMoney(123456789, "BRL")).toBe("R$ 1.234.567,89");
    expect(formatMoney(null, "BRL")).toBe("-");
    expect(formatMoney(100)).toBe("R$ 1,00");
  });

  it("resolves the account currency: override, then Meta, then BRL", () => {
    expect(effectiveAccountCurrency({ currency: "USD" })).toBe("USD");
    expect(
      effectiveAccountCurrency({ currency: "USD", currencyOverride: "EUR" }),
    ).toBe("EUR");
    expect(effectiveAccountCurrency({ currency: "GBP" })).toBe("BRL");
    expect(effectiveAccountCurrency({})).toBe("BRL");
  });

  it("resolves the conversion currency: sale, rule, workspace, BRL", () => {
    expect(
      resolveConversionCurrency({ payload: "eur", rule: "USD", workspace: "BRL" }),
    ).toBe("EUR");
    expect(
      resolveConversionCurrency({ payload: null, rule: "USD", workspace: "EUR" }),
    ).toBe("USD");
    expect(resolveConversionCurrency({ rule: null, workspace: "EUR" })).toBe(
      "EUR",
    );
    expect(resolveConversionCurrency({ payload: "GBP" })).toBe("BRL");
    expect(resolveConversionCurrency({})).toBe("BRL");
  });

  it("validates the settings inputs and outputs", () => {
    expect(
      workspaceCurrencyUpdateInputSchema.parse({ conversionCurrency: "USD" }),
    ).toEqual({ conversionCurrency: "USD" });
    expect(
      workspaceCurrencyUpdateInputSchema.safeParse({ conversionCurrency: "ARS" })
        .success,
    ).toBe(false);
    expect(
      workspaceCurrencyUpdateInputSchema.safeParse({
        conversionCurrency: "USD",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      adAccountCurrencyOverrideInputSchema.parse({ currencyOverride: null }),
    ).toEqual({ currencyOverride: null });
    expect(
      workspaceCurrencySettingsSchema.safeParse({
        workspaceId: "w",
        conversionCurrency: "BRL",
        supportedCurrencies: ["BRL", "USD", "EUR"],
        canManage: false,
      }).success,
    ).toBe(true);
    expect(
      adAccountCurrencyListSchema.safeParse({
        accounts: [
          {
            id: "rep_1",
            adAccountId: "act_1",
            adAccountName: "Conta",
            businessId: "bm_1",
            businessName: "BM",
            active: true,
            detectedCurrency: "GBP",
            detectedCurrencySupported: false,
            currencyOverride: null,
            effectiveCurrency: "BRL",
          },
        ],
        currencies: ["BRL"],
        canManage: true,
      }).success,
    ).toBe(true);
    expect(supportedCurrencyOptions.map((option) => option.code)).toEqual([
      "BRL",
      "USD",
      "EUR",
    ]);
  });
});
