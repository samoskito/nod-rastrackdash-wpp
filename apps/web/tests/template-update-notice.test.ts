// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TemplateUpdateNotice,
  templateUpdateDismissKey,
} from "../src/components/template-update-notice";
import { TEMPLATE_UPDATE_GUIDE_URL } from "../src/lib/template-version-format";

const DEPLOYED = "0123456789abcdef0123456789abcdef01234567";
const LATEST = "fedcba9876543210fedcba9876543210fedcba98";
const NEWER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function notice(props: Partial<{ latestMainSha: string; userId: string }> = {}) {
  return createElement(TemplateUpdateNotice, {
    deployedSha: DEPLOYED,
    latestMainSha: props.latestMainSha ?? LATEST,
    userId: props.userId ?? "owner-1",
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TemplateUpdateNotice", () => {
  it("shows the update notice with the short installed SHA and the fixed guide link", () => {
    render(notice());

    expect(screen.getByText("Há uma atualização disponível")).toBeTruthy();
    expect(screen.getByText("0123456").tagName).toBe("CODE");
    expect(document.body.textContent).not.toContain(DEPLOYED);

    const link = screen.getByRole("link", { name: /Ver guia de atualização/ });
    expect(link.getAttribute("href")).toBe(TEMPLATE_UPDATE_GUIDE_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("dismisses with an accessible button, persists the pair and keeps focus on a status message", () => {
    render(notice());

    const button = screen.getByRole("button", {
      name: "Dispensar aviso de atualização",
    });
    expect(button.getAttribute("type")).toBe("button");
    button.focus();
    fireEvent.click(button);

    expect(screen.queryByText("Há uma atualização disponível")).toBeNull();
    expect(window.localStorage.getItem(templateUpdateDismissKey("owner-1"))).toBe(
      `${DEPLOYED}:${LATEST}`,
    );
    const confirmation = screen.getByRole("status");
    expect(confirmation.textContent).toContain("dispensado");
    expect(document.activeElement).toBe(confirmation);
  });

  it("stays dismissed on the next visit for the same installed/latest pair", () => {
    window.localStorage.setItem(
      templateUpdateDismissKey("owner-1"),
      `${DEPLOYED}:${LATEST}`,
    );

    render(notice());

    expect(screen.queryByText("Há uma atualização disponível")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("resurfaces when main moves to a new revision", () => {
    window.localStorage.setItem(
      templateUpdateDismissKey("owner-1"),
      `${DEPLOYED}:${LATEST}`,
    );

    render(notice({ latestMainSha: NEWER }));

    expect(screen.getByText("Há uma atualização disponível")).toBeTruthy();
  });

  it("scopes the dismissal to the signed-in owner", () => {
    window.localStorage.setItem(
      templateUpdateDismissKey("owner-1"),
      `${DEPLOYED}:${LATEST}`,
    );

    render(notice({ userId: "owner-2" }));

    expect(screen.getByText("Há uma atualização disponível")).toBeTruthy();
  });

  it("works when localStorage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    render(notice());
    expect(screen.getByText("Há uma atualização disponível")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Dispensar aviso de atualização" }),
    );
    expect(screen.queryByText("Há uma atualização disponível")).toBeNull();
  });

  it("server-renders nothing and hydrates without a mismatch", async () => {
    const html = renderToString(notice());
    expect(html).toBe("");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const recoverable: unknown[] = [];

    await act(async () => {
      hydrateRoot(container, notice(), {
        onRecoverableError: (error) => recoverable.push(error),
      });
    });

    expect(recoverable).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Há uma atualização disponível");
    container.remove();
  });
});
