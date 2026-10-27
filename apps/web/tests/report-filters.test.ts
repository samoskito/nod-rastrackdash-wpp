// Fase 6.3b: ported from the SaaS report-filters suite (#119, #121); numbers
// are the nod WhatsApp connections.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const presentation = vi.hoisted(() => ({ enabled: false }));
const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

vi.mock("../src/components/presentation-mode-toggle", () => ({
  usePresentationMode: () => presentation.enabled,
}));

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type {
  MetaAssetsDto,
} from "@wpptrack/shared";
import type { WhatsappNumberOption } from "../src/lib/whatsapp-number-options";
import { createElement, Fragment } from "react";
import { MetaReportFilters } from "../src/app/(app)/reports/meta-report-filters";
import {
  ReportFiltersProvider,
  committableReportFilters,
  reportFiltersHref,
  type ReportFilterValues,
} from "../src/app/(app)/reports/report-filter-state";
import { ReportPeriodFilter } from "../src/app/(app)/reports/report-period-filter";

const applied: ReportFilterValues = {
  since: "2026-09-01",
  until: "2026-09-24",
  compareSince: "",
  compareUntil: "",
  businessId: "",
  adAccountId: "",
  whatsappInstanceId: "instance_a",
  campaignId: "",
  adSetId: "",
  adId: "",
  nameContains: "",
  nameScope: "",
  status: "",
  delivery: "all",
  selectedIds: "",
  whatsappClassification: "",
  pageSize: "10",
  metrics: "overview",
  view: "campaigns",
  mode: "",
  objective: "",
  sort: "",
  dir: "",
};

const assets = {
  reportingAccounts: [
    {
      id: "reporting_1",
      businessId: "business_1",
      businessName: "BM Principal",
      adAccountId: "act_1",
      adAccountName: "Conta Principal",
      active: true,
    },
    {
      id: "reporting_2",
      businessId: "business_2",
      businessName: "BM Secundario",
      adAccountId: "act_2",
      adAccountName: "Conta Secundaria",
      active: true,
    },
  ],
} as unknown as MetaAssetsDto;

const instances = [
  { id: "instance_a", name: "Loja Centro", phone: "5511999991234", active: true },
  { id: "instance_b", name: "Loja Norte", phone: "5511999995678", active: true },
] as WhatsappNumberOption[];

function renderReportFilters(overrides: Partial<ReportFilterValues> = {}) {
  const view = render(
    createElement(ReportFiltersProvider, {
      applied: { ...applied, ...overrides },
      children: createElement(
        Fragment,
        null,
        createElement(ReportPeriodFilter, { periodLabel: "01/09 a 24/09" }),
        createElement(MetaReportFilters, {
          assets,
          whatsappInstances: instances,
        }),
      ),
    }),
  );
  const field = <T extends Element>(selector: string) =>
    view.container.querySelector<T>(selector)!;

  return { ...view, field };
}

