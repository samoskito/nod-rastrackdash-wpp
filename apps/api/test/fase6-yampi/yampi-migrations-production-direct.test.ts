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
 * Fase 6.7 (nod): Yampi on the single-URL base, production direct. The
 * reader was validated in the SaaS with REAL Yampi payloads received and read
 * correctly (#187/#188 built on them), so its release enters CERTIFIED by
 * migration and the student never releases or certifies anything (decisão do
 * Samuel, 27/10/2026). Text checks only: never PostgreSQL here
 * (the full chain runs on a throwaway Postgres in the release check).
 */

const migrationsDir = resolve(__dirname, "../../prisma/migrations");
const read = (name: string) =>
  readFileSync(resolve(migrationsDir, name, "migration.sql"), "utf8");
const providerName = "20261027160000_yampi_provider";
const releaseName = "20261027160100_yampi_parser_release";

describe("Yampi migrations", () => {
  const provider = read(providerName);
  const release = read(releaseName);

  it("uses the reserved timestamps, after every migration of fase 6.5 (Braip)", () => {
    const names = readdirSync(migrationsDir)
      .filter((entry) => /^\d{14}_/u.test(entry))
      .sort();
    expect(names).toContain(providerName);
    expect(names).toContain(releaseName);
    expect(names.indexOf(providerName)).toBeGreaterThan(
      names.indexOf("20261027140100_braip_parser_release"),
    );
    expect(names.indexOf(releaseName)).toBe(names.indexOf(providerName) + 1);
  });

  it("adds the enum values alone (no row using 'yampi' in the same file: P3009)", () => {
    expect(provider).toContain(
      `ALTER TYPE "InboundWebhookProvider" ADD VALUE IF NOT EXISTS 'yampi'`,
    );
    expect(provider).toContain(
      `ALTER TYPE "DiagnosticSource" ADD VALUE IF NOT EXISTS 'yampi'`,
    );
    expect(provider).not.toMatch(/INSERT INTO|UPDATE\s+"/iu);
  });

  it("seeds the automation-v1 release CERTIFIED, idempotent, never reviving a retired one", () => {
    expect(release).toContain("'inbound_parser_yampi_automation_v1'");
    expect(release).toMatch(/'yampi',\s*'automation-v1',\s*'certified'/u);
    expect(release).toContain('ON CONFLICT ("provider", "version") DO UPDATE');
    expect(release).toContain(
      `WHERE "InboundWebhookParserRelease"."status" = 'observation_only'`,
    );
    // Cites the SaaS validation it relies on.
    expect(release).toMatch(/payloads REAIS/u);
    expect(release).toContain("#187");
    expect(release).toContain("#188");
    // Nothing else is created or activated by the migration.
    expect(release).not.toMatch(/"InboundWebhookConnection"|"ProviderConversionRuleConfig"|"ConversionRule"/u);
  });

  it("only adds: no DROP, no ALTER COLUMN, no DELETE", () => {
    for (const sql of [provider, release]) {
      expect(sql).not.toMatch(/\bDROP\b|\bALTER\s+COLUMN\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/iu);
    }
  });
});

describe("Yampi is born in production (no release step for the student)", () => {
  const certified = {
    provider: "yampi",
    version: "automation-v1",
    status: "certified",
  };

  it("treats the certified Yampi release as production eligible", () => {
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

  it("names Yampi a sales platform of automation-v1", () => {
    expect(isSalesPlatformProvider("yampi")).toBe(true);
    expect(salesPlatformOf({ provider: "yampi", version: "automation-v1" })).toBe(
      "yampi",
    );
    expect(salesPlatformOf({ provider: "yampi", version: "v1" })).toBeNull();
  });
});
