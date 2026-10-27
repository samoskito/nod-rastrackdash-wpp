// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, createRef, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FilterCombobox,
  filterComboboxOptions,
  sectionComboboxOptions,
  type FilterComboboxCopy,
  type FilterComboboxHandle,
  type FilterComboboxOption,
} from "../src/components/filter-combobox";

const copy: FilterComboboxCopy = {
  all: "Todas as campanhas",
  searchPlaceholder: "Buscar campanha",
  searchLabel: "Buscar campanha por nome ou ID",
  count: (matches, total) => `${matches} de ${total} campanhas`,
  found: (matches) => `${matches} campanhas encontradas`,
  noResults: (query) => `Nenhuma campanha com "${query}"`,
  clearSearch: "Limpar busca",
};

const groups = [
  { key: "with_leads", label: "Com conversas neste numero" },
  { key: "others", label: "Outras campanhas" },
];

const options: FilterComboboxOption[] = [
  {
    value: "120210000000001",
    label: "Promocao Setembro",
    description: "12 conversas neste numero",
    group: "with_leads",
  },
  { value: "120210000000002", label: "Remarketing 30d", group: "others" },
  { value: "120210000000003", label: "Promo Dia dos Pais", group: "others" },
];

type Props = ComponentProps<typeof FilterCombobox>;

function renderCombobox(overrides: Partial<Props> = {}) {
  const onCommit = vi.fn();
  const view = render(
    createElement(FilterCombobox, {
      name: "campaignId",
      label: "Campanha",
      value: [],
      options,
      groups,
      copy,
      onCommit,
      ...overrides,
    }),
  );
  const { container } = view;

  return {
    ...view,
    onCommit,
    trigger: () =>
      container.querySelector<HTMLButtonElement>(".filter-combobox-trigger")!,
    search: () =>
      container.querySelector<HTMLInputElement>(".filter-combobox-search"),
    listbox: () => container.querySelector('[role="listbox"]'),
    labels: () =>
      Array.from(
        container.querySelectorAll('[role="option"] strong'),
        (node) => node.textContent,
      ),
    activeLabel: () => {
      const id = container
        .querySelector(".filter-combobox-search")
        ?.getAttribute("aria-activedescendant");
      return id
        ? document.getElementById(id)?.querySelector("strong")?.textContent
        : undefined;
    },
  };
}

afterEach(() => {
  cleanup();
});

describe("filter combobox helpers", () => {
  it("matches accent-insensitively over label, meta and id", () => {
    expect(filterComboboxOptions(options, "promoção")).toEqual([options[0]]);
    expect(filterComboboxOptions(options, "PROMO")).toEqual([
      options[0],
      options[2],
    ]);
    expect(filterComboboxOptions(options, "120210000000002")).toEqual([
      options[1],
    ]);
    expect(filterComboboxOptions(options, "conversas")).toEqual([options[0]]);
    expect(filterComboboxOptions(options, "  ")).toBe(options);
  });

  it("puts ungrouped options first and hides empty groups", () => {
    const synthetic = { value: "old", label: "Antiga (sem dados no periodo)" };
    const sections = sectionComboboxOptions([synthetic, options[1]!], groups);

    expect(sections).toEqual([
      { key: "", options: [synthetic] },
      { key: "others", label: "Outras campanhas", options: [options[1]] },
    ]);
  });
});

