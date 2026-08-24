# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This is the **initial public release** of the `nod-rastrackdash-wpp` student template — there is no prior public version to diff against, so nothing below is "breaking" for existing consumers.

## [1.0.0] - 2026-08-24

Student edition of RastrackDash: a sanitized, self-hostable export of the PalmUP WppTrack product, covering license activation, multi-provider WhatsApp, a simplified student backoffice, whitelabel branding, and AI-first setup docs.

### Added

- **License client** (activate / heartbeat / status): [#1](https://github.com/samoskito/nod-rastrackdash-wpp/pull/1)
- **License soft-lock guard, status endpoint, and UI banner**: [#2](https://github.com/samoskito/nod-rastrackdash-wpp/pull/2)
- **WhatsApp provider registry** with `uazapi_byo` support: [#4](https://github.com/samoskito/nod-rastrackdash-wpp/pull/4)
- **`nod_api` WhatsApp adapter** via the PalmUP broker (licensed add-on): [#6](https://github.com/samoskito/nod-rastrackdash-wpp/pull/6)
- **WAHA WhatsApp provider adapter**: [#7](https://github.com/samoskito/nod-rastrackdash-wpp/pull/7)
- **Z-API WhatsApp provider adapter**: [#8](https://github.com/samoskito/nod-rastrackdash-wpp/pull/8)
- **Inbound webhook parsers** for WAHA and Z-API, alongside the existing Umbler/Gupshup parsers: [#9](https://github.com/samoskito/nod-rastrackdash-wpp/pull/9)
- **WhatsApp disconnect alerts** (optional webhook, in-memory streak tracking): [#10](https://github.com/samoskito/nod-rastrackdash-wpp/pull/10)
- **Env-driven whitelabel branding** (`BRAND_NAME`, `BRAND_LOGO_URL`, `BRAND_FAVICON_URL`, `BRAND_PRIMARY_COLOR`) with a fixed, non-removable residual footer: [#12](https://github.com/samoskito/nod-rastrackdash-wpp/pull/12)
- **`pnpm setup`** first-boot script, in-app onboarding checklist (`/backoffice`, `GET /onboarding/status`), and AI-first docs refresh (`AGENTS.md` → `docs/AI_AGENTS.md`): [#13](https://github.com/samoskito/nod-rastrackdash-wpp/pull/13)
- Sanitized initial import of the RastrackDash student template from the private WppTrack codebase (G4, `bd90155`).

### Changed

- WhatsApp health checks now route through the provider registry instead of talking to Uazapi directly: [#5](https://github.com/samoskito/nod-rastrackdash-wpp/pull/5)
- Student backoffice simplified (PalmUP billing removed) with a new read-only license tab: [#11](https://github.com/samoskito/nod-rastrackdash-wpp/pull/11)

### Fixed

- No additional public-template hotfixes beyond the security item below for this first cut; residual deferred product gaps are tracked in the acceptance matrix rather than listed as unfinished changelog bullets.

### Security

- License `cacheToken` signature is now verified over the canonical UTF-8 JSON bytes (matching how the server signs it), closing a verification gap found during activation smoke testing: [#3](https://github.com/samoskito/nod-rastrackdash-wpp/pull/3)

### Notes

- **Private dependency:** the `nod_api` WhatsApp provider depends on a private PalmUP broker (`dash-com-ia`, routes under `/nod-api/*`) that is not part of this repository. Students without a NOD API license should use `uazapi_byo`, `waha`, or `zapi` instead — see [`docs/ops/palmup-license-runbook.md`](docs/ops/palmup-license-runbook.md).
- **License server is external:** activation, heartbeat, grace/soft-lock, and revocation are enforced by PalmUP's private license server (`wpptrack-api.rastrack.app`). This repo ships only the client.
- **Known gap:** the client-owner activation-link flow that was stripped during the G4 sanitization pass has not been reintroduced (deferred out of F6.1); see [`docs/release/ACCEPTANCE-v1.md`](docs/release/ACCEPTANCE-v1.md) for the current status and evidence.
- **Not tagged yet.** This changelog documents the `1.0.0` release notes; the actual `v1.0.0` git tag and GitHub Release are cut separately by a human, after review — see [`docs/release/TAGGING.md`](docs/release/TAGGING.md).
- First public release of this template — "BREAKING" is not applicable; there is no prior public version.
