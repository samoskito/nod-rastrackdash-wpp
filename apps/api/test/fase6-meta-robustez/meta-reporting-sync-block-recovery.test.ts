import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Revisão do #121 (BAIXA): o disjuntor dos relatórios (reportingSyncBlockedAt)
 * sai sozinho quando o aluno reconecta a Meta, sem passo manual. Cada fluxo
 * de reconexão chama clearMetaReportingSyncBlocks; a função em si é coberta em
 * meta-reporting-sync-block.test.ts.
 */
const read = (path: string) =>
  readFileSync(resolve(__dirname, "../../src/integrations/meta", path), "utf8");

function methodBody(source: string, name: string): string {
  const start = source.search(new RegExp(`\\n  async ${name}\\(`, "u"));
  expect(start, name).toBeGreaterThan(0);
  const next = source.slice(start + 1).search(/\n  (?:async |private |public |get )/u);
  return source.slice(start, next === -1 ? undefined : start + 1 + next);
}

describe("o bloqueio dos relatórios é limpo pela reconexão", () => {
  it.each([
    ["meta-connections.service.ts", "saveOAuthConnection"],
    ["meta-manual-connections.service.ts", "prepareOAuthCredential"],
    ["meta-manual-connections.service.ts", "rotateCredential"],
    ["meta-manual-connections.service.ts", "testBusinessConnection"],
  ])("%s %s limpa o bloqueio", (file, method) => {
    expect(methodBody(read(file), method)).toContain(
      "clearMetaReportingSyncBlocks(",
    );
  });

  it("criar a conexão de negócio de novo também limpa", () => {
    const source = read("meta-manual-connections.service.ts");
    const bodies = source
      .split(/\n  async createBusinessConnection\(/u)
      .slice(1);
    expect(bodies.length).toBeGreaterThan(0);
    expect(
      bodies.some((body) =>
        body.split(/\n  (?:async |private )/u)[0]!.includes(
          "clearMetaReportingSyncBlocks(",
        ),
      ),
    ).toBe(true);
  });
});
