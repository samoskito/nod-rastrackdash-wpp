import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { wahaGowsFixtureFiles, wahaGowsFixturesDir } from "./helpers/fixtures";

// Guarda permanente: as fixtures WAHA GoWS são sintéticas. Qualquer número,
// URL, nome ou texto fora dos padrões sintéticos abaixo falha o teste, para
// que nenhum dado real entre por engano numa atualização das fixtures.
const SYNTHETIC_NUMBER_PREFIXES = [
  "5500", // telefones com DDD 00 (inexistente no Brasil)
  "1000000000", // LIDs sintéticos
  "1202000000", // IDs de anúncio sintéticos
  "1203000000", // grupo sintético
  "1792000", // timestamps (epoch) sintéticos
];
const ALLOWED_URL_PREFIXES = [
  "https://fb.me/0Synth",
  "https://wa.me/wamo/0Synth",
  "https://cdn.example.invalid/",
  "https://waha.example.invalid/",
  "https://mmg.example.invalid/",
];

function readAll(): Array<{ file: string; text: string; json: unknown }> {
  return wahaGowsFixtureFiles().map((file) => {
    const text = readFileSync(resolve(wahaGowsFixturesDir, file), "utf8");
    return { file, text, json: JSON.parse(text) };
  });
}

// [leaf key, value, ancestor keys] of every string in the fixture.
function strings(
  value: unknown,
  out: Array<[string, string, string[]]> = [],
  key = "",
  ancestors: string[] = [],
): Array<[string, string, string[]]> {
  if (typeof value === "string") out.push([key, value, ancestors]);
  else if (Array.isArray(value))
    value.forEach((item) => strings(item, out, key, ancestors));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) strings(v, out, k, [...ancestors, k]);
  return out;
}

// Display names a contact or business can set in WhatsApp.
const NAME_KEYS = ["PushName", "pushName", "notifyName", "VerifiedName"];

describe("WAHA GoWS fixtures stay synthetic", () => {
  it("has one file per documented case and a README", () => {
    expect(wahaGowsFixtureFiles()).toHaveLength(17);
    expect(
      readFileSync(resolve(wahaGowsFixturesDir, "README.md"), "utf8"),
    ).toContain("sintétic");
  });

  it("only contains synthetic numbers (phones, LIDs, ad ids)", () => {
    for (const { file, text } of readAll()) {
      for (const match of text.matchAll(/\d{10,}/gu)) {
        const value = match[0];
        expect(
          SYNTHETIC_NUMBER_PREFIXES.some((prefix) => value.startsWith(prefix)) ||
            // zeros of the synthetic message ids (3EB0…01) and event ids (evt_01k8…01)
            /^8?0+\d{1,4}$/u.test(value),
          `${file}: ${value}`,
        ).toBe(true);
      }
    }
  });

  it("only contains synthetic URLs", () => {
    for (const { file, text } of readAll()) {
      for (const match of text.matchAll(/https?:\/\/[^\s"]+/gu)) {
        expect(
          ALLOWED_URL_PREFIXES.some((prefix) => match[0].startsWith(prefix)),
          `${file}: ${match[0]}`,
        ).toBe(true);
      }
    }
  });

  it("covers notifyName and VerifiedName in at least one fixture", () => {
    const keys = readAll().flatMap(({ json }) =>
      strings(json).flatMap(([, , ancestors]) => ancestors),
    );
    expect(keys).toContain("notifyName");
    expect(keys).toContain("VerifiedName");
  });

  it("only contains synthetic names, texts and the synthetic session", () => {
    for (const { file, json } of readAll()) {
      for (const [key, value, ancestors] of strings(json)) {
        // Also the business name inside VerifiedName.Details.verifiedName.
        const isName =
          NAME_KEYS.includes(key) ||
          (key === "verifiedName" && ancestors.includes("VerifiedName"));
        if (value && isName) {
          expect(value, `${file}:${ancestors.join(".")}`).toMatch(/Sintétic/u);
        }
        if (["body", "text", "caption", "conversation", "title"].includes(key) && value) {
          expect(value, `${file}:${key}`).toMatch(/sintétic/iu);
        }
        if (key === "session") expect(value, file).toBe("aluno-sessao-teste");
        if (key === "ctwaClid") expect(value, file).toMatch(/^AfSint3tico/u);
      }
    }
  });
});
