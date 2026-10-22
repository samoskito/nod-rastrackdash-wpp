import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inboundParserProductionEligible } from "../../src/inbound-webhooks/inbound-webhook-parser-eligibility";

const migrationsDir = resolve(__dirname, "../../prisma/migrations");
const migration = (name: string) =>
  readFileSync(resolve(migrationsDir, `${name}/migration.sql`), "utf8");
const code = (sql: string) => sql.replace(/--.*$/gm, "");
const schema = readFileSync(
  resolve(__dirname, "../../prisma/schema.prisma"),
  "utf8",
);

const providerMigration = "20261022130000_waha_inbound_provider";
const releaseMigration = "20261022130100_waha_parser_release";

describe("WAHA GoWS migrations", () => {
  it("adds the enum value alone, without touching parser releases in the same file", () => {
    const sql = code(migration(providerMigration));
    expect(sql).toContain(
      "ALTER TYPE \"InboundWebhookProvider\" ADD VALUE IF NOT EXISTS 'waha';",
    );
    // DiagnosticSource already has 'waha' since 20260901120000.
    expect(sql).not.toContain("DiagnosticSource");
    expect(sql).not.toContain("InboundWebhookParserRelease");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|CREATE)\b/i);
  });

  it("seeds waha v2 certified in the following migration, never activating anything", () => {
    const sql = code(migration(releaseMigration));
    expect(sql).toContain('INSERT INTO "InboundWebhookParserRelease"');
    expect(sql).toContain("'inbound_parser_waha_v2'");
    expect(sql).toMatch(/'waha',\s*'v2',\s*'certified'/u);
    expect(sql).toContain(
      "WHERE \"InboundWebhookParserRelease\".\"status\" = 'observation_only'",
    );
    expect(sql).not.toContain("'v1'");
    expect(sql).not.toMatch(
      /InboundWebhookConnection|InboundWebhookChannel|ProviderConversionRuleConfig|WhatsappInstance|productionActivatedAt|certifiedByUserId|DELETE|DROP/,
    );
  });

  it("orders the enum before the seed, after the phases it builds on", () => {
    const all = readdirSync(migrationsDir)
      .filter((name) => /^\d{14}_/.test(name))
      .sort();
    const names = all.filter((name) =>
      /^\d{14}_waha_(inbound_provider|parser_release)$/u.test(name),
    );
    expect(names).toEqual([providerMigration, releaseMigration]);
    // DiagnosticSource 'waha' (20260901120000) and URL única come first;
    // other migrations (e.g. PR #96, 20261022120000) may sit around them.
    const prerequisites = all.filter((name) =>
      /diagnostic_source_waha_zapi|integration_single_urls/u.test(name),
    );
    expect(prerequisites).toHaveLength(2);
    expect(prerequisites.every((name) => name < providerMigration)).toBe(true);
  });

  it("declares waha in both Prisma enums", () => {
    expect(schema).toMatch(/enum InboundWebhookProvider \{[^}]*\bwaha\b[^}]*\}/);
    expect(schema).toMatch(/enum DiagnosticSource \{[^}]*\bwaha\b[^}]*\}/);
  });

  it("makes waha v2 eligible only while certified", () => {
    const release = { provider: "waha", version: "v2" };
    expect(
      inboundParserProductionEligible({ ...release, status: "certified" }),
    ).toBe(true);
    expect(
      inboundParserProductionEligible({ ...release, status: "observation_only" }),
    ).toBe(false);
    expect(
      inboundParserProductionEligible({ ...release, status: "retired" }),
    ).toBe(false);
  });
});
