import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inboundParserProductionEligible } from "../../src/inbound-webhooks/inbound-webhook-parser-eligibility";

/**
 * Porte do SaaS (057d6e08 + e279af76), adaptado: no nod as duas migrations
 * têm timestamps novos e os dois leitores (entrada v1 e etapa automation-v1)
 * nascem EM OBSERVAÇÃO, como no SaaS. Nada do GoHighLevel vai para a Meta
 * até uma migration futura certificar os leitores.
 */
const enumMigration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20261117120000_gohighlevel_provider/migration.sql",
  ),
  "utf8",
);

const parserReleaseMigration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20261117120100_gohighlevel_parser_releases/migration.sql",
  ),
  "utf8",
);

describe("GoHighLevel migrations (nod)", () => {
  it("commits the provider enums before any GoHighLevel row uses them", () => {
    expect(enumMigration).toContain(
      "ALTER TYPE \"InboundWebhookProvider\" ADD VALUE IF NOT EXISTS 'gohighlevel'",
    );
    expect(enumMigration).toContain(
      "ALTER TYPE \"DiagnosticSource\" ADD VALUE IF NOT EXISTS 'gohighlevel'",
    );
    expect(enumMigration).not.toMatch(/\bINSERT INTO\b/i);
    // Vagas/assinatura são só do SaaS.
    expect(enumMigration).not.toMatch(/ALTER TYPE "WhatsappSeatProvider"/);
  });

  it("seeds both readers observation_only in the following migration", () => {
    expect(parserReleaseMigration).toContain(
      'INSERT INTO "InboundWebhookParserRelease"',
    );
    expect(parserReleaseMigration).toContain("'inbound_parser_gohighlevel_v1'");
    expect(parserReleaseMigration).toContain(
      "'inbound_parser_gohighlevel_automation_v1'",
    );
    expect(parserReleaseMigration).toContain("'automation-v1'");
    expect(parserReleaseMigration).not.toContain("'certified'");
    expect(parserReleaseMigration.match(/'observation_only'/g)).toHaveLength(2);
    expect(parserReleaseMigration).toContain(
      'ON CONFLICT ("provider", "version") DO NOTHING',
    );
  });

  it("does not mutate existing customer records", () => {
    for (const migration of [enumMigration, parserReleaseMigration]) {
      expect(migration).not.toMatch(/\b(?:UPDATE|DELETE FROM|DROP)\b/i);
      expect(migration).not.toMatch(/ALTER TABLE/i);
    }
  });

  it("is production-eligible only once a future migration certifies it", () => {
    for (const version of ["v1", "automation-v1"]) {
      expect(
        inboundParserProductionEligible({
          provider: "gohighlevel",
          version,
          status: "observation_only",
        }),
      ).toBe(false);
      expect(
        inboundParserProductionEligible({
          provider: "gohighlevel",
          version,
          status: "certified",
        }),
      ).toBe(true);
    }
  });
});
