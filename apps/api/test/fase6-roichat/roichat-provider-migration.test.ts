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
import { salesPlatformOf } from "../../src/inbound-webhooks/providers/sales-platform-sale";

/**
 * Fase 6.8 (nod): ROI Chat, production direct (decisão do Samuel de
 * 27/10/2026). The readers were validated with real payloads received in the
 * SaaS (#183; #185 fixed the reader from the real format), so both releases
 * enter CERTIFIED by migration and the student never releases or certifies
 * anything. Porte do SaaS 20261025150000/150100 WITHOUT the
 * `ALTER TYPE "WhatsappSeatProvider"` (paid seats do not exist in the nod).
 * Text checks only: never PostgreSQL here (the chain runs on a throwaway
 * Postgres in the release check).
 */

const migrationsDir = resolve(__dirname, "../../prisma/migrations");
const read = (name: string) =>
  readFileSync(resolve(migrationsDir, name, "migration.sql"), "utf8");
const providerName = "20261027170000_roichat_provider";
const releaseName = "20261027170100_roichat_parser_releases";

describe("ROI Chat migrations", () => {
  const provider = read(providerName);
  const release = read(releaseName);

  it("uses the reserved timestamps, after the Braip migrations (6.5)", () => {
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

  it("adds the enum values alone (no row using 'roichat' in the same file: P3009)", () => {
    for (const enumName of ["InboundWebhookProvider", "DiagnosticSource"]) {
      expect(provider).toContain(
        `ALTER TYPE "${enumName}" ADD VALUE IF NOT EXISTS 'roichat'`,
      );
    }
    expect(provider).not.toMatch(/INSERT INTO|UPDATE\s+"/iu);
  });

  it("never touches WhatsappSeatProvider (no paid seats in the nod)", () => {
    for (const sql of [provider, release]) {
      expect(sql).not.toMatch(/ALTER TYPE "WhatsappSeatProvider"/u);
    }
  });

  it("seeds both releases CERTIFIED, idempotent, never reviving a retired one", () => {
    expect(release).toContain("'inbound_parser_roichat_v1'");
    expect(release).toContain("'inbound_parser_roichat_automation_v1'");
    expect(release).toMatch(/'roichat',\s*'v1',\s*'certified'/u);
    expect(release).toMatch(/'roichat',\s*'automation-v1',\s*'certified'/u);
    expect(release).not.toContain("'observation_only',");
    expect(release).toContain('ON CONFLICT ("provider", "version") DO UPDATE');
    expect(release).toContain(
      `WHERE "InboundWebhookParserRelease"."status" = 'observation_only'`,
    );
    // Cites the SaaS validation it relies on (real payloads).
    expect(release).toContain("#183");
    expect(release).toContain("#185");
    // Nothing else is created or activated by the migration.
    expect(release).not.toMatch(
      /"InboundWebhookConnection"|"ProviderConversionRuleConfig"|"ConversionRule"/u,
    );
  });

  it("only adds: no DROP, no ALTER COLUMN, no DELETE", () => {
    for (const sql of [provider, release]) {
      expect(sql).not.toMatch(
        /\bDROP\b|\bALTER\s+COLUMN\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/iu,
      );
    }
  });
});

describe("ROI Chat is born in production (no release step for the student)", () => {
  for (const version of ["v1", "automation-v1"]) {
    const certified = { provider: "roichat", version, status: "certified" };

    it(`treats the certified ROI Chat ${version} release as production eligible`, () => {
      expect(inboundParserProductionEligible(certified)).toBe(true);
      expect(effectiveInboundParserStatus(certified)).toBe("certified");
      expect(productionDirectEligible(certified)).toBe(true);
      expect(bornConnectionStatus(certified)).toBe("production");
      expect(
        bornChannelState({ status: "production" }, certified, new Date(0)),
      ).toEqual({ status: "active", productionActivatedAt: new Date(0) });
    });

    it(`never sends with a ${version} release that is not certified (fail-closed)`, () => {
      for (const status of ["observation_only", "retired"]) {
        expect(
          inboundParserProductionEligible({ ...certified, status }),
        ).toBe(false);
      }
    });
  }

  it("is not a sales platform (it is a WhatsApp number with its own URL)", () => {
    expect(
      salesPlatformOf({ provider: "roichat", version: "automation-v1" }),
    ).toBeNull();
  });
});
