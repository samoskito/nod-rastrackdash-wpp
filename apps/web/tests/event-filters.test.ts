// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import {
  EventFilters,
  committableEventFilters,
  eventFiltersHref,
  type EventFilterValues,
} from "../src/app/(app)/events/event-filters";

const applied: EventFilterValues = {
  since: "2026-09-01",
  until: "2026-09-24",
  pageSize: "50",
  eventName: "Purchase",
  status: "",
  source: "system",
};

const period = "since=2026-09-01&until=2026-09-24&pageSize=50";

const eventOptions = [
  { eventName: "LeadSubmitted", label: "Conversas reais iniciadas" },
  { eventName: "QualifiedLead", label: "Lead qualificado" },
  { eventName: "Purchase", label: "Compras" },
];

function renderEventFilters(
  overrides: Partial<EventFilterValues> = {},
  page = 3,
) {
  const props = (
    next: Partial<EventFilterValues> = {},
    nextPage = page,
    options = eventOptions,
  ) => ({
    applied: { ...applied, ...overrides, ...next },
    eventOptions: options,
    page: nextPage,
    rangeLabel: "2026-09-01 a 2026-09-24",
  });
  const view = render(createElement(EventFilters, props()));
  const field = <T extends Element>(selector: string) =>
    view.container.querySelector<T>(selector)!;
  const navigate = (
    next: Partial<EventFilterValues>,
    nextPage = 1,
    options = eventOptions,
  ) =>
    view.rerender(createElement(EventFilters, props(next, nextPage, options)));

  return { ...view, field, navigate };
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function pushedHrefs() {
  return router.push.mock.calls.map(([href]) => href);
}

beforeEach(() => {
  router.push.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("event filters href", () => {
  it("follows the pagination order, always carries period and page size, never page", () => {
    expect(eventFiltersHref(applied)).toBe(
      `/events?${period}&eventName=Purchase&source=system`,
    );
    expect(
      eventFiltersHref({
        ...applied,
        eventName: "",
        status: "failed",
        source: "",
      }),
    ).toBe(`/events?${period}&status=failed`);
  });

  it("keeps the applied period unless both ends are complete and ordered", () => {
    for (const draft of [
      { since: "", until: "2026-09-24" },
      { since: "2026-09-01", until: "" },
      { since: "0002-09-01", until: "2026-09-24" },
      { since: "2026-09-10", until: "2026-09-01" },
    ]) {
      expect(
        committableEventFilters(
          { ...applied, ...draft, status: "failed" },
          applied,
        ),
      ).toMatchObject({
        since: "2026-09-01",
        until: "2026-09-24",
        status: "failed",
      });
    }

    expect(
      committableEventFilters(
        { ...applied, since: "2026-09-05", until: "2026-09-05" },
        applied,
      ),
    ).toMatchObject({ since: "2026-09-05", until: "2026-09-05" });
  });
});

describe("event filters auto-apply", () => {
  it("has no Aplicar button, only a hidden submitter for Enter and no-JS GET", () => {
    const { container, field } = renderEventFilters();
    const form = field<HTMLFormElement>("form");

    expect(container.textContent).not.toContain("Aplicar");
    expect(form.getAttribute("action")).toBe("/events");
    expect(form.getAttribute("method")).toBeNull();

    const submitters = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
    );

    expect(submitters).toHaveLength(1);
    expect(submitters[0]).toMatchObject({ className: "sr-only", tabIndex: -1 });

    const data = new FormData(form);

    expect(Object.fromEntries(data)).toEqual({
      pageSize: "50",
      since: "2026-09-01",
      until: "2026-09-24",
      eventName: "Purchase",
      status: "",
      source: "system",
    });
    expect(data.get("page")).toBeNull();
  });

  it("applies each select right away on page 1, keeping period and page size", () => {
    const { field } = renderEventFilters();

    fireEvent.change(field('select[name="eventName"]'), {
      target: { value: "QualifiedLead" },
    });
    fireEvent.change(field('select[name="status"]'), {
      target: { value: "blocked" },
    });
    fireEvent.change(field('select[name="source"]'), {
      target: { value: "" },
    });

    expect(pushedHrefs()).toEqual([
      `/events?${period}&eventName=QualifiedLead&source=system`,
      `/events?${period}&eventName=QualifiedLead&status=blocked&source=system`,
      `/events?${period}&eventName=QualifiedLead&status=blocked`,
    ]);
    expect(router.push).toHaveBeenLastCalledWith(expect.any(String), {
      scroll: false,
    });
  });

  it("keeps the latest of rapid select changes and skips a no-op", () => {
    const { field } = renderEventFilters();
    const status = field<HTMLSelectElement>('select[name="status"]');

    fireEvent.change(status, { target: { value: "failed" } });
    fireEvent.change(status, { target: { value: "sent" } });
    fireEvent.change(status, { target: { value: "sent" } });

    expect(pushedHrefs()).toEqual([
      `/events?${period}&eventName=Purchase&status=failed&source=system`,
      `/events?${period}&eventName=Purchase&status=sent&source=system`,
    ]);
    expect(status.value).toBe("sent");
  });

  it("debounces a typed date and pushes once", () => {
    vi.useFakeTimers();
    const { field } = renderEventFilters();
    const since = field<HTMLInputElement>('input[name="since"]');

    fireEvent.change(since, { target: { value: "2026-09-05" } });
    advance(500);
    fireEvent.change(since, { target: { value: "2026-09-10" } });
    advance(799);
    expect(router.push).not.toHaveBeenCalled();

    advance(1);
    expect(pushedHrefs()).toEqual([
      `/events?${period.replace("2026-09-01", "2026-09-10")}&eventName=Purchase&source=system`,
    ]);
  });

  it("flushes a date on blur without a second push later", () => {
    vi.useFakeTimers();
    const { field } = renderEventFilters();
    const until = field<HTMLInputElement>('input[name="until"]');

    fireEvent.change(until, { target: { value: "2026-09-20" } });
    fireEvent.blur(until);
    expect(pushedHrefs()).toEqual([
      `/events?${period.replace("2026-09-24", "2026-09-20")}&eventName=Purchase&source=system`,
    ]);

    advance(2000);
    fireEvent.blur(until);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("applies a date on Enter once", () => {
    vi.useFakeTimers();
    const { field } = renderEventFilters();
    const since = field<HTMLInputElement>('input[name="since"]');

    fireEvent.change(since, { target: { value: "2026-09-10" } });
    fireEvent.submit(field("form"));
    expect(router.push).toHaveBeenCalledTimes(1);

    fireEvent.submit(field("form"));
    fireEvent.blur(since);
    advance(2000);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("does not navigate when a date is blurred or Enter is pressed without edits", () => {
    const { field } = renderEventFilters();

    fireEvent.blur(field('input[name="since"]'));
    fireEvent.blur(field('input[name="until"]'));
    fireEvent.submit(field("form"));

    expect(router.push).not.toHaveBeenCalled();
  });

  it("never navigates with a half-typed or cleared date", () => {
    vi.useFakeTimers();
    const { field } = renderEventFilters();
    const since = field<HTMLInputElement>('input[name="since"]');
    const until = field<HTMLInputElement>('input[name="until"]');

    fireEvent.change(since, { target: { value: "0002-09-10" } });
    advance(800);
    fireEvent.change(until, { target: { value: "" } });
    fireEvent.blur(until);
    fireEvent.submit(field("form"));
    advance(2000);

    expect(router.push).not.toHaveBeenCalled();
    expect(since.value).toBe("0002-09-10");
  });

  it("blocks Fim before Inicio with an accessible inline error", () => {
    vi.useFakeTimers();
    const { container, field } = renderEventFilters();
    const until = field<HTMLInputElement>('input[name="until"]');

    fireEvent.change(until, { target: { value: "2026-08-20" } });
    fireEvent.blur(until);
    advance(2000);

    expect(router.push).not.toHaveBeenCalled();
    expect(until.getAttribute("aria-invalid")).toBe("true");

    const error = container.querySelector(".overview-filter-error")!;

    expect(error.textContent).toBe("Fim antes do início");
    expect(until.getAttribute("aria-describedby")).toBe(error.id);

    fireEvent.change(until, { target: { value: "2026-09-20" } });
    expect(until.getAttribute("aria-invalid")).toBeNull();
    expect(container.querySelector(".overview-filter-error")).toBeNull();
  });

  it("applies a select with the current valid period while a date draft is invalid", () => {
    vi.useFakeTimers();
    const { field, navigate } = renderEventFilters();
    const until = field<HTMLInputElement>('input[name="until"]');

    fireEvent.change(until, { target: { value: "2026-08-20" } });
    fireEvent.change(field('select[name="status"]'), {
      target: { value: "failed" },
    });
    advance(2000);

    expect(pushedHrefs()).toEqual([
      `/events?${period}&eventName=Purchase&status=failed&source=system`,
    ]);

    // The landing keeps the draft the user is still fixing.
    navigate({ status: "failed" });
    expect(until.value).toBe("2026-08-20");
    expect(until.getAttribute("aria-invalid")).toBe("true");
  });

  it("folds a pending date into a select change, with no later push", () => {
    vi.useFakeTimers();
    const { field } = renderEventFilters();

    fireEvent.change(field('input[name="since"]'), {
      target: { value: "2026-09-10" },
    });
    fireEvent.change(field('select[name="source"]'), {
      target: { value: "manual_test" },
    });
    advance(2000);

    expect(pushedHrefs()).toEqual([
      `/events?${period.replace("2026-09-01", "2026-09-10")}&eventName=Purchase&source=manual_test`,
    ]);
  });

  it("keeps a newer date draft when its own navigation lands late", () => {
    vi.useFakeTimers();
    const { field, navigate } = renderEventFilters();
    const since = field<HTMLInputElement>('input[name="since"]');

    fireEvent.change(since, { target: { value: "2026-09-05" } });
    advance(800);
    fireEvent.change(since, { target: { value: "2026-09-10" } });
    navigate({ since: "2026-09-05" });

    expect(since.value).toBe("2026-09-10");
    advance(800);
    expect(pushedHrefs()).toEqual([
      `/events?${period.replace("2026-09-01", "2026-09-05")}&eventName=Purchase&source=system`,
      `/events?${period.replace("2026-09-01", "2026-09-10")}&eventName=Purchase&source=system`,
    ]);
  });

  it("does not let an older own navigation undo a newer select", () => {
    const { field, navigate } = renderEventFilters();
    const status = field<HTMLSelectElement>('select[name="status"]');

    fireEvent.change(status, { target: { value: "failed" } });
    fireEvent.change(field('select[name="source"]'), {
      target: { value: "other" },
    });
    // The first push lands, then the second.
    navigate({ status: "failed" });
    expect(field<HTMLSelectElement>('select[name="source"]').value).toBe(
      "other",
    );
    navigate({ status: "failed", source: "other" });

    expect(status.value).toBe("failed");
    expect(field<HTMLSelectElement>('select[name="source"]').value).toBe(
      "other",
    );
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it("syncs fields and drops a pending date on back/forward", () => {
    vi.useFakeTimers();
    const { field, navigate } = renderEventFilters();
    const since = field<HTMLInputElement>('input[name="since"]');

    fireEvent.change(since, { target: { value: "2026-09-10" } });
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    navigate({ since: "2026-08-01", status: "queued" });
    advance(2000);

    expect(router.push).not.toHaveBeenCalled();
    expect(since.value).toBe("2026-08-01");
    expect(field<HTMLSelectElement>('select[name="status"]').value).toBe(
      "queued",
    );
  });

  it("drops a pending date when pagination lands first, even on page 1", () => {
    vi.useFakeTimers();
    const { field, navigate } = renderEventFilters({}, 2);
    const since = field<HTMLInputElement>('input[name="since"]');

    fireEvent.change(since, { target: { value: "2026-09-10" } });
    // Anterior with the same filters, back to page 1.
    navigate({}, 1);
    advance(2000);

    expect(router.push).not.toHaveBeenCalled();
    expect(since.value).toBe("2026-09-01");
  });

  it("clears pending timers on unmount", () => {
    vi.useFakeTimers();
    const { field, unmount } = renderEventFilters();

    fireEvent.change(field('input[name="since"]'), {
      target: { value: "2026-09-10" },
    });
    unmount();
    advance(2000);

    expect(router.push).not.toHaveBeenCalled();
  });

  it("links Limpar filtros to the same period and page size and discards the pending date", () => {
    vi.useFakeTimers();
    const { field, navigate } = renderEventFilters();
    const clear = field<HTMLAnchorElement>("[data-event-filters-clear]");
    const since = field<HTMLInputElement>('input[name="since"]');

    expect(clear.getAttribute("href")).toBe(`/events?${period}`);
    expect(clear.textContent).toBe("Limpar filtros");

    fireEvent.change(since, { target: { value: "2026-09-10" } });
    fireEvent.blur(since, { relatedTarget: clear });
    clear.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(clear);
    advance(2000);
    expect(router.push).not.toHaveBeenCalled();

    navigate({ eventName: "", source: "" });
    expect(since.value).toBe("2026-09-01");
    expect(field<HTMLSelectElement>('select[name="eventName"]').value).toBe("");
    expect(field<HTMLSelectElement>('select[name="source"]').value).toBe("");
    expect(field("[data-event-filters-clear]")).toBeNull();
  });

  it("hides Limpar filtros when only the period is set", () => {
    const { container } = renderEventFilters({ eventName: "", source: "" });

    expect(container.querySelector("[data-event-filters-clear]")).toBeNull();
    expect(container.textContent).toContain(
      "Todos os tipos, estados e origens estão incluídos.",
    );
  });

  it("keeps the filters panel open while its filters change", () => {
    const { field, navigate } = renderEventFilters(
      { eventName: "", source: "" },
      1,
    );
    const details = field<HTMLDetailsElement>("details");

    expect(details.open).toBe(false);
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    fireEvent.change(field('select[name="status"]'), {
      target: { value: "failed" },
    });
    navigate({ eventName: "", source: "", status: "failed" });
    navigate({ eventName: "", source: "" }, 1);

    expect(details.open).toBe(true);
  });

  it("keeps the selected event when the new period has no options for it", () => {
    const { field, navigate } = renderEventFilters();
    const eventName = field<HTMLSelectElement>('select[name="eventName"]');

    // The page always appends the applied event to the options it passes.
    navigate({ since: "2026-08-01" }, 1, [
      { eventName: "LeadSubmitted", label: "Conversas reais iniciadas" },
      { eventName: "Purchase", label: "Compras" },
    ]);

    expect(eventName.value).toBe("Purchase");
    expect(Array.from(eventName.options).map((option) => option.value)).toEqual(
      ["", "LeadSubmitted", "Purchase"],
    );
  });

  it("shows the updating status while a navigation is pending", () => {
    const { container } = renderEventFilters();
    const status = container.querySelector('[role="status"]')!;

    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("");
    expect(
      container
        .querySelector(".overview-filter-status")!
        .getAttribute("data-pending"),
    ).toBeNull();
  });
});
