import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20261120120000_gohighlevel_parser_certification/migration.sql",
  ),
  "utf8",
);
const sql = migration
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("GoHighLevel certification migration (nod)", () => {
  it("certifies only the two GoHighLevel readers still in observation", () => {
    expect(sql).toContain('UPDATE "InboundWebhookParserRelease"');
    expect(sql).toContain("\"status\" = 'certified'");
    expect(sql).toContain('COALESCE("certifiedAt", CURRENT_TIMESTAMP)');
    expect(sql).toContain("\"provider\" = 'gohighlevel'");
    expect(sql).toContain("\"version\" IN ('v1', 'automation-v1')");
    expect(sql).toContain("\"status\" = 'observation_only'");
  });

  it("changes no customer record and no schema", () => {
    expect(sql.match(/\bUPDATE\b/gi)).toHaveLength(1);
    expect(sql).not.toMatch(/\b(?:INSERT|DELETE|DROP|ALTER|CREATE)\b/i);
    expect(sql).not.toMatch(/InboundWebhookConnection|ConversionRule|AuditLog/);
  });
});
