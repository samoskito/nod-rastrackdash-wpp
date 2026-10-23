import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AccountActivationPage from "../src/app/login/activate/page";

describe("account activation route", () => {
  it("renders a generic unavailable state when the token is missing", async () => {
    const element = await AccountActivationPage({
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Link indisponível");
    expect(html).toContain("inválido, expirou ou já foi utilizado");
    expect(html).toContain('href="mailto:suporte@rastrack.app"');
    expect(html).not.toContain("workspace_");
  });

  it("renders password and confirmation controls for a valid-shaped token", async () => {
    const element = await AccountActivationPage({
      searchParams: Promise.resolve({
        token: "activation-token-1234567890",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Crie sua senha");
    expect(html).toContain('name="password"');
    expect(html).toContain('name="passwordConfirmation"');
    expect(html).toContain("Criar senha e acessar");
    expect(html).not.toContain("activation-token-1234567890");
  });
});
