# ACCEPTANCE-v1 — RastrackDash Student Edition v1.0.0

Evaluated: 2026-08-24 · Branch `feat/v1-release-docs` (base `main` @ `4394196`) · Repo `github.com/samoskito/nod-rastrackdash-wpp`

This matrix maps [spec §15 "Criterios de Aceite"](../superpowers/specs/2026-08-19-nod-rastrackdash-wpp-student-edition-design.md#15-criterios-de-aceite) to the current, honest state of the public template. Statuses are **not aspirational** — anything not live-verified in this session is marked `partial` or `not_run` with a reason, even where the underlying code exists and is unit-tested.

Statuses: `pass` (live-verified or fully covered by passing automated tests that exercise the real behavior) · `partial` (implemented + some verification, but not end-to-end / not live) · `fail` (known broken) · `not_run` (no evidence gathered) · `n/a` (out of scope for this repo).

## Acceptance matrix (spec §15)

| ID | Criterion | Status | Evidence / notes |
|---|---|---|---|
| A1 | Guru purchase → key delivered (email and/or WhatsApp) | `partial` | Delivery module (spec §6.7) lives entirely in private `dash-com-ia` — nothing to test in this repo. Program history: worked with hotfixes earlier; also had prod notify-skip issues at one point. **Not re-verified with fresh evidence in this session** — do not read as currently green. |
| A2 | Clone template → setup → activate → app `ativo` | `pass` | `pnpm setup` (PR #13, `scripts/setup.mjs` + `scripts/setup.test.mjs`) wires env/install/prisma; onboarding checklist backed by `GET /onboarding/status` (`apps/api/test/onboarding/*`, 10/10 passing). `activate()` was smoke-tested end-to-end with a real test key against the production license server (`wpptrack-api.rastrack.app`) after the cacheToken fix (PR #3 `ebfeb22`) → resulted in `active`/usable state. Caveat: clone+setup+activate were verified as separate pieces, not one continuous fresh-clone run in this chat. |
| A3 | Grace state: <72h without contact does not interrupt use | `partial` | Unit-tested: `license-client.service.test.ts` — "heartbeat network failure keeps prior status (grace via cache)", "getState() reports grace just inside the 72h window" / "blocked just past it" (all passing, run 2026-08-24). No live drill severing connectivity to the real server for ~72h. |
| A4 | Revocation (refund/chargeback/manual) soft-locks on next successful check-in, even inside grace | `not_run` | Trigger (Guru refund/admin revoke → `License` state) lives in private `dash-com-ia`. No live evidence gathered this session. |
| A5 | Expiry without renewal → grace → soft-lock (read-only); approved renewal reverts automatically, no new key | `not_run` | Same as A4 — no live evidence this session. Flagged in the task brief as likely `not_run` absent fresh proof. |
| A6 | Same key activates >1 instance without technical block; each activation creates a visible `LicenseActivation` telemetry record | `not_run` | `LicenseActivation` telemetry is server-side/private (spec §6.1, §6.6). Public client only calls `activate`/`heartbeat`. No live multi-instance run exercised this session. |
| A7 | `activate()` with an account identity different from the one already bound → `403` | `partial` | Client-side handling unit-tested: `license-client.service.test.ts` "activate() account mismatch" throws `LicenseAccountMismatchError` on both `403` and `409` (passing). Server-side enforcement is private; not exercised end-to-end with two real distinct accounts this session. |
| A8 | Guru webhook without a valid signature never issues or revokes a license | `not_run` | Signature verification (spec §6.4) lives entirely in private `dash-com-ia`; nothing in this public repo to test. Verify via that repo's own suite. |
| A9 | Generated template contains no `.env`, no PalmUP secrets, no production customer data (secret scan) | `not_run` | `gitleaks` and `git-secrets` are **not installed** in this environment (checked 2026-08-24). See "How to re-run" for the exact command to run before tagging. `.gitignore` excludes `.env`; `.env.example` contains only `replace-me-*` placeholders (spot-checked, no live secrets present). |
| A10 | Student can configure at least one WhatsApp provider (Uazapi direct, WAHA, Z-API, or NOD API) without editing core code | `pass` | Registry pattern (PR #4 `4739bf8`, PR #5 `d3c7e4d`) + adapters `uazapi_byo`, `nod_api` (PR #6 `15e7255`), `waha` (PR #7 `1357b3a`), `zapi` (PR #8 `6943a42`). All covered by the green `@wpptrack/api` suite (152/152, run 2026-08-24): `whatsapp-provider.registry.test.ts`, `whatsapp-providers-bootstrap.service.test.ts`, `uazapi-byo.adapter.test.ts`, `waha-whatsapp.adapter.test.ts`, `nod-api-whatsapp.adapter.test.ts`, `zapi-whatsapp.adapter.test.ts`. |
| A11 | Multi-provider inbound webhooks (Umbler, Gupshup, WAHA, Z-API) keep working | `partial` | WAHA/Z-API parsers (PR #9 `6805ba3`) have dedicated, passing tests (`waha-v1.parser.test.ts` 10/10, `zapi-v1.parser.test.ts` 10/10). Umbler/Gupshup parsers pre-date this program (`apps/api/src/inbound-webhooks/providers/{umbler,gupshup}`) and have **no dedicated test files** under `apps/api/test/inbound-webhooks/providers/` in this checkout — not independently re-verified this session. |
| A12 | Student customizes name/logo/favicon/color while the "powered by PalmUP" footer and RastrackDash residual brand stay visible and non-removable | `pass` | PR #12 `6ebd39d`. `apps/web/tests/brand-footer.test.ts` (3/3) and `apps/web/tests/app-layout.test.ts` (18/18) passing (run 2026-08-24), asserting the `RastrackDash · powered by PalmUP` footer renders regardless of `BRAND_*` env. |
| A13 | Student backoffice creates workspace/client, sees diagnostics, sees own license status read-only, with no issue/revoke access | `partial` | PR #11 `87a5715`. `license-client-status.controller.test.ts` (5/5) confirms the status endpoint exposes no mutating routes. `onboarding.service.test.ts` + `onboarding.controller.test.ts` (10/10) cover the diagnostics checklist. Gap: `apps/web` has 13 failing tests this session (see "Known test debt" below); the backoffice UI was **not live click-through QA'd** in this session, so a full UI-level pass is not claimed. |
| A14 | AI-first setup docs are followable by an AI tool with no human intervention beyond providing env values and the license key | `pass` | PR #13 `4394196`. `AGENTS.md` → `docs/AI_AGENTS.md` → `docs/setup/README.md` chain exists and is internally consistent — it is the same entrypoint this F7 task itself was executed against (`CLAUDE.md` points here). `scripts/setup.mjs`/`scripts/setup.test.mjs` automate install/env/prisma; `/backoffice` checklist is backed by tested `GET /onboarding/status`. |

**Summary: 4 pass · 5 partial · 5 not_run · 0 fail · 0 n/a** (of 14).

## Engineering quality gates (supporting evidence, not spec §15 items)

| ID | Gate | Status | Evidence |
|---|---|---|---|
| Q1 | Typecheck — `pnpm typecheck` (api, web, shared) | `pass` | Clean, 0 errors, all 3 packages (run 2026-08-24). |
| Q2 | `@wpptrack/api` unit tests | `pass` | 152/152 passing, 17 files (run 2026-08-24). |
| Q3 | `@wpptrack/web` unit tests | `fail` | 277/290 passing — **13 failing** across `settings-route.test.ts`, `integrations-route.test.ts`, `navigation.test.ts`, `operational-filter-layout.test.ts`, `provider-conversion-rule-actions.test.ts`. Pre-existing since the G4 import (`bd90155`), not introduced by F7. One failure directly corroborates a known gap — see "Residual risks" A1 below. |
| Q4 | `packages/shared` unit tests | `fail` | 113/133 passing — **20 failing** across `billing-package-contracts.test.ts`, `contracts.test.ts`, `inbound-webhooks.test.ts`, `navigation.test.ts`. Pre-existing since the G4 import; pattern suggests stale billing/subscription contracts out of scope for the student edition (PalmUP billing stays private). Not diagnosed further — out of scope for this docs task. |
| Q5 | Secret scan (`gitleaks`/`git-secrets`) | `not_run` | Neither tool installed in this environment. |

## Residual risks / deferred

1. **Client-owner activation-link stripped in G4, deferred to F6.1** (open). New evidence this session: `apps/web/tests/settings-route.test.ts` — "lets the platform owner manage the team and resend owner access in support mode" — fails because "Reenviar e-mail de acesso" is not rendered. This corroborates the gap is still unresolved as of 2026-08-24.
2. **Full multi-instance same-student live multi-deploy** not exercised (A6 `not_run`).
3. **Guru purchase → email/WA key delivery** had prod notify-skip issues earlier in the program; not re-verified with current evidence (A1 `partial`).
4. **WhatsApp disconnect-alert streaks are in-memory only** (`apps/api/src/ops-alerts/whatsapp-disconnect-alerts.service.ts`, `Map<providerId, StreakState>`) — reset on process restart and not shared across horizontally-scaled instances. Documented in-code (`apps/api/src/ops-alerts/README.md`). Acceptable for a v1 single-instance student deploy; flag for future work if students scale horizontally.
5. **Secret scan not run** — tooling not installed in this environment. Must run before tagging (see "How to re-run").
6. **`apps/web` (13) and `packages/shared` (20) unit test failures** pre-date this docs task (present since G4 import `bd90155`) and are unrelated to F7's scope. Should be triaged before or shortly after the `v1.0.0` tag; they do not block this docs-only PR.
7. **Umbler/Gupshup inbound parsers** have no dedicated unit tests in this checkout, unlike the newer WAHA/Z-API parsers (A11).

## How to re-run

```bash
# Setup (dry-run first)
pnpm setup -- --dry-run
pnpm setup

# Activate (requires LICENSE_KEY / LICENSE_ACCOUNT_IDENTITY in .env)
pnpm --filter @wpptrack/api dev
# then open /backoffice/license in the web app, or:
curl -s http://localhost:3333/license/status

# Typecheck
pnpm typecheck

# Unit tests (per package — `pnpm test` at the root currently fails fast on
# packages/shared, see Q4; run per-package to see all results)
pnpm --filter @wpptrack/api test
pnpm --filter @wpptrack/web test
pnpm --filter @wpptrack/shared test

# Secret scan (tool not installed here — install first)
# gitleaks: https://github.com/gitleaks/gitleaks#installing
gitleaks detect --source . --no-git -v
# or, alternative:
git secrets --scan
```

## Related documents

- [CHANGELOG.md](../../CHANGELOG.md)
- [PalmUP license ops runbook](../ops/palmup-license-runbook.md)
- [TAGGING.md](TAGGING.md)
