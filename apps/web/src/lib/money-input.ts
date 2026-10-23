export function parseMoneyInputToCents(value: string): number {
  const raw = value.trim().replace(/[^\d,.-]/g, "");
  if (!raw || raw.startsWith("-")) {
    throw new Error("Valor mensal inválido");
  }

  const lastComma = raw.lastIndexOf(",");
  const lastDot = raw.lastIndexOf(".");
  const decimalSeparator =
    lastComma >= 0 && lastDot >= 0
      ? lastComma > lastDot
        ? ","
        : "."
      : inferSingleSeparator(raw);

  let normalized: string;
  if (decimalSeparator) {
    const separatorIndex = raw.lastIndexOf(decimalSeparator);
    const integer = raw.slice(0, separatorIndex).replace(/\D/g, "");
    const fraction = raw.slice(separatorIndex + 1).replace(/\D/g, "");
    normalized = `${integer || "0"}.${fraction}`;
  } else {
    normalized = raw.replace(/\D/g, "");
  }

  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Valor mensal inválido");
  }

  return Math.round(amount * 100);
}

function inferSingleSeparator(value: string): "," | "." | null {
  const separator = value.includes(",")
    ? ","
    : value.includes(".")
      ? "."
      : null;
  if (!separator) {
    return null;
  }

  const occurrences = value.split(separator).length - 1;
  const fractionLength = value.length - value.lastIndexOf(separator) - 1;
  return occurrences === 1 && fractionLength > 0 && fractionLength <= 2
    ? separator
    : null;
}
