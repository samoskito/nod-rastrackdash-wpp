import { describe, expect, it } from "vitest";
import { parseMoneyInputToCents } from "../src/lib/money-input";

describe("money input", () => {
  it.each([
    ["50", 5_000],
    ["50,00", 5_000],
    ["50.00", 5_000],
    ["1.234,56", 123_456],
    ["1,234.56", 123_456],
    ["R$ 99,90", 9_990],
    ["0", 0],
  ])("parses %s without changing the negotiated amount", (value, expected) => {
    expect(parseMoneyInputToCents(value)).toBe(expected);
  });

  it.each(["", "-1", "R$ -50,00"])("rejects invalid value %s", (value) => {
    expect(() => parseMoneyInputToCents(value)).toThrow(
      "Valor mensal inválido",
    );
  });
});
