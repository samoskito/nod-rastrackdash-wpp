# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This is the **initial public release** of the `nod-rastrackdash-wpp` student template — there is no prior public version to diff against, so nothing below is "breaking" for existing consumers.

## [Unreleased]

### Changed

- **Integrations hub** (`/integrations`, web only): the page is now a catalog
  with four tabs — **WhatsApp** (Uazapi, WhatsApp Cloud API; WAHA, Z-API and
  NOD API show "Em breve"), **Atendimento e vendas** (Umbler Talk, Gupshup,
  Data Crazy), **Anúncios** (Meta Ads: social login or token, traffic data and
  CAPI conversions — it receives no conversations) and **CRM** (Kommo) — with
  logo cards (**Ativo** / **Disponível**) and one connection modal per
  platform. WAHA / Z-API / NOD API: no new connections, but an existing one stays
  active and manageable. The modals reuse the existing panels, scoped
  to the platform. New files: `apps/web/src/app/(app)/integrations/hub/*`,
  `apps/web/src/components/modal.tsx`, logos in `apps/web/public/integrations/`
  (see `SOURCES.md`; a missing logo falls back to the platform initials). Old
  `?aba=conversoes|vendas` links open Atendimento e vendas; `?aba=anuncios`
  opens Anúncios.
- **Kommo moved from Settings to Integrations → CRM.** Same manager and
  safeguards; Settings keeps a shortcut card and the rule builder's Kommo
  option now links to the hub card (`kommoManagerAnchorId` →
  `kommoManagerHref` in `ProviderConversionRulePanel`).
- **Removing a WhatsApp number** stays in the provider card (**Excluir**, type
  the connection name to confirm) — no billing or package flow.
- **Locked license (HTTP 423)** now shows "Licença bloqueada: alterações
  indisponíveis…" on WhatsApp-connection, inbound-webhook and Meta writes done
  from this screen, instead of a generic error. While the license is locked, the write controls of the WhatsApp and
  inbound-webhook modals are disabled with an explanatory note.
- No new environment variable, no migration, no new dependency (`pnpm-lock.yaml`
  unchanged). Web only: rebuild shared, rebuild and redeploy the web; the API is
  untouched.
- **If you customized** `integrations/page.tsx`, the Kommo block of
  `settings/page.tsx`, `settings/kommo-crm-manager.tsx`,
  `provider-conversion-rule-panel.tsx` or `layout-system.css`, expect merge
  conflicts: take the official file and re-apply your change in the matching
  block (each hub modal is an entry of `panels` in `integrations/page.tsx`).
  Branding (`BRAND_*`), the residual footer, the fixed sidebar and the license
  guard are not touched.
- **Verify:** open `/integrations` (four tabs, logo cards, your existing
  connections under **Ativos**); open a card and check its connections; as the
  owner open **CRM → Kommo**; as a member confirm there are no write buttons.
  **Roll back:** revert this change in the web and redeploy — no data changes.

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
- **Conversões — rule scope and "Unificar" (API + shared, Fase 3
  backend)**: provider conversion rules gain a scope, **Todos os números**
  (`all_numbers`, every compatible number of the workspace, including numbers
  connected later) or **Números específicos** (`specific_numbers`, the
  historical behaviour). A specific rule with the same origin and event
  replaces the global one on its number; a global rule runs once per phone
  when the same line is connected twice (Umbler + Uazapi). Capability matrix
  of this edition: team phrases on Umbler and Uazapi, contact phrases and
  structured catalog on Umbler, labels on Uazapi (matched by name across
  instances); WAHA, Z-API and NOD API are not part of provider rules yet
  ("Em breve"). New endpoints under `/conversion-rules`:
  `GET providers/capabilities`, `GET providers/unify-candidates`,
  `POST providers/unify`, `GET providers/create-receipt` (plus the
  `Idempotency-Key` header on `POST providers`) and `GET legacy` (old
  keyword/label rules, read-only). Kommo rules keep using the existing
  `GET /workspaces/:id/kommo/connections`. Every new write goes through the
  license soft-lock (HTTP 423). Old keyword/label rules can no longer be
  edited through `PATCH /conversion-rules/:id` once they have a provider
  configuration (409); edit those through `PATCH providers/:id`.
  **Migration** `20261015140000_provider_rule_workspace_scope` (additive; the
  Docker image runs `prisma migrate deploy` at API boot, local installs run it
  by hand; back up the database first): new table
  `ProviderRuleCreateClaim`, enum `ProviderConversionRuleScope`, columns
  `scope` (default `specific_numbers`) and `unifiedIntoProviderRuleId`,
  `connectionId`/`parserReleaseId` become nullable, with a data precheck
  before the new CHECKs. Existing rules keep working exactly as before until
  the student unifies them or creates a "Todos os números" rule. No new env
  var, no new dependency. The Conversões screen (web) is described in the
  next entry.
  **Roll back:** before downgrading, DELETE (pausing is not enough) every rule
  without a connection ("Todos os números" rules and specific rules spanning
  connections) and reactivate unified originals. Any such row, even paused,
  makes the previous version fail on `GET /conversion-rules/providers` (Prisma
  P2032). `SELECT count(*) FROM "ProviderConversionRuleConfig" WHERE
  "connectionId" IS NULL AND "removedAt" IS NULL` must return 0; execution
  history of the deleted rules may not open in the previous version. Optional
  rollback SQL in `docs/releases/unreleased.json`.