beforeEach(() => {
  presentation.enabled = false;
  router.push.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("report filters href", () => {
  it("omits empty and default params and never carries page", () => {
    expect(
      reportFiltersHref({ ...applied, nameScope: "adset", delivery: "all" }),
    ).toBe(
      "/reports?since=2026-09-01&until=2026-09-24&whatsappInstanceId=instance_a&pageSize=10&view=campaigns",
    );
  });

  it("carries the Insights mode and the column ordering through filter edits", () => {
    expect(
      reportFiltersHref({
        ...applied,
        status: "paused",
        mode: "insights",
        objective: "purchase",
        sort: "purchases",
        dir: "asc",
      }),
    ).toBe(
      "/reports?since=2026-09-01&until=2026-09-24&whatsappInstanceId=instance_a&status=paused&pageSize=10&view=campaigns&mode=insights&objective=purchase&sort=purchases&dir=asc",
    );
  });

  it("keeps the applied ranges when the edited ones are not committable", () => {
    const next = committableReportFilters(
      {
        ...applied,
        until: "2026-08-01",
        compareSince: "2026-08-10",
        status: "paused",
      },
      applied,
    );

    expect(next).toMatchObject({
      since: "2026-09-01",
      until: "2026-09-24",
      compareSince: "",
      compareUntil: "",
      status: "paused",
    });
  });
});

describe("report filters auto-apply", () => {
  it("has no Aplicar button, only hidden submitters", () => {
    const { container } = renderReportFilters();

    expect(container.textContent).not.toContain("Aplicar");

    const submitters = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
    );

    expect(submitters).toHaveLength(2);
    for (const button of submitters) {
      expect(button).toMatchObject({ className: "sr-only", tabIndex: -1 });
    }
  });

  it("applies a select right away, keeping the number filter", () => {
    const { field } = renderReportFilters();

    fireEvent.change(field('select[name="status"]'), {
      target: { value: "paused" },
    });

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      "/reports?since=2026-09-01&until=2026-09-24&whatsappInstanceId=instance_a&status=paused&pageSize=10&view=campaigns",
      { scroll: false },
    );
  });

  it("resets the account when the Business Manager changes", () => {
    const { field } = renderReportFilters({
      businessId: "business_1",
      adAccountId: "act_1",
    });

    fireEvent.change(field('select[name="businessId"]'), {
      target: { value: "business_2" },
    });

    expect(router.push).toHaveBeenCalledWith(
      "/reports?since=2026-09-01&until=2026-09-24&businessId=business_2&whatsappInstanceId=instance_a&pageSize=10&view=campaigns",
      { scroll: false },
    );
  });

  it("commits a typed period date once, after the debounce", () => {
    vi.useFakeTimers();
    const { field } = renderReportFilters();
    const since = field<HTMLInputElement>('input[name="since"]');

    fireEvent.change(since, { target: { value: "0002-09-10" } });
    fireEvent.change(since, { target: { value: "2026-09-10" } });
    expect(router.push).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      "/reports?since=2026-09-10&until=2026-09-24&whatsappInstanceId=instance_a&pageSize=10&view=campaigns",
      { scroll: false },
    );
  });

  it("flushes a pending date on blur", () => {
    vi.useFakeTimers();
    const { field } = renderReportFilters();
    const until = field<HTMLInputElement>('input[name="until"]');

    fireEvent.change(until, { target: { value: "2026-09-20" } });
    fireEvent.blur(until);

    expect(router.push).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("blocks Fim before Inicio with an inline error", () => {
    vi.useFakeTimers();
    const { container, field } = renderReportFilters();
    const until = field<HTMLInputElement>('input[name="until"]');

    fireEvent.change(until, { target: { value: "2026-08-20" } });
    fireEvent.blur(until);
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(router.push).not.toHaveBeenCalled();
    expect(until.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector(".overview-filter-error")?.textContent).toBe(
      "Fim antes do início",
    );
  });

  it("blocks an inverted comparison range", () => {
    vi.useFakeTimers();
    const { field } = renderReportFilters();
    const compareUntil = field<HTMLInputElement>('input[name="compareUntil"]');

    fireEvent.change(field('input[name="compareSince"]'), {
      target: { value: "2026-08-20" },
    });
    fireEvent.change(compareUntil, { target: { value: "2026-08-10" } });
    fireEvent.blur(compareUntil);
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(router.push).not.toHaveBeenCalled();
    expect(compareUntil.getAttribute("aria-invalid")).toBe("true");
  });

  it("masks the account and number selects in presentation mode", () => {
    presentation.enabled = true;
    const { container, field } = renderReportFilters({
      businessId: "business_1",
      adAccountId: "act_1",
    });

    expect(container.querySelector('select[name="businessId"]')).toBeNull();
    expect(
      container.querySelector('select[name="whatsappInstanceId"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("Loja Centro");
    expect(container.textContent).toContain("Número oculto");

    const form = field<HTMLFormElement>(".report-filter-form");
    const data = new FormData(form);

    expect(data.get("businessId")).toBe("business_1");
    expect(data.get("adAccountId")).toBe("act_1");
    expect(data.get("whatsappInstanceId")).toBe("instance_a");
  });
});
