import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LoginPage from "../src/app/login/page";

const originalGoogleFlag = process.env.AUTH_GOOGLE_ENABLED;

beforeEach(() => {
  delete process.env.AUTH_GOOGLE_ENABLED;
});

afterEach(() => {
  if (originalGoogleFlag === undefined) {
    delete process.env.AUTH_GOOGLE_ENABLED;
  } else {
    process.env.AUTH_GOOGLE_ENABLED = originalGoogleFlag;
  }
});

describe("login route", () => {
  it("renders the planned login entry point", async () => {
    const element = await LoginPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Entrar no RastrackDash");
    expect(html).toContain("Telemetria de conversoes");
    expect(html).not.toContain("Entrar com Google");
    expect(html).not.toContain('href="/login/google"');
    expect(html).toContain('href="/login/forgot"');
    expect(html).toContain('aria-label="Mostrar senha"');
    expect(html).toContain("Cobertura da plataforma");
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).not.toContain("Criar conta");
  });

  it("shows Google login only when the deployment flag is enabled", async () => {
    process.env.AUTH_GOOGLE_ENABLED = "true";
    const element = await LoginPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Entrar com Google");
    expect(html).toContain('href="/login/google"');
  });

  it("does not claim static live platform health on the public login screen", async () => {
    const element = await LoginPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).not.toContain("API online");
    expect(html).not.toContain("99.2% aceito");
    expect(html).not.toContain("Fila estavel");
    expect(html).not.toContain("Sinal ativo");
  });

  it("renders a clear Google OAuth callback error", async () => {
    const element = await LoginPage({
      searchParams: Promise.resolve({
        error: "google_exchange"
      })
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Nao foi possivel concluir o login com Google.");
  });
});
