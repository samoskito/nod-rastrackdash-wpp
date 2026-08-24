import assert from "node:assert/strict";
import { test } from "node:test";
import {
  finalChecklistLines,
  isNodeVersionSupported,
  maskEmail,
  parseNodeMajorVersion,
  resolveAdminBootstrapAction,
  resolveEnvFileAction,
  resolveInstallAction,
  resolveMigrateStrategy,
} from "./setup-helpers.mjs";

test("parseNodeMajorVersion reads the major version out of a v-prefixed string", () => {
  assert.equal(parseNodeMajorVersion("v22.23.2"), 22);
  assert.equal(parseNodeMajorVersion("v20.0.0"), 20);
});

test("parseNodeMajorVersion returns null for garbage input", () => {
  assert.equal(parseNodeMajorVersion(""), null);
  assert.equal(parseNodeMajorVersion(undefined), null);
  assert.equal(parseNodeMajorVersion("not-a-version"), null);
});

test("isNodeVersionSupported accepts Node 20+", () => {
  assert.deepEqual(isNodeVersionSupported("v20.0.0"), { major: 20, ok: true });
  assert.deepEqual(isNodeVersionSupported("v22.23.2"), { major: 22, ok: true });
});

test("isNodeVersionSupported warns below Node 20", () => {
  assert.deepEqual(isNodeVersionSupported("v18.19.0"), { major: 18, ok: false });
});

test("resolveEnvFileAction copies .env.example only when .env is missing", () => {
  assert.equal(resolveEnvFileAction({ envExists: false }).action, "copy");
  assert.equal(resolveEnvFileAction({ envExists: true }).action, "skip");
});

test("resolveEnvFileAction never overwrites an existing .env", () => {
  const result = resolveEnvFileAction({ envExists: true });
  assert.match(result.message, /untouched/);
});

test("resolveInstallAction only installs when node_modules is missing", () => {
  assert.equal(resolveInstallAction({ nodeModulesExists: false }).action, "install");
  assert.equal(resolveInstallAction({ nodeModulesExists: true }).action, "skip");
});

test("resolveMigrateStrategy prefers migrate deploy when DATABASE_URL is set", () => {
  assert.equal(resolveMigrateStrategy({ databaseUrl: "postgresql://x" }).action, "deploy");
});

test("resolveMigrateStrategy skips automatic migration without DATABASE_URL", () => {
  assert.equal(resolveMigrateStrategy({ databaseUrl: undefined }).action, "skip");
  assert.equal(resolveMigrateStrategy({ databaseUrl: "   " }).action, "skip");
});

test("resolveAdminBootstrapAction only bootstraps when both email and password are set", () => {
  const bootstrap = resolveAdminBootstrapAction({
    email: "admin@example.com",
    password: "s3cret!",
  });
  assert.equal(bootstrap.action, "bootstrap");
  assert.equal(bootstrap.email, "admin@example.com");
  assert.equal(bootstrap.password, "s3cret!");
});

test("resolveAdminBootstrapAction skips when either value is missing", () => {
  assert.equal(resolveAdminBootstrapAction({ email: "admin@example.com", password: undefined }).action, "skip");
  assert.equal(resolveAdminBootstrapAction({ email: undefined, password: "s3cret!" }).action, "skip");
  assert.equal(resolveAdminBootstrapAction({ email: undefined, password: undefined }).action, "skip");
});

test("resolveAdminBootstrapAction skip message points to the existing create-user script, not a raw insert", () => {
  const result = resolveAdminBootstrapAction({ email: undefined, password: undefined });
  assert.match(result.message, /create-user/);
});

test("maskEmail hides everything but the first two characters and the domain", () => {
  assert.equal(maskEmail("comercial@palmup.com.br"), "co***@palmup.com.br");
});

test("maskEmail handles empty and malformed input without throwing", () => {
  assert.equal(maskEmail(""), "");
  assert.equal(maskEmail("not-an-email"), "***");
});

test("finalChecklistLines lists every documented next step", () => {
  const lines = finalChecklistLines();
  assert.equal(lines.length, 5);
  assert.ok(lines.some((line) => line.includes("LICENSE_KEY")));
  assert.ok(lines.some((line) => line.includes("@wpptrack/api dev")));
  assert.ok(lines.some((line) => line.includes("@wpptrack/web dev")));
  assert.ok(lines.some((line) => line.includes("/backoffice/license")));
});
