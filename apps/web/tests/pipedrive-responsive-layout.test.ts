import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../src/styles/globals.css"), "utf8");

function block(selector: string): string {
  const index = css.indexOf(`${selector} {`);
  if (index < 0) throw new Error(`CSS block not found: ${selector}`);
  const open = css.indexOf("{", index);
  return css.slice(open + 1, css.indexOf("}", open));
}

describe("Pipedrive panel layout", () => {
  it("lets the rule list span the full connection card width", () => {
    const body = block(
      ".pipedrive-conversion-panel .pipedrive-connection-card > .provider-conversion-rule-list",
    );
    expect(body).toMatch(/grid-column:\s*1\s*\/\s*-1/);
  });

  it("gives the stage select a wider column on desktop", () => {
    expect(css).toMatch(
      /@media \(min-width: 981px\) \{\s*\.pipedrive-conversion-panel \.pipedrive-rule-fields \{\s*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1\.7fr\) minmax\(0, 1fr\);/,
    );
  });

  it("aligns readiness badges in a fixed column with shrinkable text", () => {
    expect(block(".pipedrive-readiness li")).toMatch(/display:\s*grid/);
    expect(block(".pipedrive-readiness li")).toMatch(/grid-template-columns:\s*[\d.]+rem minmax\(0, 1fr\)/);
    expect(block(".pipedrive-readiness-label")).toMatch(/min-width:\s*0/);
  });
});
