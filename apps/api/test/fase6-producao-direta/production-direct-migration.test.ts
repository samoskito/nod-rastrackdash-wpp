import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  kommoConversionRuleCreateInputSchema,
  pipedriveConversionRuleCreateInputSchema,
  providerConversionRuleCreateInputSchema,
} from "@wpptrack/shared";
import { describe, expect, it } from "vitest";
import { parseInboundWebhooksConfig } from "../../src/config/deployment-config";

/**
 * Fase 6.1c — promoção, uma única vez, do que ficou em observação nas
 * instalações que já existem. Validado sem PostgreSQL (o porte roda sem
 * banco): o texto da migration é conferido por partes.
 * A execução de verdade (PostgreSQL em processo, com dados) está em
 * production-direct-migration.pglite.test.ts.
 */
const migrationsDir = resolve(__dirname, "../../prisma/migrations");
const name = "20261027125000_production_direct_validated_integrations";
const raw = readFileSync(resolve(migrationsDir, name, "migration.sql"), "utf8");
const sql = raw.replace(/--.*$/gm, "");
/** Bloco de um passo, do comentário "-- N)" até o próximo. */
function step(number: number): string {
  const start = raw.indexOf(`-- ${number})`);
  const end = raw.indexOf(`-- ${number + 1})`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  return raw
    .slice(start, end === -1 ? undefined : end)
    .replace(/--.*$/gm, "");
}

describe("migration produção direta (Fase 6.1c)", () => {
  it("fica entre a 6.1a e a 6.4, no horário reservado da 6.1c", () => {
    const all = readdirSync(migrationsDir)
      .filter((entry) => /^\d{14}_/u.test(entry))
      .sort();
    expect(all).toContain(name);
    expect(all.indexOf(name)).toBe(
      all.indexOf("20261027120000_provider_rule_cross_connection_scope") + 1,
    );
    expect(name.startsWith("20261027125000_")).toBe(true);
  });

  it("só muda dados: nenhuma tabela, coluna, índice ou tipo é criado, alterado ou removido", () => {
    expect(sql).not.toMatch(
      /\b(CREATE|ALTER|DROP|TRUNCATE|DELETE|RENAME)\b/iu,
    );
    expect(sql).not.toMatch(/\bGRANT|REVOKE\b/iu);
    const statements = sql
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean);
    for (const statement of statements) {
      expect(statement).toMatch(/^(UPDATE|WITH)\b/u);
    }
  });

  it("certifica só o leitor nativo do Meta Cloud v1 ainda em observation_only", () => {
    const certify = step(1);
    expect(certify).toContain(`"provider" = 'meta_cloud'`);
    expect(certify).toContain(`"version" = 'v1'`);
    expect(certify).toContain(`"status" = 'observation_only'`);
    expect(certify).not.toContain("retired'");
  });

  it("promove conexões só com leitor certificado do próprio provedor, sem pausa, remoção, recuperação em curso nem volta deliberada para observação", () => {
    const connections = step(2);
    expect(connections).toContain(`r."status" = 'certified'`);
    expect(connections).toContain(`r."provider" = c."provider"`);
    expect(connections).toContain(`c."status" = 'observation'`);
    expect(connections).toContain(`c."removedAt" IS NULL`);
    // Meta Cloud depende de META_APP_SECRET, que o SQL não enxerga.
    expect(connections).toContain(`c."provider" <> 'meta_cloud'`);
    expect(connections).toContain("'inbound_webhook.connection_observation'");
    expect(connections).toContain(`b."status" IN ('queued', 'processing')`);
    expect(connections).toContain(`"productionActivatedAt" = CURRENT_TIMESTAMP`);
    expect(connections).toContain("ON CONFLICT (\"id\") DO NOTHING");
    expect(connections).not.toContain("'paused'");
  });

  it("ativa só números nunca ativados, com a conexão WhatsApp ativa e sem duplicar um número já ativo", () => {
    const channels = step(3);
    expect(channels).toContain(`ch."status" = 'discovered'`);
    expect(channels).toContain(`c."status" = 'production'`);
    expect(channels).toContain(`w."status" = 'active'`);
    // A1: um número ativo OU pausado bloqueia a identidade irmã do mesmo
    // telefone (o pausado continua pausado por qualquer identidade).
    expect(channels).toContain(`sibling."status" IN ('active', 'paused')`);
    expect(channels).toContain(`sibling."connectedPhone" = ch."connectedPhone"`);
    // Duas identidades descobertas do mesmo número: só a vista por último.
    expect(channels).toContain(`sibling."status" = 'discovered'`);
    expect(channels).toContain(`sibling."lastSeenAt" > ch."lastSeenAt"`);
    expect(channels).not.toMatch(/ch\."status" = 'paused'/u);
  });

  it("dá a data desta migration a números ativos sem data (nada retroativo)", () => {
    const stamp = step(4);
    expect(stamp).toContain(`ch."productionActivatedAt" IS NULL`);
    expect(stamp).toContain(`"productionActivatedAt" = CURRENT_TIMESTAMP`);
    expect(stamp).toContain(`c."status" = 'production'`);
  });

  it("promove regras ativas em observação, respeitando pausa, unificação, remoção, leitor não certificado e decisão de tirar do envio", () => {
    const rules = step(5);
    expect(rules).toContain(`cr."active" = true`);
    expect(rules).toContain(`p."mode" = 'observation'`);
    expect(rules).toContain(`p."removedAt" IS NULL`);
    expect(rules).toContain(`p."unifiedIntoProviderRuleId" IS NULL`);
    expect(rules).toContain(`r."status" = 'certified'`);
    expect(rules).toContain(`c."removedAt" IS NULL`);
    // Regra presa a conexão que ficou fora de produção não é promovida.
    expect(rules).toContain(`c."status" IN ('production', 'paused')`);
    expect(rules).toContain(`a."resultStatus" = 'production'`);
    // D1: a regra "Lead recebido" em observação não é promovida.
    expect(rules).toContain(`cr."eventName" <> 'LeadSubmitted'`);
    expect(rules).toContain(`"productionActivatedAt" = CURRENT_TIMESTAMP`);
  });

  it("promove regras de CRM ativas (Kommo e Pipedrive) com auditoria e dá ao Pipedrive a cerca de ativação", () => {
    const crm = step(6) + step(7);
    expect(crm).toMatch(/UPDATE "KommoConversionRule"[\s\S]+"active" = true/u);
    // A Kommo não tem cerca de ativação: com evento ainda na fila na conexão,
    // a regra fica para "Ativar envio" (nada recebido antes é enviado).
    expect(crm).toContain('FROM "KommoWebhookEvent" AS e');
    expect(crm).toContain(
      `e."status" NOT IN ('observed', 'duplicate', 'blocked', 'sent', 'processed', 'dead')`,
    );
    expect(crm).toMatch(
      /UPDATE "PipedriveConversionRule"[\s\S]+"productionActivatedAt" = CURRENT_TIMESTAMP[\s\S]+"active" = true/u,
    );
    // D2: ligar com registro.
    expect(crm).toContain("'production_direct_6_1c:kommo:'");
    expect(crm).toContain("'production_direct_6_1c:pipedrive:'");
    // MÉDIA (c): as mesmas checagens da criação (requireProduction).
    for (const check of [
      `pc."status" = 'active'`,
      `pc."credentialHealthy" = true`,
      `pc."webhookSecretHash" IS NOT NULL`,
      `cardinality(pc."allowedChannelRouteIds") > 0`,
      `rt."validationStatus" = 'valid'`,
      `md."status" = 'configured'`,
    ])
      expect(crm).toContain(check);
  });

  it("é idempotente: só toca o que ainda está em observação e as auditorias têm id fixo", () => {
    expect(sql.match(/ON CONFLICT \("id"\) DO NOTHING/gu)).toHaveLength(5);
    expect(sql).toContain("'production_direct_6_1c:connection:'");
    expect(sql).toContain("'production_direct_6_1c:channel:'");
    expect(sql).toContain("'production_direct_6_1c:rule:'");
    expect(sql).toContain("'production_direct_6_1c:kommo:'");
    expect(sql).toContain("'production_direct_6_1c:pipedrive:'");
  });
});

