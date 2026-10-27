import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { metaLeadFormsVisible } from "../src/app/(app)/integrations/meta-lead-forms-visibility";

describe("Formulários Meta ocultos até a validação (1.3.1)", () => {
  it("fica oculto sem a variável, vazia ou com outro valor", () => {
    expect(metaLeadFormsVisible(undefined)).toBe(false);
    expect(metaLeadFormsVisible("")).toBe(false);
    expect(metaLeadFormsVisible("false")).toBe(false);
    expect(metaLeadFormsVisible("0")).toBe(false);
  });

  it("aparece só com true/1/on/yes", () => {
    for (const value of ["true", "1", "on", "yes", " TRUE "]) {
      expect(metaLeadFormsVisible(value)).toBe(true);
    }
  });

  it("a página só monta o painel e só lê as conexões com a flag", () => {
    const page = readFileSync(
      resolve(__dirname, "../src/app/(app)/integrations/page.tsx"),
      "utf8",
    );
    expect(page).toMatch(/if \(!metaLeadFormsVisible\(\)\) return \{ data: \[\], state: "empty" \}/u);
    expect(page).toMatch(/\{metaLeadFormsVisible\(\) \? \(\s*<MetaLeadFormsPanel/u);
  });
});
