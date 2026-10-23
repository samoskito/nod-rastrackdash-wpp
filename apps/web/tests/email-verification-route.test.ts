import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import EmailVerificationPage from "../src/app/login/verify/page";

describe("email verification route", () => {
  it("renders invalid token state when verification token is missing", async () => {
    const element = await EmailVerificationPage({
      searchParams: Promise.resolve({})
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Token inválido");
    expect(html).toContain('href="/settings"');
  });

  it("renders email verification form when token is present", async () => {
    const element = await EmailVerificationPage({
      searchParams: Promise.resolve({
        token: "verify-token-1234567890"
      })
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Confirmar email");
    expect(html).toContain('name="token"');
    expect(html).toContain('value="verify-token-1234567890"');
    expect(html).toContain("Validar verificação");
  });
});
