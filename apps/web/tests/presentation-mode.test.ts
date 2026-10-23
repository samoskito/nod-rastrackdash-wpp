import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PresentationMask } from "../src/components/presentation-mask";

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("presentation mode", () => {
  it("keeps the real value and its neutral replacement in a stable wrapper", () => {
    const html = renderToStaticMarkup(
      createElement(
        PresentationMask,
        { placeholder: "Lead oculto" },
        "Maria 11999999999",
      ),
    );

    expect(html).toContain('data-presentation-sensitive="true"');
    expect(html).toContain('class="presentation-mask-value"');
    expect(html).toContain("Maria 11999999999");
    expect(html).toContain("Lead oculto");
  });

  it("restores the saved mode before the application paints", () => {
    const layout = source("../src/app/layout.tsx");
    const css = source("../src/styles/globals.css");

    expect(layout).toContain("wpptrack-presentation-mode");
    expect(layout).toContain("dataset.presentationMode");
    expect(css).toContain('html[data-presentation-mode="active"]');
    expect(css).toContain(".presentation-mask-value");
    expect(css).toContain(".presentation-mask-placeholder");
  });

  it("covers every client-facing sensitive surface", () => {
    const surfaces = [
      ["../src/components/app-shell.tsx", "Workspace demonstrativo"],
      ["../src/app/(app)/leads/page.tsx", "Lead oculto"],
      ["../src/app/(app)/leads/[leadId]/page.tsx", "(00) 00000-0000"],
      ["../src/app/(app)/reports/page.tsx", "Campanha oculta"],
      ["../src/app/(app)/events/page.tsx", "Lead oculto"],
      ["../src/app/(app)/events/event-audit-details.tsx", "Payload oculto"],
      ["../src/app/(app)/integrations/page.tsx", "Pixel oculto"],
      [
        "../src/app/(app)/integrations/inbound-webhook-panel.tsx",
        "Conexão WhatsApp",
      ],
      [
        "../src/app/(app)/integrations/inbound-webhook-panel.tsx",
        "Número oculto",
      ],
      [
        "../src/app/(app)/integrations/inbound-webhook-route-editor.tsx",
        "BM oculta",
      ],
      [
        "../src/app/(app)/integrations/inbound-webhook-route-editor.tsx",
        "Conta oculta",
      ],
      [
        "../src/app/(app)/integrations/inbound-webhook-route-editor.tsx",
        "Pixel e Página ocultos",
      ],
      ["../src/app/(app)/settings/page.tsx", "Usuário oculto"],
    ] as const;

    for (const [path, placeholder] of surfaces) {
      expect(source(path), path).toContain(placeholder);
    }
  });
});
