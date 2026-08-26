import { describe, expect, it } from "vitest";
import {
  parseDeploymentConfig,
  parseWebOrigin,
} from "../src/config/deployment-config";

describe("WEB_ORIGIN deployment configuration", () => {
  it("requires an explicitly configured origin in production", () => {
    expect(() => parseDeploymentConfig({ NODE_ENV: "production" })).toThrow(
      "Invalid WEB_ORIGIN",
    );
  });

  it("accepts an HTTPS origin and normalizes a trailing slash", () => {
    expect(
      parseWebOrigin({
        NODE_ENV: "production",
        WEB_ORIGIN: " https://console.example.com/ ",
      }),
    ).toBe("https://console.example.com");
  });

  it("allows HTTP only for localhost in development and test", () => {
    expect(
      parseWebOrigin({
        NODE_ENV: "development",
        WEB_ORIGIN: "http://localhost:3000",
      }),
    ).toBe("http://localhost:3000");
    expect(() =>
      parseWebOrigin({
        NODE_ENV: "production",
        WEB_ORIGIN: "http://localhost:3000",
      }),
    ).toThrow("Invalid WEB_ORIGIN");
    expect(() =>
      parseWebOrigin({
        NODE_ENV: "development",
        WEB_ORIGIN: "http://student.example.com",
      }),
    ).toThrow("Invalid WEB_ORIGIN");
  });

  it("rejects a URL with a path, query, hash, or credentials", () => {
    for (const WEB_ORIGIN of [
      "https://console.example.com/app",
      "https://console.example.com/?next=/login",
      "https://console.example.com/#login",
      "https://user:password@console.example.com",
    ]) {
      expect(() =>
        parseWebOrigin({ NODE_ENV: "production", WEB_ORIGIN }),
      ).toThrow("Invalid WEB_ORIGIN");
    }
  });
});
