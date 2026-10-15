# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This is the **initial public release** of the `nod-rastrackdash-wpp` student template — there is no prior public version to diff against, so nothing below is "breaking" for existing consumers.

## [Unreleased]

### Changed

- **Leads novos × leads que voltaram** across Visão Geral, Leads and
  Relatórios: a "lead novo" is a lead whose first contact
  (`Lead.firstMessageAt`, else `createdAt`, America/Sao_Paulo) falls in the
  period, counted once and attributed to the campaign/ad set/ad of its first
  paid contact. CPL and the LeadSubmitted funnel stage use leads novos only.
  Leads that came back through an ad are reported apart (`returningLeads`,
  `repeatConversationLeads`, `adConversationEvents`, daily `returningLeads`;
  all optional in the shared schema) and never enter CPL. "Conversas reais"
  is now labelled "Leads novos"; the campaign CSV gains "Leads que voltaram".
  Leads drill-downs by campaign/ad set/ad follow the first-contact ad. No
  migration, no new env var.

### Added

- **"Leads no período" block on Visão Geral** (always visible): leads novos
  (with CPL), voltaram por anúncio, conversaram mais de uma vez and conversas
  por anúncio, each linking to the matching Leads list when it can be
  reproduced. The daily comparison adds a returns series.
- **Leads base filter** (Leads novos / Voltaram / 2+ conversas, `base`
  query param) and a paid/organic split count on the Leads page.
- **Export leads to CSV or Excel** (`GET /leads/export?format=csv|xlsx`, web
  proxy `/leads/export`, "Exportar" menu on Leads): every lead of the applied
  filters and period, with entry date/time in São Paulo time; names, phones,
  campaigns and ids are hidden when "Ocultar dados" is on; 50,000-row cap.
  Read-only, so the license soft-lock does not block it. New API dependency
  `exceljs` 4.4.0 — run `pnpm install` on local installs (Docker builds
  already install it).

### Fixed

- **URGENT — fewer Meta Graph API calls** (stops exhausting the shared
  PalmUP Meta app rate limit that blocked Meta social login): saved creative
  previews are always reused regardless of the fbcdn `oe` expiry hint (only
  never-seen creatives are fetched); creatives that came back absent/failed
  are not requested again for 24h (in-memory); `GET /{video}/thumbnails` is
  off unless `META_VIDEO_THUMBNAILS_ENABLED=true`; the first automatic Meta
  sync after boot now runs after a random 10-30 min (values below 600 s in
  `WPPTRACK_META_AUTO_SYNC_INITIAL_DELAY_SECONDS`, like the old `60`, are
  ignored). The 180-min interval is unchanged. API only, no migration.

### Added

- **Data Crazy inbound webhook** support for CTWA messages, including
  student setup guidance for connection, observation, certification and
  production activation.
- **Conectar Meta (PalmUP)** in Integrations → Tokens, BMs e destinos: the
  workspace owner logs in with Facebook through the PalmUP Meta app, without
  creating a Meta app of their own. The access token is redeemed and stored
  by the API only. Needs the new public env `PALMUP_META_BROKER_URL` on the
  API (example `https://wpptrack-api.rastrack.app`; it is a URL, not a
  secret). The permanent-token path, **Trocar token** and **Reenviar
  bloqueados** are unchanged.

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
