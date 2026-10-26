/**
 * LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED ("Lead recebido pela regra", porte do
 * SaaS #155). Produção direta (regra fixa do produto, 26/10/2026): o
 * comportamento já validado em produção no SaaS vale para o aluno sem etapa
 * de teste, então a variável vem LIGADA por padrão nesta edição.
 *
 * - sem valor (ou vazia): ligada;
 * - "false", "0", "off" ou "no" (sem diferenciar maiúsculas): desligada;
 * - qualquer outro valor: ligada.
 *
 * Nunca lança: é lida no caminho de entrada dos webhooks, nos relatórios e no
 * guard de conversão única por lead. Todos os espelhos da variável
 * (lead-cohort, relatórios, guard, regras) usam esta mesma função.
 */
export const LEAD_SUBMITTED_RULE_OVERRIDE_FLAG =
  "LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED";

const DISABLED_VALUES = new Set(["false", "0", "off", "no"]);

export function leadSubmittedRuleOverrideEnabled(
  env: Record<string, string | undefined>,
): boolean {
  const normalized = env[LEAD_SUBMITTED_RULE_OVERRIDE_FLAG]?.trim().toLowerCase();
  if (!normalized) return true;
  return !DISABLED_VALUES.has(normalized);
}