- Uazapi team messages now evaluate structured catalog rules (as the SaaS);
  existing catalog rules bound to a Uazapi connection, which never fired
  before, start firing after upgrade.

- **Conversões screen** (`/conversions`, web; Fase 3 UI): a new
  **Conversões** item in the sidebar (group Gestão, between Integrações and
  Configurações, for people who manage integrations) lists every rule in one
  place — phrase, WhatsApp label, catalog order, Umbler automation and, for
  the account owner, the Kommo stages (read-only, with **Gerenciar no Hub** →
  `/integrations?abrir=kommo`). Filters: origem, número, evento and status
  (envio automático, observação, pausadas, unificadas). **Nova regra** has four
  steps (Origem → Evento → Alcance → Detalhes), offers only what
  `GET /conversion-rules/providers/capabilities` says this edition supports
  and the student has connected, and lets the reach be **Todos os números**
  (new numbers join automatically) or **Números específicos**. WAHA, Z-API
  and NOD API numbers show as **Em breve**; Gupshup, Data Crazy and WhatsApp
  Cloud API numbers keep working (their conversions arrive through the
  provider webhook) and are only noted as not using phrase/label/catalog rules. "Substituída em X" notes explain
  where a specific rule replaces a global one. **Unificar** is offered, never
  forced, and the review explains it can be undone. **Gerenciar** edits a
  rule, shows the Umbler automation address (a new address is shown once) and
  setup, tests a catalog order and deletes; **Execuções** is the history of
  any rule, while **Eventos recebidos** (payload and Reprocessar) exists only
  for the Umbler automation. Old keyword/label rules appear as **Regras
  antigas** (pause, edit value, connect to numbers). New create is idempotent
  (`Idempotency-Key`); an unconfirmed create is checked with
  `GET providers/create-receipt` before anything is resent, and never after a
  license 423. With a locked license every write control is disabled and shows
  "Licença bloqueada: …". New files: `apps/web/src/app/(app)/conversions/*`,
  CSS block at the end of `layout-system.css`; no new dependency or env var.
- **Settings keeps only "Jornada"**: the "Jornada e gatilhos" section is now
  "Jornada" (funnel stages) and no longer loads or shows rule panels or the
  Kommo shortcut. Provider rules live in Conversões; Kommo rules are edited in
  Integrações → CRM → Kommo. `ProviderConversionRulePanel`
  (`integrations/provider-conversion-rule-panel.tsx`) and
  `integrations/provider-conversion-rule-actions.ts` were removed; the actions
  now live in `conversions/actions.ts` (with license 423 handling). **If you
  customized** `settings/page.tsx`, `integrations/page.tsx` (the "Regras de
  conversão" card links now open `/conversions`), `integrations/inbound-webhook-panel.tsx`
  ("Gerenciar gatilhos" is now "Abrir Conversões", linking to `/conversions`)
  or those two files, take the official
  `settings/page.tsx` and re-apply your change inside "Jornada" (or, for rule
  panels, in `conversions/new-rule-flow.tsx`, `rule-manage.tsx`,
  `message-phrase-fields.tsx`); accept the removal of the two deleted files.
  Branding, the residual footer, the fixed sidebar and the license banner are
  untouched. **Verify:** open Conversões (existing rules show as "Números
  específicos"), Configurações (only Jornada) and Integrações → CRM → Kommo;
  as a member the Conversões item is hidden. **Roll back:** revert the web
  change (including the `integrations/page.tsx` and `inbound-webhook-panel.tsx`
  links) and redeploy; no data changes.

### Fixed

- **Residual footer always visible**: on mobile (<=900px) and with the
  sidebar collapsed it now renders at the end of the main content instead of
  only inside the off-canvas drawer; the license lock/grace banner is offset
  past the fixed sidebar so it is fully readable. Web only, text unchanged.
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
