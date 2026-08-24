/**
 * Pure helper functions for scripts/setup.mjs (F6.3). Kept side-effect free
 * (no fs/child_process here) so they can be unit tested directly — see
 * scripts/setup.test.mjs. setup.mjs is the thin orchestrator that wires
 * these decisions to real fs/spawn calls.
 */

/** Extracts the major version number from a `process.version`-style string ("v22.23.2" -> 22). */
export function parseNodeMajorVersion(versionString) {
  const match = /^v?(\d+)\./.exec(versionString ?? "");
  return match ? Number(match[1]) : null;
}

const MIN_SUPPORTED_NODE_MAJOR = 20;

/** Node 20+ is required; anything older gets a warning, not a hard stop. */
export function isNodeVersionSupported(versionString) {
  const major = parseNodeMajorVersion(versionString);
  return {
    major,
    ok: major !== null && major >= MIN_SUPPORTED_NODE_MAJOR,
  };
}

/** Copy .env.example -> .env only when .env is missing — never overwrite a student's existing file. */
export function resolveEnvFileAction({ envExists }) {
  return envExists
    ? { action: "skip", message: ".env already exists — leaving it untouched." }
    : { action: "copy", message: "created .env — fill replace-me-* values" };
}

/** Run pnpm install only when node_modules is missing (idempotent re-runs stay fast). */
export function resolveInstallAction({ nodeModulesExists }) {
  return nodeModulesExists
    ? { action: "skip", message: "node_modules already present — skipping pnpm install." }
    : { action: "install", message: "node_modules not found — running pnpm install..." };
}

/** Prefer `migrate deploy` (no prompts, safe for CI/first boot) when DATABASE_URL is set. */
export function resolveMigrateStrategy({ databaseUrl }) {
  const trimmed = databaseUrl?.trim();
  return trimmed
    ? { action: "deploy", message: "DATABASE_URL detected — running prisma migrate deploy..." }
    : {
        action: "skip",
        message:
          "DATABASE_URL not set — skipping automatic migration. Fill it in .env, then run:\n" +
          "    pnpm --filter @wpptrack/api exec prisma migrate dev --schema prisma/schema.prisma",
      };
}

/** The fallback message printed when `migrate deploy` fails (shadow DB / empty DB cases). */
export const MIGRATE_DEPLOY_FALLBACK_MESSAGE =
  "migrate deploy failed. If this is a fresh/empty database or a shadow-database " +
  "error, run the interactive dev migration instead:\n" +
  "    pnpm --filter @wpptrack/api exec prisma migrate dev --schema prisma/schema.prisma";

/**
 * Admin bootstrap only fires when BOTH SETUP_ADMIN_EMAIL and
 * SETUP_ADMIN_PASSWORD are set, using the existing `create-user` script
 * (apps/api/src/scripts/create-user.ts) — the only path in this codebase
 * that hashes a password correctly and wires the owner membership. Never
 * invents a raw user insert.
 */
export function resolveAdminBootstrapAction({ email, password }) {
  const trimmedEmail = email?.trim();
  const trimmedPassword = password?.trim();

  if (trimmedEmail && trimmedPassword) {
    return { action: "bootstrap", email: trimmedEmail, password: trimmedPassword };
  }

  return {
    action: "skip",
    message:
      "Optional: set SETUP_ADMIN_EMAIL and SETUP_ADMIN_PASSWORD before running setup to " +
      "auto-create an admin. Otherwise, create one manually:\n" +
      '    pnpm --filter @wpptrack/api create-user -- --email you@example.com --password "a-strong-password" --name "Your Name" --workspace "My Agency"\n' +
      "  (or invite a teammate from an existing account once one is logged in).",
  };
}

/** Masks all but the first two characters of the local part of an email — used so bootstrap logs never print a full address. */
export function maskEmail(email) {
  if (!email) {
    return "";
  }
  const [local, domain] = email.split("@");
  if (!domain) {
    return "***";
  }
  return `${local.slice(0, 2)}***@${domain}`;
}

/** Final "what's left to do" checklist printed at the end of a run. */
export function finalChecklistLines() {
  return [
    "Fill LICENSE_KEY / LICENSE_ACCOUNT_IDENTITY / LICENSE_SERVER_URL in .env",
    "docker compose up -d postgres redis (if you're running services locally)",
    "pnpm --filter @wpptrack/api dev",
    "pnpm --filter @wpptrack/web dev",
    "Open http://localhost:3000/backoffice/license and http://localhost:3000/integrations",
  ];
}
