#!/usr/bin/env node
/**
 * First-time setup for the RastrackDash student template (F6.3). Idempotent
 * — safe to re-run after a partial failure or to refresh a checked-out
 * clone. Never prints secrets (env values, passwords).
 *
 * Usage:
 *   node scripts/setup.mjs [--dry-run]
 *   pnpm setup [-- --dry-run]
 */
import { copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  finalChecklistLines,
  isNodeVersionSupported,
  maskEmail,
  MIGRATE_DEPLOY_FALLBACK_MESSAGE,
  resolveAdminBootstrapAction,
  resolveEnvFileAction,
  resolveInstallAction,
  resolveMigrateStrategy,
} from "./setup-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dryRun = process.argv.slice(2).includes("--dry-run");

function log(message) {
  console.log(message);
}

function heading(message) {
  log(`\n== ${message} ==`);
}

/** Runs a command, inheriting stdio. In dry-run mode it only prints what would run. */
function run(command, commandArgs, options = {}) {
  log(`$ ${command} ${commandArgs.join(" ")}`);

  if (dryRun) {
    log("  (dry-run: not executed)");
    return { status: 0 };
  }

  return spawnSync(command, commandArgs, {
    stdio: "inherit",
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
  });
}

function failHard(message) {
  log(`\n${message}`);
  process.exit(1);
}

function checkVersions() {
  heading("Checking toolchain");
  log(`Node.js: ${process.version}`);
  const nodeCheck = isNodeVersionSupported(process.version);
  if (!nodeCheck.ok) {
    log(`  WARNING: Node ${nodeCheck.major ?? "unknown"} detected — Node 20+ is recommended.`);
  }

  const pnpmVersion = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
  if (pnpmVersion.status === 0) {
    log(`pnpm: ${pnpmVersion.stdout.trim()}`);
  } else {
    log("  WARNING: pnpm not found on PATH. Install it first: https://pnpm.io/installation");
  }
}

function ensureEnvFile() {
  heading("Environment file");
  const envPath = path.join(repoRoot, ".env");
  const envExamplePath = path.join(repoRoot, ".env.example");
  const action = resolveEnvFileAction({ envExists: existsSync(envPath) });

  if (action.action === "skip") {
    log(action.message);
    return;
  }

  if (dryRun) {
    log("(dry-run: would copy .env.example -> .env)");
    return;
  }

  copyFileSync(envExamplePath, envPath);
  log(action.message);
}

function ensureDependencies() {
  heading("Dependencies");
  const nodeModulesPath = path.join(repoRoot, "node_modules");
  const action = resolveInstallAction({ nodeModulesExists: existsSync(nodeModulesPath) });
  log(action.message);

  if (action.action !== "install") {
    return;
  }

  const result = run("pnpm", ["install"]);
  if (!dryRun && result.status !== 0) {
    failHard("pnpm install failed.");
  }
}

function generatePrismaClient() {
  heading("Prisma client");
  const result = run("pnpm", ["--filter", "@wpptrack/api", "prisma:generate"]);
  if (!dryRun && result.status !== 0) {
    failHard("prisma generate failed.");
  }
}

function runMigrations() {
  heading("Database migrations");
  const strategy = resolveMigrateStrategy({ databaseUrl: process.env.DATABASE_URL });
  log(strategy.message);

  if (strategy.action !== "deploy") {
    return;
  }

  const result = run("pnpm", ["--filter", "@wpptrack/api", "exec", "prisma", "migrate", "deploy"]);
  if (!dryRun && result.status !== 0) {
    failHard(MIGRATE_DEPLOY_FALLBACK_MESSAGE);
  }
}

function bootstrapAdmin() {
  heading("Admin bootstrap");
  const action = resolveAdminBootstrapAction({
    email: process.env.SETUP_ADMIN_EMAIL,
    password: process.env.SETUP_ADMIN_PASSWORD,
  });

  if (action.action === "skip") {
    log(action.message);
    return;
  }

  log(`Bootstrapping admin user (${maskEmail(action.email)}) via the existing create-user script...`);

  if (dryRun) {
    log("(dry-run: would run pnpm --filter @wpptrack/api create-user -- --email <SETUP_ADMIN_EMAIL> --password <hidden> --role owner)");
    return;
  }

  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@wpptrack/api",
      "create-user",
      "--",
      "--email",
      action.email,
      "--password",
      action.password,
      "--role",
      "owner",
    ],
    { stdio: "inherit", cwd: repoRoot, env: process.env },
  );

  if (result.status !== 0) {
    log("  Admin bootstrap failed — see output above. You can retry with `pnpm --filter @wpptrack/api create-user -- ...` manually.");
  }
}

function printFinalChecklist() {
  heading("Next steps");
  for (const line of finalChecklistLines()) {
    log(`  - ${line}`);
  }
  log("");
}

function main() {
  log("RastrackDash setup");
  if (dryRun) {
    log("(dry-run mode — no destructive actions will be executed)");
  }

  checkVersions();
  ensureEnvFile();
  ensureDependencies();
  generatePrismaClient();
  runMigrations();
  bootstrapAdmin();
  printFinalChecklist();
}

main();
