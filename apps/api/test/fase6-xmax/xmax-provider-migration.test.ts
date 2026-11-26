import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { webhookDedupePolicy } from "../../src/conversion-rules/webhook-purchase-dedupe";
import { inboundParserProductionEligible } from "../../src/inbound-webhooks/inbound-webhook-parser-eligibility";

/**
 * XMAX CRM: duas migrations aditivas (enum, depois o leitor). O leitor nasce
 * EM OBSERVAÇÃO: nada da XMAX vai para a Meta até uma migration futura
 * certificar, depois do teste com uma chamada real.
 */
const read = (name: string) =>
  readFileSync(
    resolve(__dirname, `../../prisma/migrations/${name}/migration.sql`),
    "utf8",
  );
const enumMigration = read("20261126120000_xmax_provider");
const releaseMigration = read("20261126120100_xmax_parser_release");

describe("XMAX CRM migrations", () => {
  it("commits the enum values before any row uses them", () => {
    expect(enumMigration).toContain(
      "ALTER TYPE \"InboundWebhookProvider\" ADD VALUE IF NOT EXISTS 'xmax'",
    );
    expect(enumMigration).toContain(
      "ALTER TYPE \"DiagnosticSource\" ADD VALUE IF NOT EXISTS 'xmax'",
    );
    expect(enumMigration).not.toMatch(/\bINSERT INTO\b/i);
  });

  it("seeds the reader observation_only, idempotent", () => {
    expect(releaseMigration).toContain('INSERT INTO "InboundWebhookParserRelease"');
    expect(releaseMigration).toContain("'inbound_parser_xmax_automation_v1'");
    expect(releaseMigration).toContain("'automation-v1'");
    expect(releaseMigration.match(/'observation_only'/g)).toHaveLength(1);
    expect(releaseMigration).not.toContain("'certified'");
    expect(releaseMigration).toContain(
      'ON CONFLICT ("provider", "version") DO NOTHING',
    );
  });

  it("does not mutate existing customer records", () => {
    for (const migration of [enumMigration, releaseMigration]) {
      expect(migration).not.toMatch(/\b(?:UPDATE|DELETE FROM|DROP)\b/i);
      expect(migration).not.toMatch(/ALTER TABLE/i);
    }
  });

  it("is production-eligible only once a future migration certifies it", () => {
    expect(
      inboundParserProductionEligible({
        provider: "xmax",
        version: "automation-v1",
        status: "observation_only",
      }),
    ).toBe(false);
    expect(
      inboundParserProductionEligible({
        provider: "xmax",
        version: "automation-v1",
        status: "certified",
      }),
    ).toBe(true);
  });
});

describe("XMAX CRM business dedupe", () => {
  const input = (eventName: string, occurrenceKey: string) =>
    ({
      rule: { eventName },
      occurrence: {
        source: "automation",
        provider: "xmax",
        workspaceId: "workspace_1",
        connectionId: "connection_anchor",
        channelId: "channel_a",
        occurrenceKey,
        observedValueCents: null,
        observedCurrency: null,
      },
      leadResolution: { status: "resolved", lead: { id: "lead_1" } },
    }) as never;

  it("a window event: the opportunity + event key is the occurrence (two opportunities = two)", () => {
    const a = webhookDedupePolicy(input("Purchase", "xmax-opportunity:1"))!;
    const again = webhookDedupePolicy(input("Purchase", "xmax-opportunity:1"))!;
    const b = webhookDedupePolicy(input("Purchase", "xmax-opportunity:2"))!;
    expect(a).toMatchObject({ mode: "rolling_window", windowSeconds: 2_592_000 });
    expect(a.scopeKey).toBe(again.scopeKey);
    expect(a.scopeKey).not.toBe(b.scopeKey);
  });

  it("lifetime events stay once per lead (lifetime lock, not this policy)", () => {
    expect(
      webhookDedupePolicy(input("QualifiedLead", "xmax-opportunity:1")),
    ).toBeNull();
    expect(
      webhookDedupePolicy(input("LeadSubmitted", "xmax-opportunity:1")),
    ).toBeNull();
  });
});
