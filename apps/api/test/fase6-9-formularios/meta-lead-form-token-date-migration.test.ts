import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 1.3.1: data do token Graph salvo. Só texto aqui; a execução real é no
// PostgreSQL descartável da validação.
const sql = readFileSync(
  resolve(
    __dirname,
    "../../prisma/migrations/20261028100000_meta_lead_form_token_updated_at/migration.sql",
  ),
  "utf8",
).replace(/\r\n/g, "\n");
const code = sql.replace(/--.*$/gm, "");

describe("migration 20261028100000_meta_lead_form_token_updated_at", () => {
  it("é aditiva: só acrescenta a coluna opcional e preenche quem está sem valor", () => {
    expect(code).toMatch(
      /ALTER TABLE "MetaLeadFormConnection" ADD COLUMN IF NOT EXISTS "graphTokenUpdatedAt" TIMESTAMP\(3\);/,
    );
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|INSERT|ALTER TYPE|NOT NULL)\b/i);
    expect(code).toMatch(/WHERE "graphTokenUpdatedAt" IS NULL/);
    expect(code.match(/ALTER TABLE "(\w+)"/g)).toEqual([
      'ALTER TABLE "MetaLeadFormConnection"',
    ]);
  });
});
