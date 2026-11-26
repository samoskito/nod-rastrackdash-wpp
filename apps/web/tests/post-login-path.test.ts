import { describe, expect, it } from "vitest";
import { resolvePostLoginPath } from "../src/lib/post-login-path";

describe("resolvePostLoginPath", () => {
  it("sends the platform admin to the Backoffice clients screen by default", () => {
    expect(resolvePostLoginPath(null, "platform_owner")).toBe(
      "/backoffice/clients",
    );
    expect(resolvePostLoginPath(undefined, "platform_operator")).toBe(
      "/backoffice/clients",
    );
  });

  it("treats the bare overview/home redirect as no destination for the admin", () => {
    expect(resolvePostLoginPath("/overview", "platform_owner")).toBe(
      "/backoffice/clients",
    );
    expect(resolvePostLoginPath("/", "platform_owner")).toBe(
      "/backoffice/clients",
    );
  });

  it("honours an explicit internal redirectTo for the admin", () => {
    expect(resolvePostLoginPath("/leads?x=1", "platform_owner")).toBe(
      "/leads?x=1",
    );
    expect(
      resolvePostLoginPath("/backoffice/license", "platform_owner"),
    ).toBe("/backoffice/license");
  });

  it("keeps the regular user behaviour", () => {
    expect(resolvePostLoginPath(null, null)).toBe("/overview");
    expect(resolvePostLoginPath("/overview", undefined)).toBe("/overview");
    expect(resolvePostLoginPath("/reports", null)).toBe("/reports");
  });

  it("rejects external or invalid redirects", () => {
    expect(resolvePostLoginPath("https://evil.test", null)).toBe("/overview");
    expect(resolvePostLoginPath("//evil.test", null)).toBe("/overview");
    expect(resolvePostLoginPath("//evil.test", "platform_owner")).toBe(
      "/backoffice/clients",
    );
    expect(resolvePostLoginPath("javascript:alert(1)", null)).toBe(
      "/overview",
    );
  });
});
