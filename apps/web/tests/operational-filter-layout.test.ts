import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("operational filter layout", () => {
  it("keeps purchase review controls dark and responsive to the content width", () => {
    const page = readSource(
      "../src/app/(app)/events/purchase-reviews/page.tsx",
    );
    const css = readSource("../src/styles/globals.css");

    expect(page.match(/className="input-field"/g)).toHaveLength(2);
    expect(page.match(/className="filter-control"/g)).toHaveLength(3);
    expect(css).toContain("container-name: purchase-review-command;");
    expect(css).toContain(
      "@container purchase-review-command (max-width: 1080px)",
    );
    expect(css).toContain(
      "grid-template-columns: minmax(165px, 0.8fr) repeat(3, minmax(0, 1fr));",
    );
    expect(css).toContain(
      "@container purchase-review-command (max-width: 480px)",
    );
  });

  it("keeps the inbound backoffice page on the design system without the private delivery filters", () => {
    const page = readSource(
      "../src/app/(backoffice)/backoffice/inbound-webhooks/page.tsx",
    );
    const css = readSource("../src/styles/globals.css");

    expect(page).toContain("standalone-page inbound-deliveries-page");
    // The delivery search/replay console needs `backoffice/inbound-webhooks`
    // API controllers that this template does not ship, so the student
    // edition renders no filter form at all instead of inert controls.
    expect(page.match(/className="filter-control"/g)?.length ?? 0).toBe(0);
    expect(page.match(/className="input-field"/g)?.length ?? 0).toBe(0);
    expect(css).toContain(".filter-control option {");
    expect(css).toContain(".inbound-deliveries-page .filter-control,");
    expect(css).toContain("background-color: var(--graphite-950);");
  });
});
