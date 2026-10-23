import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ForgotPasswordPage from "../src/app/login/forgot/page";
import ResetPasswordPage from "../src/app/login/reset/page";

describe("password reset routes", () => {
  it("renders password reset request form", async () => {
    const element = await ForgotPasswordPage();
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Recuperar senha");
    expect(html).toContain('name="email"');
    expect(html).toContain("Enviar link de recuperação");
    expect(html).toContain('href="/login"');
  });

  it("renders invalid token state when reset token is missing", async () => {
    const element = await ResetPasswordPage({
      searchParams: Promise.resolve({})
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Token inválido");
    expect(html).toContain('href="/login/forgot"');
  });

  it("renders password reset confirmation form when token is present", async () => {
    const element = await ResetPasswordPage({
      searchParams: Promise.resolve({
        token: "reset-token-1234567890"
      })
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Nova senha");
    expect(html).toContain('name="token"');
    expect(html).toContain('value="reset-token-1234567890"');
    expect(html).toContain('name="password"');
    expect(html).toContain("Redefinir senha");
  });
});
