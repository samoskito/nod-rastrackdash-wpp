import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Fase 6.9 (PR #91 do nod): the migration renamed from
// 20261017100000_meta_lead_forms. Text only: never executed here (the real
// run is the disposable Postgres of the phase validation).

const migrationsDir = resolve(__dirname, "../../prisma/migrations");
const NAME = "20261027145000_meta_lead_forms";
const sql = readFileSync(resolve(migrationsDir, NAME, "migration.sql"), "utf8").replace(
  /\r\n/g,
  "\n",
);
const statements = sql
  .replace(/--.*$/gm, "")
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

describe("migration 20261027145000_meta_lead_forms", () => {
  it("runs after every migration of the integration and before the reserved Hotmart slot", () => {
    const names = readdirSync(migrationsDir).filter((name) => /^\d{14}_/.test(name));
    const others = names.filter((name) => name !== NAME);
    expect(names).toContain(NAME);
    expect(others.every((name) => name < NAME || name >= "20261027150000")).toBe(true);
    expect(names.some((name) => name.startsWith("20261017100000"))).toBe(false);
    expect(names.some((name) => name.startsWith("20261017090000"))).toBe(false);
  });

  it("is additive: only creates its two tables, their indexes and FKs", () => {
    // Comments stripped; "ON DELETE/UPDATE CASCADE" of the FKs is not a write.
    const code = statements.join(";\n");
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE FROM|INSERT INTO)\b/i);
    expect(statements.some((statement) => /^UPDATE\b/i.test(statement))).toBe(false);
    expect(sql).not.toMatch(/ALTER TABLE "(?!MetaLeadFormConnection"|MetaLeadSubmission")/);
    expect(sql).not.toMatch(/ALTER TYPE/i);
    expect(sql).not.toMatch(/"Lead" ADD|statusChanged/);
  });

  it("is idempotent: IF NOT EXISTS everywhere, FKs guarded by pg_constraint", () => {
    for (const statement of statements) {
      if (/^CREATE (UNIQUE )?(TABLE|INDEX)/.test(statement))
        expect(statement).toMatch(/IF NOT EXISTS/);
    }
    const constraints = [...sql.matchAll(/ADD CONSTRAINT "([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(constraints).toHaveLength(4);
    for (const name of constraints)
      expect(sql).toContain(`SELECT 1 FROM pg_constraint WHERE conname = '${name}'`);
  });
});
