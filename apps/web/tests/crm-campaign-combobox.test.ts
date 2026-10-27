// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Fase 6.3b: o filtro de campanha do CRM (6.2b) passa a usar a mesma caixa
// pesquisável da Visão Geral (FilterCombobox), como no SaaS.

const push = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: () => undefined }),
}));

import { CrmFilters } from "../src/app/(app)/crm/crm-filters";

afterEach(() => {
  cleanup();
  push.mockReset();
});

const filters = {
  since: "2026-10-01",
  until: "2026-10-24",
  whatsappInstanceId: "",
  campaignId: "",
};

describe("CRM campaign filter (6.3b)", () => {
  it("searches the campaigns and applies the chosen one", () => {
    const { container } = render(
      createElement(CrmFilters, {
        filters,
        whatsappInstances: [],
        campaignOptions: [
          { id: "cmp_bf", name: "Black Friday" },
          { id: "cmp_rmk", name: "Remarketing" },
        ],
      }),
    );

    expect(container.querySelector('select[name="campaignId"]')).toBeNull();
    fireEvent.click(container.querySelector(".filter-combobox-trigger")!);
    fireEvent.change(container.querySelector(".filter-combobox-search")!, {
      target: { value: "black" },
    });
    const options = Array.from(
      container.querySelectorAll<HTMLElement>('[role="option"]'),
    );
    const blackFriday = options.find(
      (option) => option.querySelector("strong")?.textContent === "Black Friday",
    );

    expect(blackFriday).toBeTruthy();
    expect(
      options.some(
        (option) => option.querySelector("strong")?.textContent === "Remarketing",
      ),
    ).toBe(false);
    fireEvent.click(blackFriday!);

    expect(push).toHaveBeenCalledWith(
      expect.stringContaining("campaignId=cmp_bf"),
      expect.anything(),
    );
  });

  it("disables the field when the campaigns could not be read", () => {
    const { container } = render(
      createElement(CrmFilters, {
        filters,
        whatsappInstances: [],
        campaignOptions: null,
      }),
    );

    const trigger = container.querySelector<HTMLButtonElement>(
      ".filter-combobox-trigger",
    )!;
    expect(trigger.disabled).toBe(true);
    expect(trigger.textContent).toBe("Campanhas indisponíveis");
  });
});
