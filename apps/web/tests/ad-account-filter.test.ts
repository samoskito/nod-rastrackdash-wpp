// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdAccountFilter,
  adAccountFilterOptions,
} from "../src/components/ad-account-filter";
import {
  parseAdAccountIdsParam,
  setAdAccountParams,
} from "../src/lib/ad-account-params";

// Fase 6.3b: o filtro de contas usa a mesma caixa pesquisável (FilterCombobox)
// do SaaS (2f79c3c7, #116/#118). "Pronto" (ou fechar) aplica sozinho, sem
// botão "Aplicar".

afterEach(cleanup);

const accounts = [
  { adAccountId: "act_1", adAccountName: "Conta Real", currency: "BRL" },
  { adAccountId: "act_2", adAccountName: "Conta Dolar", currency: "USD" },
  { adAccountId: "act_3", adAccountName: "Conta Euro", currency: "EUR" },
];

function Harness({
  applied = [] as string[],
  onCommit,
}: {
  applied?: string[];
  onCommit: (next: string[]) => void;
}) {
  const [value, setValue] = useState<string[]>(applied);

  return createElement(AdAccountFilter, {
    accounts,
    value,
    onCommit: (next: string[]) => {
      setValue(next);
      onCommit(next);
    },
  });
}

function hiddenField(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>(
    'input[type="hidden"][name^="adAccountId"]',
  )!;
}

function option(container: HTMLElement, label: string) {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((node) => node.querySelector("strong")?.textContent?.startsWith(label))!;
}

describe("AdAccountFilter", () => {
  it("começa em 'Todas as contas' e mostra a moeda de cada conta", () => {
    const { container } = render(
      createElement(Harness, { onCommit: vi.fn() }),
    );

    expect(container.textContent).toContain("Todas as contas");
    expect(hiddenField(container).name).toBe("adAccountId");
    expect(hiddenField(container).value).toBe("");
    expect(adAccountFilterOptions(accounts).map((item) => item.badge)).toEqual(
      ["USD", "EUR", "BRL"],
    );
  });

  it("uma conta vira adAccountId e duas ou mais viram adAccountIds, ao concluir", () => {
    const onCommit = vi.fn();
    const { container } = render(createElement(Harness, { onCommit }));

    fireEvent.click(container.querySelector(".filter-combobox-trigger")!);
    fireEvent.click(option(container, "Conta Real"));
    fireEvent.click(option(container, "Conta Dolar"));
    fireEvent.click(container.querySelector(".filter-combobox-done")!);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(["act_1", "act_2"]);
    expect(hiddenField(container).name).toBe("adAccountIds");
    expect(hiddenField(container).value).toBe("act_1,act_2");
    expect(container.textContent).toContain("2 contas");
  });

  it("'Pronto' sem mudar a seleção não reaplica", () => {
    const onCommit = vi.fn();
    const { container } = render(
      createElement(Harness, { applied: ["act_1"], onCommit }),
    );

    expect(hiddenField(container).name).toBe("adAccountId");
    expect(hiddenField(container).value).toBe("act_1");
    fireEvent.click(container.querySelector(".filter-combobox-trigger")!);
    fireEvent.click(container.querySelector(".filter-combobox-done")!);

    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("ad-account-params", () => {
  it("lê adAccountId e adAccountIds juntos, sem repetir", () => {
    expect(parseAdAccountIdsParam("act_1", "act_1,act_2")).toEqual([
      "act_1",
      "act_2",
    ]);
    expect(parseAdAccountIdsParam(undefined, undefined)).toEqual([]);
    expect(parseAdAccountIdsParam("act_1,act_2")).toEqual(["act_1", "act_2"]);
  });

  it("escreve na URL no formato canônico", () => {
    expect(setAdAccountParams(new URLSearchParams(), []).toString()).toBe("");
    expect(
      setAdAccountParams(new URLSearchParams(), ["act_1"]).toString(),
    ).toBe("adAccountId=act_1");
    expect(
      setAdAccountParams(new URLSearchParams("adAccountId=x"), [
        "act_1",
        "act_2",
      ]).toString(),
    ).toBe("adAccountIds=act_1%2Cact_2");
  });
});
