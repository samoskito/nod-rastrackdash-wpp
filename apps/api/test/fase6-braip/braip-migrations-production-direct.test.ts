import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  effectiveInboundParserStatus,
  inboundParserProductionEligible,
} from "../../src/inbound-webhooks/inbound-webhook-parser-eligibility";
import {
  bornChannelState,
  bornConnectionStatus,
  productionDirectEligible,
} from "../../src/inbound-webhooks/production-direct";
import {
  isSalesPlatformProvider,
  salesPlatformOf,
} from "../../src/inbound-webhooks/providers/sales-platform-sale";

/**
 * Fase 6.5 (nod): Braip on the single-URL base, production direct. The
 * reader was validated in the SaaS against the official Braip postback
 * (#168), so its release enters CERTIFIED by migration and the student never
 * releases or certifies anything. Text checks only: never PostgreSQL here
 * (the full chain runs on a throwaway Postgres in the release check).
 */

const migrationsDir = resolve(__dirname, "../../prisma/migrations");
const read = (name: string) =>
  readFileSync(resolve(migrationsDir, name, "migration.sql"), "utf8");
const providerName = "20261027140000_braip_provider";
const releaseName = "20261027140100_braip_parser_release";

describe("Braip migrations", () => {
  const provider = read(providerName);
  const release = read(releaseName);

  it("uses the reserved timestamps, after every migration of fase 6.4", () => {
    const names = readdirSync(migrationsDir)
      .filter((entry) => /^\d{14}_/u.test(entry))
      .sort();
    expect(names).toContain(providerName);
    expect(names).toContain(releaseName);
    expect(names.indexOf(providerName)).toBeGreaterThan(
      names.indexOf("20261027130100_meta_reporting_sync_block"),
    );
    expect(names.indexOf(releaseName)).toBe(names.indexOf(providerName) + 1);
  });

  it("adds the enum values alone (no row using 'braip' in the same file: P3009)", () => {
    expect(provider).toContain(
      `ALTER TYPE "InboundWebhookProvider" ADD VALUE IF NOT EXISTS 'braip'`,
    );
    expect(provider).toContain(
      `ALTER TYPE "DiagnosticSource" ADD VALUE IF NOT EXISTS 'braip'`,
    );
    expect(provider).not.toMatch(/INSERT INTO|UPDATE\s+"/iu);
  });

  it("seeds the automation-v1 release CERTIFIED, idempotent, never reviving a retired one", () => {
    expect(release).toContain("'inbound_parser_braip_automation_v1'");
    expect(release).toMatch(/'braip',\s*'automation-v1',\s*'certified'/u);
    expect(release).toContain('ON CONFLICT ("provider", "version") DO UPDATE');
    expect(release).toContain(
      `WHERE "InboundWebhookParserRelease"."status" = 'observation_only'`,
    );
    // Cites the SaaS validation it relies on.
    expect(release).toContain("#168");
    // Nothing else is created or activated by the migration.
    expect(release).not.toMatch(/"InboundWebhookConnection"|"ProviderConversionRuleConfig"|"ConversionRule"/u);
  });

  it("only adds: no DROP, no ALTER COLUMN, no DELETE", () => {
    for (const sql of [provider, release]) {
      expect(sql).not.toMatch(/\bDROP\b|\bALTER\s+COLUMN\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/iu);
    }
  });
});

describe("Braip is born in production (no release step for the student)", () => {
  const certified = {
    provider: "braip",
    version: "automation-v1",
    status: "certified",
  };

  it("treats the certified Braip release as production eligible", () => {
    expect(inboundParserProductionEligible(certified)).toBe(true);
    expect(effectiveInboundParserStatus(certified)).toBe("certified");
    expect(productionDirectEligible(certified)).toBe(true);
    expect(bornConnectionStatus(certified)).toBe("production");
    expect(
      bornChannelState({ status: "production" }, certified, new Date(0)),
    ).toEqual({ status: "active", productionActivatedAt: new Date(0) });
  });

  it("never sends with a release that is not certified (fail-closed)", () => {
    for (const status of ["observation_only", "retired"]) {
      expect(
        inboundParserProductionEligible({ ...certified, status }),
      ).toBe(false);
    }
  });

  it("names Braip a sales platform of automation-v1", () => {
    expect(isSalesPlatformProvider("braip")).toBe(true);
    expect(salesPlatformOf({ provider: "braip", version: "automation-v1" })).toBe(
      "braip",
    );
    expect(salesPlatformOf({ provider: "braip", version: "v1" })).toBeNull();
  });
});
