import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appDir = resolve(__dirname, "../src/app/(app)");

function isClientModule(source: string) {
  return /^\s*(?:\/\/[^\n]*\n\s*)*["']use client["']/.test(source);
}

function resolveModule(fromFile: string, specifier: string) {
  const base = resolve(dirname(fromFile), specifier);

  return [".ts", ".tsx", "/index.ts", "/index.tsx"]
    .map((extension) => `${base}${extension}`)
    .find((candidate) => existsSync(candidate));
}

/**
 * Value imports a server module takes from relative "use client" modules. In
 * the RSC build those exports are client references: components render, but
 * calling a function or reading a constant on the server fails.
 */
function clientValueImports(file: string) {
  const source = readFileSync(file, "utf8");
  const imports = source.matchAll(
    /^import\s+(?!type\s)([^;]*?)\s+from\s+["'](\.[^"']+)["'];/gms,
  );
  const found: { module: string; name: string }[] = [];

  for (const [, clause, specifier] of imports) {
    const target = resolveModule(file, specifier);

    if (!target || !isClientModule(readFileSync(target, "utf8"))) {
      continue;
    }

    const named = clause.match(/\{([^}]*)\}/)?.[1] ?? "";
    const names = named
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part && !part.startsWith("type "))
      .map((part) => part.split(/\s+as\s+/)[0]);
    const defaultName = clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();

    for (const name of defaultName ? [defaultName, ...names] : names) {
      found.push({ module: specifier, name });
    }
  }

  return found;
}

describe("server/client boundary", () => {
  it("keeps the shared lead href helpers out of the client module", () => {
    const params = resolve(appDir, "leads/lead-filter-params.ts");
    const source = readFileSync(params, "utf8");

    expect(isClientModule(source)).toBe(false);
    expect(source).not.toMatch(/^import\s/m);
    expect(
      isClientModule(readFileSync(resolve(appDir, "leads/lead-filters.tsx"), "utf8")),
    ).toBe(true);
  });

  it.each(["leads/page.tsx", "integrations/page.tsx"])(
    "%s only takes components from client modules",
    (page) => {
      const file = resolve(appDir, page);

      expect(isClientModule(readFileSync(file, "utf8"))).toBe(false);

      for (const { module, name } of clientValueImports(file)) {
        expect({ module, name, component: /^[A-Z]/.test(name) }).toEqual({
          module,
          name,
          component: true,
        });
      }
    },
  );

  it("resolves the Leads client import, so the guard is not vacuous", () => {
    const file = resolve(appDir, "leads/page.tsx");
    const imports = clientValueImports(file);

    expect(imports).toContainEqual({
      module: "./lead-filters",
      name: "LeadFilters",
    });
    expect(imports.map(({ name }) => name)).not.toContain("leadFiltersHref");
  });
});