describe("produção direta: padrões dos contratos e do servidor", () => {
  it("a regra de conversão não força modo: a API decide (nasce enviando)", () => {
    const parsed = providerConversionRuleCreateInputSchema.parse({
      name: "Qualificado",
      triggerType: "message_phrase",
      triggerPhrases: ["vou te passar os valores"],
      messageAuthorScope: "team",
      eventName: "QualifiedLead",
      scope: "all_numbers",
    });
    expect(parsed.mode).toBeUndefined();
  });

  it("Kommo nasce em produção pelo contrato", () => {
    const parsed = kommoConversionRuleCreateInputSchema.parse({
      name: "Proposta",
      pipelineId: "p1",
      statusId: "s1",
      eventName: "QualifiedLead",
    });
    expect(parsed.mode).toBe("production");
  });

  it("Pipedrive não força modo: a API faz nascer enviando quando a conexão está pronta", () => {
    const parsed = pipedriveConversionRuleCreateInputSchema.parse({
      name: "Lead",
      pipelineId: "p1",
      stageId: "s1",
      eventName: "LeadSubmitted",
    });
    expect(parsed.mode).toBeUndefined();
  });

  it("sem valor definido, o envio das regras acompanha INBOUND_CONVERSION_RULES_ENABLED", () => {
    const base = {
      INBOUND_WEBHOOKS_ENABLED: "true",
      INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      API_PUBLIC_URL: "https://api.example.test",
    };
    expect(
      parseInboundWebhooksConfig({
        ...base,
        INBOUND_CONVERSION_RULES_ENABLED: "true",
      } as never).conversionProductionEnabled,
    ).toBe(true);
    expect(
      parseInboundWebhooksConfig({
        ...base,
        INBOUND_CONVERSION_RULES_ENABLED: "true",
        INBOUND_CONVERSION_PRODUCTION_ENABLED: "",
      } as never).conversionProductionEnabled,
    ).toBe(true);
    expect(
      parseInboundWebhooksConfig({
        ...base,
        INBOUND_CONVERSION_RULES_ENABLED: "false",
      } as never).conversionProductionEnabled,
    ).toBe(false);
  });

  it("\"false\" explícito continua desligando o envio de todas as regras (interruptor do servidor)", () => {
    expect(
      parseInboundWebhooksConfig({
        INBOUND_WEBHOOKS_ENABLED: "true",
        INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
        API_PUBLIC_URL: "https://api.example.test",
        INBOUND_CONVERSION_RULES_ENABLED: "true",
        INBOUND_CONVERSION_PRODUCTION_ENABLED: "false",
      } as never).conversionProductionEnabled,
    ).toBe(false);
  });
});