describe("filter combobox", () => {
  it("renders a closed trigger with the hidden form value", () => {
    const html = renderToStaticMarkup(
      createElement(FilterCombobox, {
        name: "campaignId",
        label: "Campanha",
        value: ["120210000000002"],
        options,
        groups,
        copy,
        onCommit: () => undefined,
      }),
    );

    expect(html).toContain(
      '<input type="hidden" name="campaignId" value="120210000000002"/>',
    );
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Remarketing 30d");
    expect(html).not.toContain("Promocao Setembro");
    expect(html).not.toContain('role="listbox"');
  });

  it("shows the all label when nothing is selected", () => {
    const { trigger } = renderCombobox();

    expect(trigger().textContent).toBe("Todas as campanhas");
  });

  it("opens on click with focus in the search and groups in order", () => {
    const view = renderCombobox();

    fireEvent.click(view.trigger());

    expect(view.trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(view.search());
    expect(view.search()!.getAttribute("role")).toBe("combobox");
    expect(view.labels()).toEqual([
      "Todas as campanhas",
      "Promocao Setembro",
      "Remarketing 30d",
      "Promo Dia dos Pais",
    ]);
    expect(
      Array.from(
        view.container.querySelectorAll('[role="listbox"] [role="group"]'),
        (group) =>
          document.getElementById(group.getAttribute("aria-labelledby")!)
            ?.textContent,
      ),
    ).toEqual(["Com conversas neste numero", "Outras campanhas"]);
  });

  it("filters while typing, hides the all row and announces the count", () => {
    const view = renderCombobox();

    fireEvent.click(view.trigger());
    fireEvent.change(view.search()!, { target: { value: "promo" } });

    expect(view.labels()).toEqual(["Promocao Setembro", "Promo Dia dos Pais"]);
    expect(
      view.container.querySelector(".filter-combobox-count")?.textContent,
    ).toBe("2 de 3 campanhas");
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(
      "2 campanhas encontradas",
    );
    expect(view.onCommit).not.toHaveBeenCalled();
  });

  it("offers Limpar busca when nothing matches", () => {
    const view = renderCombobox();

    fireEvent.click(view.trigger());
    fireEvent.change(view.search()!, { target: { value: "xyz" } });

    expect(view.labels()).toEqual([]);
    expect(
      view.container.querySelector(".filter-combobox-empty span")?.textContent,
    ).toBe('Nenhuma campanha com "xyz"');

    fireEvent.click(view.container.querySelector(".filter-combobox-clear")!);

    expect(view.search()!.value).toBe("");
    expect(view.labels()).toHaveLength(4);
  });

  it("commits a clicked option and closes", () => {
    const view = renderCombobox();

    fireEvent.click(view.trigger());
    fireEvent.click(
      Array.from(view.container.querySelectorAll('[role="option"]')).find(
        (node) => node.textContent?.startsWith("Remarketing"),
      )!,
    );

    expect(view.onCommit).toHaveBeenCalledWith(["120210000000002"]);
    expect(view.listbox()).toBeNull();
    expect(document.activeElement).toBe(view.trigger());
  });

  it("commits an empty list for the all row", () => {
    const view = renderCombobox({ value: ["120210000000001"] });

    fireEvent.click(view.trigger());
    fireEvent.click(view.container.querySelector('[role="option"]')!);

    expect(view.onCommit).toHaveBeenCalledWith([]);
  });

  it("does not commit when the selected option is picked again", () => {
    const view = renderCombobox({ value: ["120210000000001"] });

    fireEvent.click(view.trigger());
    fireEvent.keyDown(view.search()!, { key: "Enter" });

    expect(view.onCommit).not.toHaveBeenCalled();
    expect(view.listbox()).toBeNull();
  });

  // UX §8 test 3
  it("supports the keyboard: ArrowDown opens, arrows wrap, Enter selects", () => {
    const view = renderCombobox({ value: ["120210000000002"] });

    fireEvent.keyDown(view.trigger(), { key: "ArrowDown" });

    expect(document.activeElement).toBe(view.search());
    // Opens on the current selection.
    expect(view.activeLabel()).toBe("Remarketing 30d");

    fireEvent.keyDown(view.search()!, { key: "ArrowDown" });
    expect(view.activeLabel()).toBe("Promo Dia dos Pais");
    fireEvent.keyDown(view.search()!, { key: "ArrowDown" });
    expect(view.activeLabel()).toBe("Todas as campanhas");
    fireEvent.keyDown(view.search()!, { key: "ArrowUp" });
    expect(view.activeLabel()).toBe("Promo Dia dos Pais");
    fireEvent.keyDown(view.search()!, { key: "Home" });
    expect(view.activeLabel()).toBe("Todas as campanhas");
    fireEvent.keyDown(view.search()!, { key: "End" });
    expect(view.activeLabel()).toBe("Promo Dia dos Pais");

    fireEvent.keyDown(view.search()!, { key: "Enter" });

    expect(view.onCommit).toHaveBeenCalledWith(["120210000000003"]);
    expect(document.activeElement).toBe(view.trigger());
  });

  it("seeds the search with a typed character on the trigger", () => {
    const view = renderCombobox();

    fireEvent.keyDown(view.trigger(), { key: "k" });

    expect(view.search()!.value).toBe("k");
    expect(view.labels()).toEqual(["Remarketing 30d"]);
    expect(view.activeLabel()).toBe("Remarketing 30d");
  });

  it("closes on Escape without committing and returns focus", () => {
    const view = renderCombobox({ value: ["120210000000001"] });

    fireEvent.click(view.trigger());
    fireEvent.keyDown(view.search()!, { key: "ArrowDown" });
    fireEvent.keyDown(view.search()!, { key: "Escape" });

    expect(view.onCommit).not.toHaveBeenCalled();
    expect(view.listbox()).toBeNull();
    expect(document.activeElement).toBe(view.trigger());
    expect(view.trigger().textContent).toBe("Promocao Setembro");
  });

  it("closes when focus leaves the control", () => {
    const view = renderCombobox();

    fireEvent.click(view.trigger());
    fireEvent.blur(view.search()!, { relatedTarget: document.body });

    expect(view.listbox()).toBeNull();
    expect(view.onCommit).not.toHaveBeenCalled();
  });

  it("renders a disabled trigger that keeps an applied value", () => {
    const view = renderCombobox({
      value: ["120210000000001"],
      disabledLabel: "Campanhas indisponiveis",
    });

    expect(view.trigger().disabled).toBe(true);
    expect(view.trigger().textContent).toBe("Campanhas indisponiveis");
    expect(
      view.container.querySelector<HTMLInputElement>(
        'input[name="campaignId"]',
      )!.value,
    ).toBe("120210000000001");
  });

  it("renders only a placeholder and the hidden value in presentation mode", () => {
    const view = renderCombobox({
      value: ["120210000000001"],
      presentationPlaceholder: "Campanha oculta",
    });

    expect(view.container.querySelector("button")).toBeNull();
    expect(view.container.textContent).toContain("Campanha oculta");
    expect(view.container.textContent).not.toContain("Promocao");
    expect(
      view.container.querySelector<HTMLInputElement>(
        'input[name="campaignId"]',
      )!.value,
    ).toBe("120210000000001");
  });
});

describe("filter combobox multi mode", () => {
  function renderMulti(overrides: Partial<Props> = {}) {
    const view = renderCombobox({
      mode: "multi",
      name: "campaignIds",
      ...overrides,
    });
    const statusText = () =>
      view.container.querySelector('[role="status"]')?.textContent;

    return { ...view, statusText };
  }

  function option(container: HTMLElement, label: string) {
    return Array.from(
      container.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((node) => node.querySelector("strong")?.textContent === label)!;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("toggles without closing and commits once, 600 ms after the last toggle", () => {
    vi.useFakeTimers();
    const view = renderMulti();

    fireEvent.click(view.trigger());
    expect(view.listbox()?.getAttribute("aria-multiselectable")).toBe("true");
    // No "all" row: an empty selection already means all.
    expect(view.labels()).toEqual([
      "Promocao Setembro",
      "Remarketing 30d",
      "Promo Dia dos Pais",
    ]);

    fireEvent.click(option(view.container, "Remarketing 30d"));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.click(option(view.container, "Promocao Setembro"));

    expect(view.listbox()).not.toBeNull();
    expect(
      option(view.container, "Remarketing 30d").getAttribute("aria-selected"),
    ).toBe("true");
    expect(view.trigger().textContent).toBe("2 selecionados");
    expect(view.onCommit).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(599);
    });
    expect(view.onCommit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });

    // Selection order is kept.
    expect(view.onCommit).toHaveBeenCalledTimes(1);
    expect(view.onCommit).toHaveBeenCalledWith([
      "120210000000002",
      "120210000000001",
    ]);
  });

  it("flushes pending toggles at once when the popover closes", () => {
    vi.useFakeTimers();
    const view = renderMulti();

    fireEvent.click(view.trigger());
    fireEvent.click(option(view.container, "Remarketing 30d"));
    fireEvent.keyDown(view.search()!, { key: "Escape" });

    expect(view.listbox()).toBeNull();
    expect(document.activeElement).toBe(view.trigger());
    expect(view.onCommit).toHaveBeenCalledTimes(1);
    expect(view.onCommit).toHaveBeenCalledWith(["120210000000002"]);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(view.onCommit).toHaveBeenCalledTimes(1);
  });

  it("toggles with Enter and Space from the search and stays open", () => {
    const view = renderMulti();

    fireEvent.click(view.trigger());
    fireEvent.keyDown(view.search()!, { key: "Enter" });
    fireEvent.keyDown(view.search()!, { key: "ArrowDown" });
    fireEvent.keyDown(view.search()!, { key: " " });

    expect(view.listbox()).not.toBeNull();
    expect(
      Array.from(
        view.container.querySelectorAll(
          '[role="option"][aria-selected="true"]',
        ),
        (node) => node.querySelector("strong")?.textContent,
      ),
    ).toEqual(["Promocao Setembro", "Remarketing 30d"]);
    expect(view.statusText()).toBe(
      "Remarketing 30d adicionado. 2 selecionados.",
    );

    fireEvent.click(view.container.querySelector(".filter-combobox-done")!);
    expect(view.onCommit).toHaveBeenCalledWith([
      "120210000000001",
      "120210000000002",
    ]);
  });

  it("keeps search working and a typed space as part of the query", () => {
    const view = renderMulti();

    fireEvent.click(view.trigger());
    fireEvent.change(view.search()!, { target: { value: "promo" } });
    fireEvent.keyDown(view.search()!, { key: " " });

    expect(view.labels()).toEqual(["Promocao Setembro", "Promo Dia dos Pais"]);
    expect(
      view.container.querySelectorAll('[role="option"][aria-selected="true"]'),
    ).toHaveLength(0);
  });

  it("disables unselected options at the limit", () => {
    const view = renderMulti({
      max: 2,
      value: ["120210000000001", "120210000000002"],
    });

    fireEvent.click(view.trigger());

    const blocked = option(view.container, "Promo Dia dos Pais");
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    expect(
      option(view.container, "Remarketing 30d").getAttribute("aria-disabled"),
    ).toBeNull();
    expect(
      view.container.querySelector(".filter-combobox-limit")?.textContent,
    ).toBe("Limite de 2");

    fireEvent.click(blocked);
    fireEvent.click(view.container.querySelector(".filter-combobox-done")!);
    expect(view.onCommit).not.toHaveBeenCalled();
  });

  it("clears the whole selection at once from the footer", () => {
    const view = renderMulti({ value: ["120210000000001", "120210000000003"] });

    fireEvent.click(view.trigger());
    expect(
      view.container.querySelector(".filter-combobox-selected-count")
        ?.textContent,
    ).toBe("2 selecionados");
    fireEvent.click(
      view.container.querySelector(
        ".filter-combobox-footer .filter-combobox-clear",
      )!,
    );

    expect(view.onCommit).toHaveBeenCalledWith([]);
    expect(view.listbox()).not.toBeNull();
  });

  it("writes the list comma-joined into the hidden input and a count on the trigger", () => {
    const view = renderMulti({
      value: ["120210000000003", "120210000000001"],
    });

    expect(
      view.container.querySelector<HTMLInputElement>(
        'input[name="campaignIds"]',
      )!.value,
    ).toBe("120210000000003,120210000000001");
    expect(view.trigger().textContent).toBe("2 selecionados");
  });

  it("shows the option label for a single selection", () => {
    const view = renderMulti({ value: ["120210000000002"] });

    expect(view.trigger().textContent).toBe("Remarketing 30d");
  });

  it("opens through the handle", () => {
    const handle = createRef<FilterComboboxHandle>();
    const view = renderMulti({ handleRef: handle });

    act(() => {
      handle.current!.open();
    });

    expect(view.listbox()).not.toBeNull();
    expect(document.activeElement).toBe(view.search());
  });
});
