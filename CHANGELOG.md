# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Version 1.0.0 was the initial public release of the `nod-rastrackdash-wpp` student template.

## [Unreleased]

## [1.3.1] - 2026-10-28

Upgrade notes for students: [`docs/releases/1.3.1.json`](docs/releases/1.3.1.json). **First check Conversões: if it shows "Envio desligado no servidor", set `INBOUND_WEBHOOKS_ENABLED`, `INBOUND_CONVERSION_RULES_ENABLED` and `INBOUND_WEBHOOK_PRODUCTION_ENABLED` to `true` and leave `INBOUND_CONVERSION_PRODUCTION_ENABLED` empty (or `true`) on the API, then redeploy it.** **No new migration and no new variable.** The Meta instant forms (Lead Ads) and the Dashboard Leads import of 1.3.0 were removed (see Removed); their two tables stay in the database, unused. Kommo/Pipedrive events that arrive with `INBOUND_CONVERSION_PRODUCTION_ENABLED=false` now wait and are sent after it is turned back on.

### Added

- **Reenviar recusados (Eventos Meta)**: owners and admins resend, in bulk
  (screen filters, up to 500 per click) or per event (Inspecionar), the
  events Meta refused for a cause the student can fix (Graph code 100 with
  any subcode, 10, 200-299, or old refusals stored without a code), inside
  Meta's 7-day window. Same event_id; the destination is resolved again with
  the current configuration and written over the refused one: the claim
  clears the stored pixel and page and replaces `metaConversionDestinationId`
  (the Page/Pixel pair is the destination identity, so fixing it creates or
  picks another destination). Events with a stored destination keep account
  and connection and take the ad's current destination, then the account's,
  then the connection default (the send order without an explicit
  destination). `inbound_webhook:<provider>` events with an ad recompute the
  ad's current route as at creation: entries (`inboundEventId`) need exactly
  one active, valid route of the number matching it; number rules
  (`providerConversionExecutionId`) use the purchase choice (UAZAPI/WAHA
  bridges and Unnichat inheriting the workspace use the ad route, the others
  exactly one route of the number). CTWA page/pixel events get their
  `sourcePayload.ctwaDestination` re-resolved from the number's current
  route. When the current route is not ready, the event stays Falhou with the
  reason and the bulk result counts it apart (`notReady`, "fora por
  configuração"). Once-per-lead events (LeadSubmitted, QualifiedLead) are
  checked again against the new destination (another log of the same lead
  already there: not resent, counted as `alreadyConverted`; best effort,
  without the creation lock). The audit
  `beforeSummary` keeps pixel, page, account, connection, destination and the
  previous `sourcePayload`; a queue failure restores all of them.
  Conditional error -> ready_to_send claim (double click or concurrent send
  answers 409), never a sent event, one audit per event, 423 with a locked
  license. Out: 190/102 (Reenviar bloqueados), usage limits (requeued), 368,
  Kommo, Pipedrive and Meta Cloud (single-dispatch) and the CRM stage rows
  left by the removed Meta instant forms.

### Changed

- Kommo and Pipedrive: with `INBOUND_CONVERSION_PRODUCTION_ENABLED=false` an
  event with a production rule is no longer finished as blocked/ignored; it
  waits (no attempts consumed) and is re-evaluated every 15 minutes, sent once
  after the switch is back on; older than 7 days it ends as before. A waiting
  Pipedrive move is not superseded by a newer move received after it.
- Default single Meta CAPI POST: usage limits (4, 17, 32, 341, 613,
  80000-80014) become retryable with a "usage limit" message, as in the batch
  path. Guarded single-dispatch sends keep `MetaCapiRejected`. A BullMQ retry
  (`attemptsMade > 0`) now re-arms a default-path `error`/
  `MetaCapiNetworkError` log to `ready_to_send` (conditional update), so
  transient failures are really sent again (before, the retry was skipped).
  Kept on purpose: the re-arm applies to any `MetaCapiNetworkError` of the
  default path (network or usage limit), with the same event_id; only the
  single-dispatch triggers (Kommo, Pipedrive, Meta Cloud) stay out.
- Screen texts no longer show environment variable names (Conversões,
  Integrações, Pipedrive, Meta Cloud, currency hint); the backoffice license
  and onboarding pages keep them. Exception approved by Samuel: when a server
  switch is off, the screen shows the variable and the exact action
  ("No Dokploy, no serviço da API, troque
  INBOUND_CONVERSION_PRODUCTION_ENABLED=false por true (ou apague a linha),
  confira se INBOUND_CONVERSION_RULES_ENABLED=true e faça o deploy da API.")
  in Conversões ("Envio desligado no servidor", new rule without sending,
  error messages), Kommo, Pipedrive and the reprocess hint; the rules-off
  banner names `INBOUND_WEBHOOKS_ENABLED`/`INBOUND_CONVERSION_RULES_ENABLED`
  and the automatic-sending error names `INBOUND_WEBHOOK_PRODUCTION_ENABLED`.
- `.env.example`: `INBOUND_WEBHOOKS_ENABLED`, `INBOUND_CONVERSION_RULES_ENABLED`
  and `INBOUND_WEBHOOK_PRODUCTION_ENABLED` now come as `true` (required in the
  student's Dokploy/production, as `dokploy.md` and `environment.md` already
  said); `INBOUND_CONVERSION_PRODUCTION_ENABLED` stays empty and
  `INBOUND_WEBHOOK_REPLAY_ENABLED` stays `false`. A local `.env` copied from
  the example now asks for `INBOUND_WEBHOOK_ENCRYPTION_KEY` at API boot, like
  the other values to fill. Existing `.env` files are not touched.

### Removed

- **Meta instant forms (Lead Ads, nod PR #91) and the Dashboard Leads import
  (nod PR #92)**, absorbed in Fase 6.9 (#116) and adjusted in #117, #122 and
  this release: the `meta-lead-forms` API module and its `/integrations/meta-lead-forms`
  routes, the `leadgen` ingestion in `POST /webhooks/meta` (back to the
  diagnostic-only path it had before 6.9), the CRM stage sent with a
  QualifiedLead from the manual conversion and the CRM Kanban, the web panel,
  the shared schemas, `WPPTRACK_WEB_META_LEAD_FORMS_ENABLED`, the
  `dashboard-leads:import` command and its `SUPABASE_*` command-line
  variables, the guides `docs/setup/meta-lead-forms.md` and
  `docs/setup/dashboard-leads-import.md`, and the unpublished migration
  `20261028100000_meta_lead_form_token_updated_at` (with `graphTokenUpdatedAt`).
  The manual conversion, the CRM Kanban and "Reenviar bloqueados" work as
  before 6.9.
- Kept on purpose: the 1.3.0 migration `20261027145000_meta_lead_forms` and
  its tables `MetaLeadFormConnection`/`MetaLeadSubmission` (models kept in
  `schema.prisma`, unused, so there is no drift; deleting a workspace still
  cascades them). Rows already written stay readable: a `manual_conversion`
  with status `imported` still counts as converted for the once-per-lead guard
  and the CRM Kanban (an ordinary manual conversion), and a leftover
  `meta_lead_form_crm` event is closed as `skipped` instead of being sent
  through the messaging route.

### Fixed

- "Reenviar bloqueados e falhas de login da Meta" no longer picks Meta Cloud
  events (`inbound_webhook:meta_cloud`): their permanent
  `inbound-meta-dispatch:<id>` claim answered skipped and left the event
  "queued" forever. Leftover `meta_lead_form_crm` rows stay out of
  "Reenviar bloqueados" too.
- `scripts/rollback/antes-de-voltar-para-1.2.sql` also moves the roichat,
  braip and yampi values out of `InboundWebhookDelivery`,
  `InboundWebhookEvent`, `IntegrationEndpointEvent`,
  `InboundWebhookParserRelease`, `IntegrationEndpoint` and
  `InboundWebhookConnection` (backup table `rollback_1_2_provider`);
  `reativar-depois-de-atualizar.sql` restores them. With the 1.2.0 client,
  "Vendas sem atribuição" without `?provider` no longer answers 500.
- Fixture names and phones in the CRM board test follow the fictitious
  pattern (5511999990xxx).
- Docs: how to clear the checksum warning of the edited migration
  `20261027125000` on a homologation database (troubleshooting.md).

## [1.3.0] - 2026-10-27

Upgrade notes for students: [`docs/releases/1.3.0.json`](docs/releases/1.3.0.json). **Breaking: behavior changes on its own after the deploy (data-only promotion of observation to production, including Kommo and Pipedrive but not LeadSubmitted rules; rules following INBOUND_CONVERSION_RULES_ENABLED when INBOUND_CONVERSION_PRODUCTION_ENABLED is unset; Lead recebido moved to an active rule); read the guide before updating. Direct update from 1.0.0, 1.1.x and 1.2.0. Rollback needs the scripts in `scripts/rollback/` (see the notes), and includes the review fixes listed under Fixed.** **Two migrations (Fase 6.1a, additive; Fase 6.1c, data-only promotion): back up PostgreSQL before the redeploy.** One new optional API variable (Fase 6.1b): `META_CAPI_SEND_FIRST_NAME`, off by default. New default (Fase 6.1c): `INBOUND_CONVERSION_PRODUCTION_ENABLED` unset follows `INBOUND_CONVERSION_RULES_ENABLED`. New API variable (Fase 6.2a, no migration): `LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED`, **on by default** (unset = on; explicit `false`/`0`/`off`/`no` restores the entry send); students only act if they want it off. Fase 6.3a (reports, read-only): no migration, no new variable, nothing to do. Fase 6.2b (CRM Kanban): no migration and no new variable; the build installs new dependencies (`@dnd-kit/core`, `@dnd-kit/utilities`; `@electric-sql/pglite` only in API tests) pinned in `pnpm-lock.yaml`, so redeploy API, shared and web from the same commit. Fase 6.3b (filters of Visão Geral, Relatórios, Leads, Eventos Meta and Revisão de compras that apply by themselves; WhatsApp number and several-campaign filters; activity of each Uazapi/WAHA connection): no migration and no new variable (the existing optional WEB variable `WPPTRACK_WEB_PROVIDER_STATUS_TIMEOUT_MS`, default 2000 ms, now also limits each activity read); nothing to do beyond the redeploy of API, shared and web from the same commit. Fase 6.4 (Meta Graph robustness): **two more additive migrations, `20261027130000_meta_creative_thumbnail` then `20261027130100_meta_reporting_sync_block` (they run by themselves at API boot): back up PostgreSQL before the redeploy**; only optional API variables, all with safe defaults (`WPPTRACK_META_USAGE_PAUSE_PERCENT`, `WPPTRACK_META_SYNC_DEDUPE_WINDOW_MINUTES`, `WPPTRACK_META_SYNC_MAX_DEFERRALS`, `WPPTRACK_META_AUTO_SYNC_INCREMENTAL_DAYS` — on by default with 3 days, `0` turns it off —, `META_INSIGHTS_LEVEL_MODE` default `legacy`, `META_INSIGHTS_PAGE_LIMIT` default 500, `META_INSIGHTS_ASYNC_*` and `META_CAPI_BATCH_*` off by default, `WPPTRACK_CONVERSION_WORKER_CONCURRENCY` default 1); `META_VIDEO_THUMBNAILS_ENABLED` is unchanged; redeploy API, shared and web from the same commit. Fase 6.5 (Braip on the single URL): **two more migrations, `20261027140000_braip_provider` (enum values only) then `20261027140100_braip_parser_release` (inserts the Braip reader already certified: production direct); they run by themselves at API boot: back up PostgreSQL before the redeploy**; no new variable; redeploy API, shared and web from the same commit; nothing to release or certify (guide: [`docs/setup/braip.md`](docs/setup/braip.md)). Fase 6.9 (Meta instant forms / Lead Ads and the Dashboard Leads import; nod PRs #91 and #92 without #90): **one more additive migration, `20261027145000_meta_lead_forms` (two new tables; it runs by itself at API boot): back up PostgreSQL before the redeploy**; no new variable in `.env` (the forms use the existing `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_TOKEN_ENCRYPTION_KEY` and `API_PUBLIC_URL`; the optional import command reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only on its own command line, never in `.env`); nothing changes by itself after the deploy; redeploy API, shared and web from the same commit (guides `docs/setup/meta-lead-forms.md` and `docs/setup/dashboard-leads-import.md`, removed in 1.3.1). Fase 6.9b (a Meta form connection with submissions is deactivated instead of removed): no migration, no new variable; redeploy API and web from the same commit. Fase 6.8 (ROI Chat, WhatsApp API Oficial, one URL per number for the ad entry and the purchase): **two more migrations, `20261027170000_roichat_provider` (enum values only) then `20261027170100_roichat_parser_releases` (inserts the two ROI Chat readers already certified: production direct); they run by themselves at API boot: back up PostgreSQL before the redeploy**; no new variable; redeploy API, shared and web from the same commit; nothing to release or certify (guide: [`docs/setup/roichat.md`](docs/setup/roichat.md)). Fase 6.7 (Yampi on the single URL, open to every workspace): **two more migrations, `20261027160000_yampi_provider` (enum values only) then `20261027160100_yampi_parser_release` (inserts the Yampi reader already certified: validated in the SaaS with real Yampi payloads; production direct); they run by themselves at API boot: back up PostgreSQL before the redeploy**; no new variable; redeploy API, shared and web from the same commit; nothing to release or certify; register the single URL in a Yampi store webhook (guide: [`docs/setup/yampi.md`](docs/setup/yampi.md)). Review of PR #121 (fixes before publishing): no new migration and no new variable; the unpublished `20261027125000` was corrected (a paused number is never re-enabled through a sibling identity; a "Lead recebido" rule in observation is **not** promoted, the student turns it on with "Ligar esta regra"; Kommo and Pipedrive promotions write `production_direct_6_1c:kommo|pipedrive:<id>` audits and Pipedrive only with the creation checks); `INBOUND_CONVERSION_PRODUCTION_ENABLED=false` now also stops Kommo and Pipedrive and the Conversions screen says the sending is off; the optional `OPS_ALERT_UAZAPI_BASE_URL`, `OPS_ALERT_UAZAPI_TOKEN` (secret) and `OPS_ALERT_SCAN_INTERVAL_MS` (Fase 6.1c) are documented; going back to 1.2.0 needs `scripts/rollback/antes-de-voltar-para-1.2.sql` **before** reverting the code if ROI Chat, Braip or Yampi were used, and `scripts/rollback/desfazer-producao-direta-6-1c.sql` undoes the promotion by its audits (see the rollback of `docs/releases/unreleased.json`). Direct upgrade from 1.0.0, 1.1.x and 1.2.0.

### Added

- **Fase 6.7 — Yampi on the single URL, with the real order lines in the
  Meta Purchase (API, shared and web; two migrations; no new variable)**.
  Ported from the SaaS (`1889af48` #186, `087df11b` #187, `bce48c6c` #188).
  Reader `yampi/automation-v1`: `order.paid` and `order.status.updated`
  (paid) are the SAME Purchase (order id + event), `order.created` waiting
  for payment (boleto/Pix) is InitiateCheckout, `cart.reminder` is
  CartAbandoned (keyed by the cart); cancel, refund, refused and other
  statuses are received and ignored. Value = `value_products` only (no
  shipping, no installment interest; cart: subtotal), always BRL; phone from
  `area_code` + `number` or `full_number` with or without 55; dates in
  Brasília time capped at the arrival; main product = highest price x
  quantity (#187). The Purchase and InitiateCheckout carry the real order
  lines to Meta (`contents` with the order bump, `num_items`,
  `content_name`, `order_id` = Yampi order id; event_id and dedupe
  unchanged; a coupon mismatch keeps value and lines and logs
  `sale_capi_items_value_mismatch` without personal data) (#188).
  "Ver dados recebidos" also hides `x-yampi-hmac-sha256`, the whole
  `login_url` and the login tokens inside the order links. The reader enters
  **certified** by migration (validated in the SaaS with real Yampi
  payloads received and read correctly), so the Yampi URL and rules are born
  in production. Adapted to the student edition: **open to every workspace**
  (no `private-sales-platform-gate`, no `yampi-feature-gate`, no
  `yampiEnabled` flag, no Backoffice private-integration key), no billing
  hunk, the per-rule URL of a Yampi rule is always born disabled (single URL
  only, also in the API), a blocked license answers 423 at the global guard.
  Yampi card always in the hub (Atendimento e vendas, neutral wordmark
  logo), "Venda na Yampi" rules in Conversões, Yampi unattributed sales,
  Yampi in the manual purchase dedupe (order = Yampi order id), Yampi
  filter in Backoffice receipts and readers.
- **Fase 6.8 — ROI Chat (WhatsApp API Oficial): CTWA entry and purchase by
  rule (API, shared and web; two migrations; no new variable)**. Ported from
  the SaaS (`f4f74673` #183, `37bee70d` #185; no later ROI Chat fix up to
  `origin/main`). One connection = one client number = one URL; the same URL
  receives the lead entry (no `event_name`: reader `roichat/v1`, generic
  CTWA production with the Meta route learned from the ad, lead created,
  once-per-lead-and-pixel guard of #153, also against a WAHA number of the
  same lead) and the purchase (`event_name: "Purchase"`: routed to the rule
  "Compra no ROI Chat" that owns the URL's number, reader
  `roichat/automation-v1`, value and currency from `valor_venda`/`moeda`,
  rule value only a fallback). Repurchase allowed; the same purchase (lead,
  number, value and currency) within 12h is a duplicate (ingestion guard +
  12h rolling production policy). The reader reads the ad fields inside the
  nested `anuncio` object (real format, #185) with the top level as
  fallback. Both readers enter **certified** by migration (decision of
  27/10/2026: validated with real payloads received in the SaaS), so the
  connection, the number and the rule are born sending. Adapted: no
  `roichat-feature-gate`/private integrations, no billing or seat hunks, no
  `WhatsappSeatProvider` value; the card is always in the hub next to WAHA
  and Meta Cloud; a blocked license answers 423 on every ROI Chat write.
  Real sanitized fixture of #185 included.
- **Fase 6.9 — Meta instant forms (Lead Ads) with the CRM stage, and the
  Dashboard Leads import (API, shared and web; one migration; no new
  variable)**. Absorbs the nod PRs #91 (`a2782948`) and #92 (`98fb1664`,
  `d2f9db63`) without #90 (closed; replaced by #158 and #176). A Page
  connection (Graph token and optional dataset token, encrypted) in
  Integrations → Meta → "Formulários Meta", "Assinar Página" and the
  `leadgen` field of `POST /webhooks/meta` (after the signature check) turn
  each instant-form submission into a lead (one person per phone, 9th-digit
  variants, WhatsApp attribution kept) and a `MetaLeadSubmission`. A
  QualifiedLead registered by the manual conversion (#158) or the CRM
  Kanban (#176) also records the CRM stage (`meta_lead_form_crm`, Conversions
  API for CRM, `event_id` `{lead_id}:{event}`) on the connection dataset,
  outside the once-per-lead-per-pixel guard of #153 (another dataset), once
  per submission; configuration blocks and Meta login failures (190/102)
  enter "Reenviar bloqueados" (#181). `dashboard-leads:import` (dry-run by
  default, idempotent, refuses `--apply` with a blocked license) imports
  what Dashboard Leads already sent with the nod keys (#158/#153
  `manual_conversion` once-per-lead `event_id`, or the 6.9 CRM key), so
  neither an automation nor a new manual registration resends it; the #153
  guard and the CRM Kanban count an imported manual conversion. Connections
  are born active (production direct); writes answer 423 with a blocked
  license; `delete-workspace.js` removes the new tables before `Lead`.
  Migration renamed from `20261017100000_meta_lead_forms` to
  `20261027145000_meta_lead_forms` (additive, idempotent).

- **Fase 6.9b — a Meta form connection that already received submissions
  is deactivated, never removed (API and web; no migration; no new
  variable)**. Decision of 2026-10-27: `DELETE /integrations/meta-lead-forms/:id`
  answers 409 ("Esta Página já recebeu formulários. Desative a conexão...")
  when the connection has any `MetaLeadSubmission` (check and delete in one
  statement, so the submissions are never cascaded away); a connection
  without submissions is still removed. New `POST /:id/deactivate` and
  `POST /:id/reactivate` (writes: 423 with a blocked license; the existing
  `active` column, the `PATCH` `active` field keeps working). The `leadgen` of
  a deactivated Page is answered 2xx and ignored (not read, saved or logged),
  so Meta does not redeliver. In the panel, "Pausar/Retomar" became
  "Desativar/Reativar" and "Remover" only shows without submissions, with
  the short reason otherwise. One Page in one workspace is unchanged (a
  deactivated Page stays reserved); `delete-workspace.js` still deletes the
  submissions when the whole workspace is deleted.

- **Fase 6.5 — Sales platforms on the single URL: Braip, received data and
  receipts audit (API, shared and web; two migrations; no new variable)**.
  Ported from the SaaS (`09d7303a`, `f83522af`, `072bb61a`, `25a7cd76`,
  `b3124d65`, `8af225f4` #168, `ec996549` #164, `92edd263` #169 read part,
  `60588489` #170, `4ba8961d` #184, `be599f49` #158 purchase hunk for Braip,
  `7570fe14` Kommo part; `b4d71afc` and `1af5411c` #166 only as a read-only
  diagnostic). A shared sales-platform base (`sales-platform-sale.ts`:
  Payt + Braip, same purchase identity, product filter, routing, resend
  reconciliation, production gates and claims); the Braip reader
  (`braip/automation-v1`: JSON or form body normalized to canonical JSON,
  the account key dropped at any depth, order bump routed by the main item,
  dates read in Brasília time by the fase 6.0 reader and capped at the
  arrival) enters **certified** by migration, validated in the SaaS with a
  real sale (confirmed by Samuel on 2026-10-27; the reader was also checked
  against the official Braip postback in #168), so the Braip URL and rules are born in
  production and the student never releases anything. Braip card always in
  the hub (Atendimento e vendas), "Venda na Braip" rules in Conversões
  (event from each status, optional product filter, single URL only),
  Braip unattributed sales, Braip in the manual purchase dedupe (order =
  `trans_key`). "Ver dados recebidos" of a stored sale (masked: account
  keys, credentials and tokens inside URLs; audited) for integration
  managers. Backoffice → Webhooks WhatsApp → **Recebimentos das URLs únicas**
  (every receipt of every workspace, filters, cursor, masked payload; refused
  calls of a known URL kept as `rejected`, metadata only without a valid
  token and for any refused Braip body, same 60-day retention) and **Leitores de webhook** (read only).
  The URL box counters stay real after "Mostrar URL"/"Gerar URL"/"Gerar
  nova" (#164); a failed `/channels` read never hides the sales platforms in
  "Nova regra" (#164); "Tentar de novo" only for unattributed/pending
  receipts. Kommo actions also refresh `/integrations`. The SaaS
  certification actions ("Liberar plataforma", certify-parser routes) and
  the private-integration/billing gates are not part of the student edition.
- **Fase 6.4 — Robustness of the Meta Graph calls (API, shared and web;
  two additive migrations; optional variables only)**. Ported from the
  SaaS (`918a0837`, `0403cbce`, `f1ec6a9e`, `6a3f2c79`, `c0cec66c`,
  `c685ef66`, `0f16c25c`, `213047d3`, `70625e41`, `bc72b208`; release notes
  `33adb781`). Typed Graph errors and a **reporting-only circuit breaker**
  (`MetaReportingAccount.reportingSyncBlockedAt`): a dead token (190/102)
  or a lost ad account permission (10/200) pauses only the report sync of
  the failing account (every account of the token once a cached `GET /me`
  confirms 190/102), never CAPI/CTWA routing; reconnect, revalidate, rotate or "Testar" lifts it.
  Relatórios shows "Reconecte a conta Meta" and the Meta coverage warning
  of Visão Geral/Relatórios now lists blocked accounts (the "bloqueada"
  reason waiting since Fase 6.3a). Usage-aware yield (`X-App-Usage`,
  `X-Business-Use-Case-Usage`, `X-FB-Ads-Insights-Throttle`,
  `X-Ad-Account-Usage`) moves report jobs to delayed instead of retrying;
  sync jobs are deduplicated per account/period/window; the auto-sync
  takes a Redis marker per interval and pages through every workspace.
  **Persisted creative thumbnails** (`MetaCreativeThumbnail`, 320 px, at
  most 100 KB, fetched once per creative with bounded refresh and a
  15-minute pause after a Meta rate limit) served by
  `GET /reports/creative-thumbnails/ads/:adId` (workspace-scoped, read
  only) and used by the lead page, the ad rows of Relatórios and the CRM
  Kanban cards (the stored thumbnail waiting since Fase 6.2b); expired
  signed Meta CDN URLs are no longer rendered. Optional ad-level Insights
  with local aggregation (`META_INSIGHTS_LEVEL_MODE`), 500-row pages,
  optional async reports, an incremental auto-sync window verified
  against Meta's totals (spend and conversations) and optional CAPI
  micro-batching (`META_CAPI_BATCH_ENABLED`, plain dispatches only; a
  batch-wide 190/102 or throttle is not resent one by one). nod adaptations: the URGENT
  mitigation stays (saved previews reused, `/{video}/thumbnails` only with
  `META_VIDEO_THUMBNAILS_ENABLED=true`, first auto-sync after a random
  10-30 min instead of the SaaS boot jitter); app-level usage is tracked
  per Meta app (PalmUP social login vs the student's own app), so one hot
  app does not pause the other; CAPI batches keep the strict nod
  acknowledgement and never store the provider body;
  `apps/api/scripts/delete-workspace.js` deletes the new table before
  `Workspace` (`delete-workspace-order` test).

- **Fase 6.3b — Filters of Visão Geral and Relatórios, applied automatically
  (API, shared and web; no migration, no new variable)**. Ported from the
  SaaS (`d2a5f76e` #62, `fae01607` #106, `9fccf687` #110, `588cec7c` #114,
  `54cc7739` #115, `aa04fed9` #116, `c1204447` #117, `bcc9adda` #118,
  `d389892f` #119, `98bf9fc5` #121, `4f42dd03` #122, `8b99506f` #123,
  `9db08583` #124, `75125d69` #125 and `256ff325` #126 adapted, `bb76b30e`,
  `e5ef9006`, `d8cefd91` #175), plus the later SaaS pieces of the same files
  (`2f79c3c7` searchable ad account filter with the currency badge,
  `996e7c12` several ad accounts on the campaign options, `be599f49` "Manual"
  source on Eventos Meta, `82448211` WhatsApp number on the Leads export
  route, the number filter on the deferred-lead lookup of `4d74d303`).
  - Relatórios toolbar grouped in Período / Escopo / Ações (#62); every filter
    of Relatórios, Leads, Eventos Meta and Revisão de compras applies by
    itself, without the "Aplicar" button (#121–#124; dates and texts wait for
    the typing to stop; Enter and no-JS GET keep working).
  - Visão Geral: WhatsApp number filter (#106/#110; removed connections leave
    the list but an old link still works), searchable campaign filter with
    up to 10 campaigns (#114–#118; `GET /reports/campaign-options`,
    `campaignIds`), honest Meta metrics for the cut (account, shared or
    exclusive campaign, not synced) and the scope notes. Relatórios: the same
    number filter (#119).
  - #175: with the number filter, conversations include the entries deferred
    to the Lead-recebido rule (`metricEventLeadIds`); nod: the variable unset
    is the override mode, so the "normal mode" tests use an explicit "false".
  - #125/#126 adapted: `GET /integrations/whatsapp-connections/:id/activity`
    in the nod connections module (Uazapi BYO and WAHA, one number per
    connection; no `schemas/billing`: `whatsappInstanceActivitySchema` lives in
    the integrations schema), shown on each connection card and on the
    Uazapi/WAHA bridges of the phrase rules (their entry counters show "Não
    medido"); Leads filter by number (`whatsappInstanceId`, list and export).
  - One platform look for every `<select>` in the app (bb76b30e,
    `docs/design/dropdowns.md`); stacked per-currency totals and an uncut ad
    account popover in Relatórios, currency in the rule example message
    (e5ef9006). The CRM board campaign filter (6.2b) uses the same searchable
    FilterCombobox.
  - nod adaptations: the number options come from
    `/integrations/whatsapp-connections` (`lib/whatsapp-number-options.ts`);
    the ad account filter is the SaaS FilterCombobox version; UI texts in
    Portuguese with accents. Skipped: #143 (API sort by any funnel step; the
    web never sends that key, in the SaaS either).
  - nod fixes found in the review (not in the SaaS yet): with several
    campaigns the Overview summary is scoped to them (`summaryMetricScope`
    reads `campaignIds`, so leads/sales follow the same campaigns as the
    spend); the Relatórios CSV follows the WhatsApp number
    (`campaigns/export.csv` and the web export route take
    `whatsappInstanceId`); a drill-down campaign outside the current BM/accounts
    (404 from the campaign check) renders an empty table instead of "API
    indisponível". Ported with the number filter: the returning-lead lookup
    and the Overview → Leads shortcuts carry the number and the campaign.
  - Reads only (plus the existing writes): with a locked license the filters,
    the activity and the export keep working; writes still answer 423.

- **Fase 6.3a — Reports: correct numbers (API, shared and web; no
  migration, no new variable)**. Ported from the SaaS (`c95961f0` #61,
  `45f18c2b` #69, `58d5e51b` #83 partial, `e4139c4c`, `d4420843` #157,
  `ea8203a7` #167, `f4aa9878` #174).
  - Canonical funnel order (#61): QualifiedLead (40) before InitiateCheckout
    (45) in the catalog (`conversionEventCatalogOrder`); a stage not yet
    saved enters right after the last saved stage that precedes it in the
    catalog instead of the end of the funnel; Overview/Reports merge funnel
    steps keeping that order. Eventos Meta lists every event configured in
    the workspace in its filter (`availableEvents`).
  - Overview KPI cards by funnel (#69): one card per visible Jornada stage,
    with its label and cost ("Custo por …" follows a renamed stage);
    "Compras" and "Receita tráfego" only with a Purchase stage.
  - Meta coverage notice (#174): `metaSyncCoverage` on campaign, ad set and
    ad reports (`reporting/meta-sync-coverage.ts`); "Atenção aos dados da
    Meta" on Visão Geral and Relatórios when the period starts before the
    first synced day or an active account is stale (> 24 h), in error or
    never synced. nod: the "blocked" reason needs the
    `reportingSyncBlockedAt` column of Fase 6.4; until then no account is
    reported as blocked. The fail-safe warning logs only the error name.
  - Daily reconciliation "Meta x conversas reais" (#167): every paid
    conversation started per day (`adConversationsStarted`, same rule as
    "Conversas por anúncio"; deferred entries included) next to Meta; a
    third "Leads (evento Lead enviado)" series only in the Lead-recebido
    rule override mode of the period (`dailyComparisonLeadEventDeferred`).
    nod: `LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED` unset = on, so the Lead
    series appears whenever the period is in the rule override mode (an active,
    sending Lead recebido rule).
  - "valor corrigido (antes R$ X)" in the Eventos Meta detail
    (`e4139c4c`), only for platform support access (backoffice).
  - Not ported here: #175 (number-filter conversations with deferred
    entries) only applies to the WhatsApp number filter of the reports,
    which the nod gets in Fase 6.3b (#106); it moves there.

- **Fase 6.2b — CRM Kanban of the Jornada (API, shared and web; no
  migration)**. Ported from the SaaS (`f5c2b47b` #176). No later CRM fix in
  the SaaS up to `origin/main` (#189) needed porting (the later edits of
  `manual-conversion.service.ts` are Hotmart/Yampi/ROI Chat, Fases 6.6–6.8).
  - New "CRM" item in the menu (Operação, right after Leads; every member
    sees it): columns are the visible stages of the Jornada ("Leads novos"
    first; "Conversas iniciadas" first, read-only, when "Lead recebido pela
    regra" is in use), real totals per column, 20 cards per column with
    "Carregar mais", the stage of each lead computed in one aggregated SQL
    query (`apps/api/src/crm/crm-board-query.ts`, existing indexes, no
    migration) and a 15 s server cache; `GET /crm/board` and
    `GET /crm/board/columns/:stageKey`.
  - Dragging a card forward (owners/admins; pointer and keyboard; "Mover
    para…" on phones) opens the same manual conversion confirmation with the
    column event locked and the Jornada default value; it is a manual
    conversion with `source: "kanban"` ("Manual (Kanban) por <nome>" in the
    audit). The API refuses moving back or to the same stage (409
    `crm_backward_move`/`crm_same_stage`).
  - Lead detail extracted to `lead-detail-view.tsx` and reused in the board
    modal; filters in the URL (arrival period, default 30 days, up to 180;
    number; campaign); light refresh every 60 s.
  - nod adaptations: with the license locked the board stays readable (GET)
    but moving a card is a write (423), so cards are not draggable and a
    notice says why; numbers come from the active WhatsApp connections (no
    paid seat); campaigns from the synced Meta structure (native select; the
    searchable, period-scoped campaign filter arrives with Fase 6.3b); card
    thumbnails use the CTWA/ad URL (stored creative thumbnails are Fase 6.4).
  - nod fixes on top of the SaaS port: `/crm` is in the session middleware
    (redirects to the login like the other app routes); the board height
    leaves room for the residual footer on phones ("RastrackDash · powered by
    PalmUP" stays in view); dropping a card with Enter in the keyboard drag no
    longer also opens the lead modal; a retried kanban move with the same
    idempotency key replays the registered conversion instead of answering
    409 "O lead já está nesta etapa"; an empty campaign/ad name never breaks
    the board.
  - New dependencies: `@dnd-kit/core` 6.3.1 and `@dnd-kit/utilities` 3.2.2
    (web), `@electric-sql/pglite` 0.2.17 (API dev/tests only: runs the board
    SQL in-process in the tests).

- **Fase 6.2a — "Lead recebido" sent by the rule and manual conversion on the
  lead (API, shared and web; no migration)**. Ported from the SaaS (`4d74d303`
  #155, `2e328e97` #156, `be599f49` #158 and the #159 hunk of
  `lead-submitted-rule-override.ts` from `42ccbc7c`).
  - "Lead recebido pela regra" (#155): an active, sending provider rule with
    the LeadSubmitted event (phrase, catalog or automation) that covers the
    entry number makes the CTWA entry write a non-sending receipt
    (`not_eligible`, `lead_submitted_deferred_to_rule`, proof of origin and
    conversation in the reports) and the rule sends the LeadSubmitted when it
    fires, once per lead and pixel (lifetime guard, now also covering the
    Uazapi BYO/WAHA `auto_lead` entry). Fail-closed towards the entry send.
    nod: `LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED` is **on by default**
    (production direct; validated in SaaS production) with one parser
    (`config/lead-submitted-rule-override-flag.ts`) shared by every mirror
    (rules, lead cohort, reporting, lifetime guard, capabilities); the SaaS
    seat gate becomes the usable license plus, for bridged numbers, the
    WhatsApp connection `active`; the deferral is also asked on the WAHA
    bridge entry, on the Meta Cloud (and other non-Unnichat) production path
    and on the student replay. Reports count the entry receipt as the
    conversation and make a deferred lead "novo" on the day the rule sends.
    Screens: "Substitui envio na entrada" badge, notice on the rule form,
    "Adiado para a regra" on the deferred entry in Eventos Meta (the
    Executions/Received events chip is kept for parity with the SaaS), "N
    leads aguardando a regra" (a manual Lead recebido also stops the wait)
    and the Overview texts, shown when the API reports the flag on
    (`GET /conversion-rules/providers/capabilities`). Rules with LeadSubmitted
    exist only on Uazapi BYO, WAHA, Umbler and Unnichat numbers; Meta Cloud,
    Gupshup and Data Crazy entries keep sending (the hook on their production
    path is fail-safe). The leads list only runs the report-mode lookup with a
    period or a campaign/ad set/ad filter.
  - Rules list without overlap on medium windows (#156, CSS).
  - Manual conversion on the lead (#158): owners/admins register any catalog
    event from the lead detail (`POST /leads/:leadId/manual-conversions`,
    `/preview`, `/:logId/cancel`); destination resolved like the automations
    (lead's ad route for Uazapi, WAHA, Meta Cloud and webhook leads; CTWA
    page/pixel proof for Unnichat); once-per-lead events reuse the rule
    `event_id` (a QualifiedLead phrase rule plus a manual QualifiedLead is one
    Meta event); Purchase with order number deduped against Payt (extension
    point `leads/manual-conversion-sales-platforms.ts` for Braip, Hotmart and
    Yampi in 6.5–6.7); ±24h confirmation; cancel before sending; stuck
    dispatch recovery; rate limit 30/hour per user. nod: the SaaS "sem vaga" /
    "número desconhecido" reasons become `connection_inactive` (bridged
    number whose WhatsApp connection is not active); the license is enforced
    by the global guard (423) on every manual-conversion write and the button
    is disabled while the license is blocked. Replaces nod PR #90 (manual
    QualifiedLead with another `event_id`), which is not published.

- **Docs for the student AI**: `docs/AI_AGENTS.md` (and `AGENTS.md`) now tell the student Claude/Codex how to handle "update" or "change a variable/flow" requests (follow `docs/setup/update.md`, read the upgrade notes, explain every new or changed variable from `environment.md`). Maintainers must document every change that needs student action in the same commit.

- **Fase 6.1c — Production direct (nod product rule; API, shared and web)**:
  what was validated in the SaaS reaches the student in production; the
  student never re-tests, certifies or releases anything.
  - New `inbound-webhooks/production-direct.ts`: with a production-eligible
    parser release (`inboundParserProductionEligible`), an inbound connection
    is born `production` (with `productionActivatedAt`) and each number is
    born `active`: Umbler, Gupshup, Data Crazy, Unnichat (its bound number),
    Meta Cloud (only with `META_APP_SECRET`: in production the API requires the
    Meta signature and would reject the deliveries), the Uazapi BYO/WAHA bridge
    (server URL + token, one number per connection), a manually provisioned
    number and a number discovered by its first delivery (active since that
    delivery's `firstReceivedAt`, so its first CTWA is sent). A paused
    connection stays paused (its new number is active, stamped on resume).
    An unvalidated or retired release keeps the observation step.
  - Conversion rules (phrase, catalog, label, Umbler/Unnichat automation,
    Payt, adapted legacy rules) are born `production` when the create omits
    `mode` (shared `providerConversionRuleCreateInputSchema.mode` is now
    optional; the web no longer sends it): no "Ativar envio" click. An
    explicitly requested mode still applies; with the server switch off or
    an unvalidated reader the rule is born `observation`. A defaulted
    production create does not run the strict number cascade (numbers are
    already born live; operator pauses are never undone implicitly).
    "Retomar" a paused rule resumes it sending; resuming a paused connection
    or number (`productionDirectResume`) no longer demands a Meta route on
    every number (numbers are born active; the route is enforced at send
    time), while the validated reader, `META_APP_SECRET` and replay-in-flight
    checks still apply. Kommo rules default to
    `production` (shared schema); Pipedrive rules default to `production`
    when the connection has what sending needs, otherwise `observation`
    (no creation failure).
  - `INBOUND_CONVERSION_PRODUCTION_ENABLED` unset now follows
    `INBOUND_CONVERSION_RULES_ENABLED`; an explicit `false` remains the server
    switch, and the screens say exactly which variable to set.
  - Data-only migration `20261027125000_production_direct_validated_integrations`
    (slot reserved for 6.1c): certifies the Meta Cloud v1 row (already
    eligible in code), promotes observation connections with a certified
    reader of their own provider (Meta Cloud excluded: its promotion depends
    on `META_APP_SECRET`), activates never-activated numbers of production
    connections (Uazapi/WAHA only with an active WhatsApp connection; no
    rediscovered duplicate of an active number; between two discovered
    identities of a number only the last seen), stamps active numbers
    without activation date, and promotes active observation rules (provider
    rules with a certified or no own release whose bound connection is
    production or paused; Kommo only when its connection has no event still
    queued, since Kommo has no activation fence; Pipedrive with its
    activation fence). Kept as is: paused, unified or removed rules; rules
    that had been in production and were taken off (audit
    `resultStatus = production`); connections an operator put back in
    observation (and rules bound to them); connections with a replay in
    flight. Activation dates are
    the migration's (nothing is sent retroactively). Idempotent, with
    deterministic system audit ids (`production_direct_6_1c:*`).
  - Screens: no observation, test, release or certification steps for the
    student. Rule status "Observação" became "Envio desligado"; no "Voltar
    para observação"/"Observar" (Pausar is the off switch); Kommo/Pipedrive
    forms no longer offer "Observar primeiro"; Integrations connection labels,
    notes and messages, received-events reasons ("Por que não foi enviado"),
    and student docs (guide, Payt, Unnichat, Pipedrive, Data Crazy, Meta
    Cloud, troubleshooting, environment) were updated.
- **Fase 6.1c — WhatsApp disconnect alert per connection (API, shared and
  web)**, ported from the SaaS (`6be4bdcd`/`86aaac21`, #63), adapted: the
  check never ran in this edition (it only recorded "unavailable"). Each scan
  reads every active Uazapi BYO and WAHA connection through the provider's
  status API (`WhatsappConnectionsService.readConnectionStatusForAlert`,
  read-only). It alerts only after 2 consecutive definitive "disconnected"
  readings (Uazapi `disconnected/closed/logged_out`; WAHA `STOPPED` or a
  session waiting to be paired again); ambiguous states neither count nor
  reset; a connected reading resets; a read error never alerts (Uazapi now
  exposes `providerStatusText`, as in the SaaS). The streak lives in
  `WorkspaceOpsAlertDelivery` rows. The confirmed alert shows in
  Integrations (`disconnectAlert` on the WhatsApp connections list, optional
  in the shared schema); the WhatsApp message goes out only with the
  workspace alerts on, a phone and a usable license.
- **Fase 6.1c — "Reenviar os que falharam" in the student recovery (API,
  shared and web)**, ported from the SaaS (`f7c61c07`, #91), adapted to the
  owner-scoped Meta Cloud recovery: `POST …/recovery/batches/:batchId/retry`
  re-queues the failed items of a batch while the original payload is still
  retained, re-checking each one like a new authorization (active channel,
  one active valid route, identity, 7-day window) and never re-sending a
  CTWA that already has a conversion event. The batch authorization is
  renewed with the current context (latest authorize audit wins). 423 with
  a locked license (global guard and service). `retryableFailedCount` and the
  new `retryableFailed` of the result count failed items with a retained
  payload, whatever their error code (as in #91).

- **Fase 6.1b — Why an event stayed in observation (API, shared and web)**,
  ported from the SaaS (`d4c6a419`, #171), adapted to the student edition:
  - The observed disposition records its reason with the execution
    (`normalizedResult.observationDetail`): rule in observation at receipt,
    production sending disabled, lead number on the legacy engine, rule
    without activation, received before the rule's or the number's
    activation, lead number not in production on its own connection.
    "Eventos recebidos" shows it with what "Reprocessar" will do; reason-code
    labels no longer all read "Reconhecido em observação". Older rows fall
    back to the reason codes that say it unambiguously.
  - Payt "Todos os números": with the anchor connection live, the lead
    number's own connection (Uazapi/WAHA bridge, Meta Cloud, Umbler...) is the
    remaining gate. The pending-numbers list shows it and "Ativar envio neste
    número" promotes that connection. Student-edition adaptation: the
    Uazapi/WAHA bridge (one connection per number) follows the save cascade
    and the automatic activation like phrase rules; connections that may carry
    several numbers wait for the explicit click.
  - Adaptations: the only sales platform is Payt (no Braip/Brink Park yet);
    no `ctwa_requires_canonical_engine` branch; messages never send the
    student to "support".
- **Fase 6.1b — First name (`fn`) in the Conversions API, off by default
  (API)**, ported from the SaaS (`a7ccdab3`, #179, CAPI part; `c44dc9fb`,
  #180): `user_data.fn` = SHA-256 of the normalized first name (lowercase,
  no punctuation, UTF-8 accents kept); never empty, generic, emoji-only,
  phone-like or single-initial names. New optional API variable
  `META_CAPI_SEND_FIRST_NAME` (only `true`/`1`/`on`/`yes` enable it;
  documented in `.env.example` and `docs/setup/environment.md`). With it
  off the lead is not even read. `event_id` and dedupe are unchanged.
- **Fase 6.1b — "Bloqueado" always comes with a reason (API, shared and
  web)**, ported from the SaaS (`a7ccdab3`, #179, readiness part): new
  readiness reasons `ctwa_send_failed` (a real block),
  `ctwa_in_progress` and `ctwa_not_eligible` (informative: they leave the
  number partial and never downgrade a ready one), with counts in the DTO.
  `adUnavailableCtwa` now comes for every provider.
- **Fase 6.1b — Tests for the Unnichat routing-mode selector (web)**, ported
  from the SaaS (`d4d70274`); the behavior was already in the nod.

- **Fase 6.1a — One rule per event for every Unnichat/Umbler number, across
  connections (API, shared and web)**, ported from the SaaS (`42ccbc7c`,
  #159), adapted to the student edition:
  - New additive migration `20261027120000_provider_rule_cross_connection_scope`
    (in the SaaS: `20261021120000`): `ADD COLUMN IF NOT EXISTS
    "crossConnectionScope" BOOLEAN` on `ProviderConversionRuleConfig`,
    nullable. Existing rules do not change: an old "Todos os números"
    automation keeps covering its own connection until the operator uses
    "Ampliar para todas as conexões".
  - "Todos os números do Unnichat / da Umbler (todas as conexões)": the rule
    covers every number of the provider on any connection (Unnichat creates
    one connection per number); its connection is only the anchor of its
    deliveries and URL, and each occurrence is gated by the connection of its
    own number. New rules are created this way, without choosing a connection.
  - The callback origin (the URL that was called, or the per-event URL's
    proven number) is stored with the delivery (`callbackOrigin`) and reused by
    replays; it lives alongside the nod's Fase 5.3 `routedChannelId`.
  - Per-event URL: when a rule "todas as conexões" competes with another rule
    of the same tier on a number, the callback is held as
    `multiple_rules_for_event` ("Duas regras para o mesmo evento — unifique");
    older duplicates keep the oldest rule, as before. A rule whose connection
    was removed never wins the routing.
  - "Unificar" accepts Umbler/Unnichat automations (per provider + event): it
    reuses the rule "todas as conexões" or promotes the oldest live one; the
    others are paused and linked, and their old URL keeps delivering to the
    target. Different values or modes require `acknowledgeDifferences` (409
    `provider_rule_unify_differences`).
  - "Número removido" (`numberRemoved` in the DTO; in the nod also when the
    Uazapi/WAHA number was deleted in Integrations, i.e. its WhatsApp
    connection is suspended) with a highlighted warning and "Pausar"; removing
    the anchor connection moves a rule "todas as conexões" to another live
    connection of the provider (`provider_conversion_rule.reanchored`, audited,
    same transaction).
- **Fase 6.1a — Bulk delete of rules (API, shared and web)**, ported from the
  SaaS (`0f6e010d`, #161): `POST /conversion-rules/providers/bulk-delete`
  (integration managers; a write, so `423` with a locked license) removes each
  rule in its own transaction and reports every rule (`removed`,
  `not_found`, `needs_target_confirmation`, `failed`). The rule other unified
  rules point to only goes when confirmed, after them. Conversions list:
  selection, "Selecionar unificadas e de número removido", "Excluir
  selecionadas", the last event through each old URL (warning when it still
  received in the last 7 days) and "Ocultar regras unificadas". Deleting a
  rule whose number was removed no longer answers 404.

### Fixed

- **Review of PR #121 (API, shared and web; no new migration, no new
  variable)**.
  - `20261027125000_production_direct_validated_integrations` (unpublished,
    edited in place): step 3 also treats a `paused` sibling identity of the
    same phone as blocking, so a paused number never sends again through a
    `discovered` sibling; step 5 leaves `LeadSubmitted` rules in observation
    (decision D1); step 6 writes deterministic audits for Kommo
    (`production_direct_6_1c:kommo:<id>`) and step 7 promotes Pipedrive only
    with the `requireProduction` checks (active connection, healthy
    credential, webhook issued, every authorized number/route ready) and
    writes `production_direct_6_1c:pipedrive:<id>` (decision D2). Only
    connections whose authorized numbers are all explicit valid routes are
    promoted; a number authorized by its channel (inherited workspace
    page/pixel) needs the Meta routing check of "Ativar envio". Ran with
    synthetic data on a disposable PostgreSQL 16 and in PGlite, twice
    (idempotent).
  - `scripts/rollback/`: `antes-de-voltar-para-1.2.sql` (marks ROI Chat
    connections, Braip/Yampi/ROI Chat single URLs and their rules as removed,
    with `rollback_1_2:*` audits, so the 1.2.0 client no longer fails with
    `Value 'roichat' not found in enum`), `reativar-depois-de-atualizar.sql`
    and `desfazer-producao-direta-6-1c.sql` (undoes the promotion through
    its audits, only rows still carrying the migration's activation date;
    step 4 and the `meta_cloud/v1` certification have no audit). The cleanup
    also moves `WebhookLog`/`DiagnosticEvent`/`IntegrationLog`/`JobAttempt`
    rows with source roichat/braip/yampi to `internal`, keeping the original
    in `rollback_1_2_diagnostic_source` for the reactivation script.
  - Kommo and Pipedrive obey `INBOUND_CONVERSION_PRODUCTION_ENABLED=false`
    (`conversion_production_disabled`); the capabilities expose
    `conversionSendingOff` and Conversions shows "Envio desligado no
    servidor" in plain language. The created-rule message no longer shows the
    variable name.
  - Conversions: a `LeadSubmitted` rule with sending off offers "Ligar esta
    regra", explaining that the entry LeadSubmitted then goes through the
    rule.
  - Meta Lead Ads: only a transient Graph failure (network, 5xx, usage limits
    4/17/32/613/80001-80014, 1/2/341) answers 503; a permanent one (190/102,
    10/200-299, other 4xx, unreadable stored token) is saved as
    `fetch_failed` with its kind, answered 200, and the connection shows
    "Reconecte a Página" or "Falta permissão" (`fetchProblem`). A single
    connection that lists its forms no longer receives the Page's other forms.
  - CAPI batch (off by default): the batch POST has a 30 s timeout and a
    usage-limit refusal becomes retryable instead of a final
    `MetaCapiRejected`.
  - "Ver dados recebidos": CPF, CNPJ and documents keep only the last 2
    characters; e-mail and address are partially masked (LGPD).
  - Single URL: a refusal without a valid token is written at most once per
    minute per endpoint, IP and reason.
  - The reporting breaker clears itself on reconnect (OAuth, token rotation,
    new business connection, "Testar"); now covered by a test.
  - Accents in two messages; test fixtures use fictitious phones
    (5511999990xxx).

- **Fase 6 — Readable reason when Meta refuses a Conversions API event (API
  and web; no migration, no new variable)**. A `MetaCapiRejected` refusal now
  stores only `code`, `error_subcode`, `type` (must match `^[A-Za-z]{1,64}$`)
  and `fbtrace_id` (≤ 256 safe characters) of the Graph error, in the single
  and the batch send; `message`, `error_user_title`, `error_user_msg` and any
  other provider text are never kept (they may carry lead data). A map by
  code/subcode, limited to codes documented by Meta (Graph API error handling
  and rate limiting, Marketing API error reference), turns it into a
  Portuguese reason plus what to do (expired login/token, missing dataset
  permission, call limit, temporary error, policy block, invalid parameter);
  unknown codes show "A Meta recusou o evento (código X, subcódigo Y)" with
  the Meta support identifier. Shown in the Eventos list, the audit Resumo
  and "Resposta Meta" tab, and the lead's Pixel/CAPI events.
  `MissingMetaDestination` also shows the known resolver reason (e.g. "Conta
  Meta inativa"). `errorCode`, retries, dedupe and "Reenviar bloqueados"
  (190/102, same text as before) are unchanged.
- **Fase 6.3a — Meta spend and conversations follow the chosen period (API)**,
  ported from the SaaS (`d4420843`, #157): with a period, campaign, ad set and
  ad Meta numbers come only from the stored daily rows of that period (zero
  without rows), never from the entity columns (totals of the last sync
  window); WhatsApp ad sets/ads keep scoping mixed campaigns with their own
  period rows. Without a period the snapshot stays the source.
- **Fase 6.3a — Persisted Meta sync periods and safe logs (API and web)**,
  ported from the SaaS (`58d5e51b`, #83, reports part only): Relatórios also
  compares the saved period of accounts that are syncing (no false "Contas
  Meta com períodos diferentes"); the automatic sync and the "Sincronizar Meta"
  failure logs carry fixed codes, never the error text.
- **Fase 6.1b — Number listing without loading the whole CTWA history (API
  and web)**, ported from the SaaS (`478f0f9a`, #165): channel readiness of
  `GET /integrations/inbound-webhooks/:id/channels` comes from one aggregate
  SQL query per listing (COUNT FILTER / MIN per channel, on the existing
  `InboundWebhookEvent(channelId, occurredAt)` index), same meaning, no time
  window, no migration. On SQL failure: PII-free log
  `inbound_webhook.channels_readiness_sql_failed` and a bounded fallback
  (90 days, 5,000 events). Logs `channels_listed` / `channels_list_failed`
  carry ids and timings only. Integrations, Conversões and Kommo/Pipedrive
  say the numbers could not be loaded instead of "no number" / "number
  removed", and "Salvar canais" is blocked meanwhile. Covers Meta Cloud.
- **Fase 6.1b — Real stats of the Uazapi/WAHA bridge (API and web)**, ported
  from the SaaS (`4787a8f3`, #103) with the WAHA bridge: overview and
  readiness count the instance's CTWA leads (`source` uazapi or waha) and the
  last WebhookLog, instead of 0 and "Aguardando CTWA"; route reasons do not
  apply to the bridge.
- **Fase 6.1b — No "Gerar nova URL" on the Uazapi/WAHA bridge (API and
  web)**, ported from the SaaS (`e69a5e91`, #105) with the WAHA bridge:
  `rotateSecret` answers 409 without changing the secret (checked again in
  the transaction) and the panel shows a note instead of the button.
- **Fase 6.1b — A Payt reprocess no longer queues a sale whose number was
  never live on its own connection** (part of `d4c6a419`, #171): it stays
  observed with the reason, also when the observation claim returns its own
  execution as `purchase_duplicate`.
- **Fase 6.1b — Meta's 7-day window also for ad-attributed automation events
  (API)**, ported from the SaaS (`75f6f4b3`, window part only; the operator
  approval was already in the nod): Payt, Unnichat and Umbler automation
  conversions older than 7 days become `not_eligible` /
  `MetaEventTimeExpired` (technical delivery `blocked_configuration`)
  instead of failing at Meta. Only the age is checked.
- Not ported in 6.1b: `b65753b7` — its Unnichat occurrence proof is already
  in the nod and its production requeue lives in a backoffice recovery
  service the student edition does not have.

- **Fase 6.0 — One conversion per lead per pixel across numbers (API, shared
  and web)**, ported from the SaaS (`972f6179`, #153), adapted to the
  student edition:
  - A once-per-lead catalog event (QualifiedLead, LeadSubmitted) goes to Meta
    once per lead and Meta destination (pixel), whichever number or path saw
    it: provider rules (phrase, catalog, automation) and the CTWA entry.
    New `lead-lifetime-conversion-guard.ts`: lead identity by the canonical
    phone line (55 / 9th digit, `phone-identity.ts`), a transaction advisory
    lock per identity + event (always taken last) and a scan of the covered
    `ConversionEventLog` rows (`inbound_webhook:*`). Purchases and the
    other +-24h events are not covered.
  - Covered in the nod: team phrase rules on the WAHA bridge
    (`inbound_webhook:waha:*`) and on Uazapi, the Unnichat entry (live,
    replay and no-ad page/pixel) and, through the generic production and
    replay writers, the **Meta Cloud CTWA entry**
    (`inbound_webhook:meta_cloud`). A repeated entry keeps its own
    `not_eligible` receipt (proof of origin, reports) and is never queued.
  - New once-per-lead conversions get a deterministic `event_id`
    (`lead_<event>_<hash>` per workspace + phone line + event); ids already
    sent never change.
  - "Reprocessar bloqueadas" leaves out (and counts in the new optional
    `alreadyConverted`) what would only be a duplicate. The nod's
    conservative exclusions run first and are unchanged.
  - Executions show "Lead já convertido por outro número" / "pela entrada do
    anúncio".
  - Also ported from the SaaS: the per-number business dedupe of provider
    rules (`7d683975`, #84, only its dedupe part). The frozen decision key
    and the execution check now include the connection and the number, so
    the same lead on another number to a second pixel gets its own event, and
    purchases / +-24h events on different numbers are independent (the
    once-per-lead guard covers lead events across numbers). nod upgrade
    bridge: decisions frozen before this version keep blocking a repeat on
    the same number. The `auto_lead` entry (Uazapi/WAHA connections) keeps
    its own per-lead dedupe; it joins this rule with #155 (6.2a).
- **Fase 6.0 — "Reenviar bloqueados" also resends Meta login failures
  (190/102) (API, shared and web)**, ported from the SaaS (`4d2fbf83`, #181,
  plus the stalled `ready_to_send` part of `7ac17df7`):
  - Events refused by the CAPI for a dead token or login checkpoint
    (`error.code` 190, any subcode, or 102) inside Meta's 7-day window join
    the bulk resend; older ones are skipped and counted as `expired`;
    Kommo/Pipedrive (single-dispatch ledger) stay out. Conditional claim,
    `event_id`, workspace and the 500 cap are unchanged.
  - Button "Reenviar bloqueados e falhas de login da Meta" with tooltip;
    `summary.metaAuthRetryable` (optional) counts them; the row explains
    the login failure. A `ready_to_send` without error stuck for more than
    10 minutes can be retried from the audit.
  - nod difference: the nod CAPI adapter never stored the body of a
    rejection (PII). It now stores only the numeric Graph `error.code`
    next to `httpStatus`; rejections recorded before this version have no
    code and stay out of the resend.
  - Locked license: both resends and "Reprocessar bloqueadas" are writes and
    answer `423` (global guard; explicit test).
- **Fase 6.0 — Payt times in Brasília time; `event_time` never in the
  future (API)**, ported from the SaaS (`a1b600c2`, #173): naive Payt dates
  ("2026-10-23 21:39:30.000000") are read as America/Sao_Paulo by the new
  `sao-paulo-timestamp.ts` (an explicit zone is kept), and a time after the
  arrival + 5 min is capped at the arrival (`firstReceivedAt` on
  re-evaluations, now on live ingestion). The dedupe identity does not use
  the time; no backfill. The Brink Park part does not apply.
- **Turning "Envio ativo" on no longer gets stuck on an orphan or duplicate
  number (API)**, ported from the SaaS (`3f59e2f7` of #66 / `37572ad9`,
  `ff28d8a1` #85, `71e69a95` #86): numbers no longer on the rule's live
  connection are dropped from the rule (audited
  `provider_conversion_rule.channel_scope_pruned`) instead of a 404 "Recurso de
  webhook não encontrado"; an already active channel is not re-activated (no
  second Meta route check); a rediscovered `discovered` number is remapped to
  its active sibling on the same connection (`channel_scope_remapped`). nod
  adaptations: rules over numbers of several connections also skip removed
  connections, and a Uazapi/WAHA number deleted in Integrations (suspended
  WhatsApp connection) is never activated but stays on the rule; without any
  valid number the answer is a clear 409. The SaaS `retireBridge` does not
  exist in the nod.
- **Old URL section without rotation; accented event labels (web)**, ported
  from the SaaS (`5141e217`, #160): with the single/per-event URL active, the
  rule's own address only shows inside "URL antiga (desta conexão)", with its
  last receipt, guided copy and no "Gerar novo endereço". Kommo and Pipedrive
  now show the accented event labels.
- "Pausar" works on a rule whose number was removed, and "Ampliar para todas as
  conexões" on a rule already sending activates the covered numbers (review of
  the port).

## [1.2.0] - 2026-10-24

Upgrade notes for students: [`docs/releases/1.2.0.json`](docs/releases/1.2.0.json). No migration, no new environment variable.

### Added

- **Meta Cloud: subscribe the installation app to the student's WABA from the
  panel.** New block "Inscrição do app na sua WABA" on `meta_cloud`
  connections, backed by
  `POST /integrations/inbound-webhooks/:connectionId/meta-cloud/waba-subscription/lookup`
  (reads `GET /{waba}/subscribed_apps`) and
  `POST /integrations/inbound-webhooks/:connectionId/meta-cloud/waba-subscription`
  (`confirm: true`; `POST /{waba}/subscribed_apps` without
  `override_callback_uri`, then re-reads the real state). Both take the WABA
  ID and the student's token in the body; the token is used only for that
  request and is never stored, returned, logged or audited. Owner/admin only
  (`canManageIntegrations`); the license soft-lock answers 423 to both.
- The token is checked first with `GET /debug_token` using the server-side
  app token (`META_APP_ID|META_APP_SECRET`): it must be valid, of type `USER`
  or `SYSTEM_USER` (the temporary token from the app dashboard, a Graph API
  Explorer token or a system user token), issued for `META_APP_ID`, with
  `whatsapp_business_management`; when that scope carries `target_ids` the
  WABA must be listed (without `target_ids` the Graph calls are the final
  check). Missing `META_APP_ID`/`META_APP_SECRET` answers 503 without calling
  Meta.
- `GET /{waba}/phone_numbers` validates the WABA ID, detects a phone number
  ID pasted instead of the WABA ID and warns when a real channel phone number
  ID of the connection is not in that WABA. Graph errors 190, 200/10, 100,
  4/80007 and network/timeout map to pt-BR messages with a stable `code`.
  Every lookup and subscription writes an `AuditLog` (WABA ID, result, actor;
  no token). Other subscribed apps are listed and never removed (no DELETE).
- Zod contracts in `packages/shared` (`metaCloudWabaSubscription*`).

### Changed

- `docs/setup/whatsapp-providers.md` (Meta Cloud) now separates the three
  Meta steps (URL handshake, `messages` field on the app, app subscription on
  the WABA) and documents the panel subscription and the manual fallback;
  `docs/setup/meta-cloud-recovery.md` and `docs/GUIA-ALUNO.md` follow. Team
  phrase rules remain unavailable on Meta Cloud.
- Meta Cloud guide: explains that Meta does not deliver team-sent messages
  through the Cloud API webhook, so team phrase rules do not work on a Meta
  Cloud connection. Numbers on coexistence (WhatsApp Business app alongside
  the Cloud API) should be connected through the student's own Uazapi (CTWA
  plus team messages); without coexistence, phrase conversion depends on
  integrating the platform the team answers from (CRM/support), for example
  by calling the single conversion URL.

### Fixed

- Docs no longer claim Z-API handles ad leads (CTWA) or phrase rules: the
  `zapi/v1` parser does not read the real Z-API payload, so Z-API is
  "Em breve" in `whatsapp-providers.md`, `GUIA-ALUNO.md`,
  `troubleshooting.md`, both READMEs and the onboarding prompt. The WAHA text
  in `GUIA-ALUNO.md` now says it has ad leads and team phrase rules.
- Accents on user-visible labels in `packages/shared` (client/backoffice
  navigation, "Integração externa", "Compra atribuída" and validation
  messages). Codes, enums and CSV headers are untouched. The conversion event
  catalog stays ASCII on purpose (the web accents it via `event-copy.ts`), and
  "Selecione ao menos um numero" stays as is because the web maps that exact
  message.

## [1.1.1] - 2026-10-24

Upgrade notes for students: [`docs/releases/1.1.1.json`](docs/releases/1.1.1.json). No migration, no new environment variable.

### Added

- **Team phrase rules on WAHA (GoWS).** A team message sent from a WAHA
  number (`message.any` with `fromMe`) now runs the same phrase (and
  structured catalog) rules as Uazapi: same bridge, frozen decision,
  execution and Meta send. `UazapiConversionBridgeService.ensureBridge` and
  `UazapiProviderConversionService.evaluateTeamMessage` take the provider
  (`uazapi` default, `waha`); the WAHA bridge is a `waha`
  InboundWebhookConnection on the certified `waha`/`v2` parser release, with
  occurrence keys `waha:<channel>:<message id>`. The contact is the phone the
  v2 parser resolves (`RecipientAlt`, `to`, `Chat`), and a LID-only contact
  is looked up on the student's WAHA (`RecipientAlt` filled before
  reparsing). The paid lead is found by the existing lookup (which already
  accepts 12 and 13 digit Brazilian numbers). No paid lead: same as Uazapi.
- **"Todos os números" and specific rules on WAHA**: saving a production rule
  activates WAHA numbers, a WAHA number connected later is activated
  automatically (new durable event `inbound_webhook.waha_bridge_provisioned`),
  and "Ativar envio neste número" and "Reprocessar bloqueadas" work for WAHA.
  WAHA bridged numbers resolve the Meta destination per ad (no saved route),
  only send while the WAHA connection is active, and pauses are kept.
- **Same phone on two connections:** the "Todos os números" rule now runs on
  the channel that is still receiving messages (bridged Uazapi/WAHA numbers
  record their last message), then, as before, the active one and the
  oldest. A number moved from Uazapi to WAHA whose old Uazapi connection was
  left active no longer blocks the WAHA as a duplicate phone. One channel per
  phone is unchanged and a phone still converts once. Tip: when moving a
  number from Uazapi to WAHA, delete the old Uazapi connection in
  Integrações.
- WAHA numbers are bridged when Conversões loads, when **Testar** reports
  `WORKING`, or on the first team message; the store's real number replaces
  the session placeholder on the first team message.

### Changed

- `waha` left `UNSUPPORTED_RULE_WHATSAPP_PROVIDERS`; the capability matrix
  lists it for team phrases, catalog and Payt sales, never for labels.
  Conversões no longer shows WAHA under "Em breve nas regras": the WAHA number
  shows in Nova regra, editing, filters and the number list, with no label
  trigger. The label origin text now names Uazapi numbers.
- Guides: `docs/setup/whatsapp-providers.md` (new section "Regras de frase da
  equipe na WAHA"), `troubleshooting.md` and `dokploy.md`.

### Fixed

- WAHA team messages ended as `ignored_outbound` and the phrase rule never
  ran ("pagamento confirmado" typed by the team did not convert).

### Tests

- Receiver (team message by `RecipientAlt`, `to`, LID lookup, inbound
  messages never run team rules, `message` copy and webhook redelivery
  evaluated once, text-less media, failure marks the delivery for retry),
  28 anonymized real team-message examples (`team-phrase-examples.json`),
  activation matrix, and `waha-global-rule-production.pg.test.ts` (global
  with 1 and N numbers, number connected later, specific, global + specific,
  no duplicate, 12-digit phone, Reprocessar bloqueadas, paused, suspended,
  Uazapi regression).

## [1.1.0] - 2026-10-23

Upgrade notes for students (backup, the 26 migrations in order, environment variables, verification and rollback): [`docs/releases/1.1.0.json`](docs/releases/1.1.0.json).

### Changed

- **Integrations hub** (`/integrations`, web only): the page is now a catalog
  with four tabs — **WhatsApp** (Uazapi, WAHA, WhatsApp Cloud API; Z-API and
  NOD API show "Em breve"), **Atendimento e vendas** (Umbler Talk, Gupshup,
  Data Crazy), **Anúncios** (Meta Ads: social login or token, traffic data and
  CAPI conversions — it receives no conversations) and **CRM** (Kommo) — with
  logo cards (**Ativo** / **Disponível**) and one connection modal per
  platform. Z-API / NOD API: no new connections, but an existing one stays
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

- **License is now required (fail-closed)**: with `LICENSE_SERVER_URL` set and no
  valid activation, reads keep working but every write answers `423`
  (`license_required`, `activation_failed`); the API activates the configured
  license on boot. Clear `LICENSE_SERVER_URL` only for local development: [#21](https://github.com/samoskito/nod-rastrackdash-wpp/pull/21)
- **Persistent platform admin roles**: backoffice access comes from the role
  stored in the database. The `WPPTRACK_PLATFORM_ADMIN_EMAILS` allowlist no longer
  grants access; create or promote the first `platform_owner` with
  `SETUP_PLATFORM_ADMIN_EMAIL` / `SETUP_PLATFORM_ADMIN_PASSWORD` (plus
  `SETUP_PLATFORM_ADMIN_CONFIRM_EXISTING=true` for an existing account): [#25](https://github.com/samoskito/nod-rastrackdash-wpp/pull/25)

### Added

- **WAHA screen (web)**: the WAHA card in the Hub is released (no "Em breve";
  the panel mounts even without a connection). The modal asks for name,
  server URL, API key and session (required) with a short "your own WAHA"
  guide; **Testar conexão** shows the session status (WORKING, SCAN_QR_CODE,
  STARTING, STOPPED, FAILED) with what to do in each one (e.g. read the QR in
  the student's own WAHA panel); **Configurar webhook** calls
  `configure-webhook` and shows the subscribed events or the pt-BR reason of
  the refusal; **Configuração manual** asks for confirmation (rotating the
  token invalidates the current webhook), then shows once the URL with
  `?token=`, the events and the `X-Wpptrack-Webhook-Token` header. The API key
  never comes back to the screen; the standard license message appears on a
  423. Conversions keep WAHA under "Em breve nas regras", with a note that ad
  lead entry (CTWA) already works. No QR and no server in the app. New file:
  `waha-session-guidance.ts`; no migration, no new env var.
- **WAHA with the GoWS engine (API and shared)**.
  The WAHA server is the student's own: they host it, create the session and
  scan the QR in their WAHA panel. The app never creates a session nor shows a
  QR; the connection stores the server URL, the API key and the session
  (required).
  - **Parser `waha` v2** (`waha-v2.parser.ts`, registered next to the
    untouched v1): reads `payload._data.Info` / `payload._data.Message`. Phone
    from a phone JID or `Info.SenderAlt` (received) / `Info.RecipientAlt`
    (team), the `:NN` device suffix stripped, the store's own number never a
    contact; the LID is kept apart in `contact.lid` and never used as the
    phone (a contact by `@lid` or by phone resolves to the same lead).
    Groups, Status (`status@broadcast`), broadcast lists and newsletters are
    discarded. Received messages only from `message`, team messages only from
    `message.any` (no double count). `ctwa_clid` only from
    `externalAdReply.ctwaClid`/`ctwa_clid`, searched in every message type and
    inside `ephemeralMessage`/`viewOnceMessage*` (as the Rastrackapp
    `findCtwaContext`); `ctwaPayload` is never a clid. `fromMe` must be a real
    boolean.
  - **Certified release:** migrations `20261022130000_waha_inbound_provider`
    (enum value `waha` in `InboundWebhookProvider`) and
    `20261022130100_waha_parser_release` (`waha`/`v2` certified; retired stays
    retired). `POST /webhooks/whatsapp/:id` uses v2 while that release is
    certified, otherwise v1. WAHA has no generic inbound connection (refused
    with 409, left out of the capabilities).
  - **Lead entry:** with a clid, ad lead + `LeadSubmitted` (same path as the
    other providers; the push name only fills an empty lead name). Only
    `sourceID`, no clid (WhatsApp Status ads, ~22% of clicks): ad lead
    attributed by the ad id with the `sourceURL`, as in the Rastrackapp, and
    nothing sent to Meta (`LeadSubmitted` and rules need a clid; the
    `ctwaPayload` is never used as one). Organic: logged, no lead. WAHA only;
    Uazapi unchanged.
    Idempotency keys include the event (`message` / `message.any`);
    `session.status` updates the connection health; the webhook log keeps a
    structural summary only (no text, name, LID, phone, clid or thumbnail).
  - **Adapter:** Testar reads `GET /api/sessions/{s}` and returns the raw
    status (`providerStatus`: WORKING, SCAN_QR_CODE, STARTING, FAILED,
    STOPPED); another engine is reported as an error.
    `POST /integrations/whatsapp-connections/:id/configure-webhook` reads the
    session and `PUT`s it back with its config preserved, replacing only our
    webhook (`message`, `message.any`, `session.status`, token in the
    `X-Wpptrack-Webhook-Token` header, linear retries); the token hash is
    stored only after the WAHA accepts it. `rotate-webhook-token` adds
    `wahaManualSetup` (URL with `?token=`, events, header name). No HMAC yet.
  - **Shared contracts:** `WAHA_GOWS_WEBHOOK_EVENTS`,
    `WAHA_WEBHOOK_TOKEN_HEADER`, `wahaWebhookManualSetupSchema`,
    `whatsappConnectionWebhookConfigureResultSchema`, `providerStatus` on the
    test result, `waha` in `inboundWebhookProviders`.
  - WAHA phrase rules stay locked (`UNSUPPORTED_RULE_WHATSAPP_PROVIDERS`).
    Synthetic GoWS fixtures in `apps/api/test/fixtures/waha-gows/` (README; an
    anonymity test guards them). Guide: `docs/setup/whatsapp-providers.md`.
    No new env var or dependency. Roll back: see `docs/releases/unreleased.json`.
  - **Review fixes:** the session `PUT` (it restarts the session) waits up to
    30 s and, on timeout or 5xx, re-reads the session and succeeds only if our
    webhook with the new token is saved; no `PUT` when the session config
    returns masked secrets (`masked_secrets`, manual setup suggested); an
    ad click whose contact only has a LID keeps the metric
    (`ctwa_contact_phone_unresolved`, `hasCtwa`/`adId` in the log) and is
    resolved through the student's WAHA (`GET /api/{session}/lids/{lid}`, 3 s,
    best effort) before giving up; `session.status` only applies when newer
    than the last health check (envelope `timestamp`); `fromMe` falls back to
    `Info.IsFromMe` and the time to the envelope `timestamp`; manual setup
    leads with the header (`webhookUrl` in `wahaManualSetup`), the `?token=`
    URL is the alternative; "Configurar webhook" asks to confirm the restart
    and a 403 has its own message. Migrations renamed to
    `20261022130000_*`/`20261022130100_*` (not applied anywhere yet).

- **Fase 5.3 — Single URL per platform and per-event URLs (API, shared and screens)**,
  ported from the SaaS (`6d4aa02`, `a9d2d3c`, `613beb3`, `22c6506`, `46fb0df`,
  `d3725ad`, `4cad496`, `73a9a56`; the web commits `ca783a1`, `f2e676b` and
  `6574aad`, adapted to the student edition). Payt, Unnichat and
  Umbler only (no Braip, no Guimoo):
  - **Workspace URLs:** `POST /webhooks/inbound/integrations/:id?token=`.
    Payt: one URL per workspace, the event comes from each postback.
    Unnichat/Umbler: one URL per event, valid for every number. The token is
    compared in constant time and stored only hashed and encrypted; a wrong
    token, an unknown or a removed URL get the same `404`. Locked license:
    `423` (global guard), nothing stored.
  - **Routing**, then the SAME pipeline as the rule's own URL
    (`ingestRouted`: same ingress key, delivery, decision, gates, dedupe and
    manual replay; no parallel path). Payt: buyer phone and the number the
    lead arrived on; specific rule > all numbers, with product filter >
    without, then the oldest. Unnichat: the `ctwa_clid` entry. Umbler:
    `channel.phone` of the body, else the only Umbler number the contact
    talked to in the last 30 days (two numbers = unattributed, never
    guessed). A provider retry of a routed sale goes back to its rule.
  - **Product filter** on Payt rules (`productFilterCodes`, by product or
    offer code, case-insensitive; empty = every product). A specific rule with
    a filter only replaces the global one for its products.
  - **Receipts** (`IntegrationEndpointEvent`, idempotent per URL + ingress
    key) with product, destination or reason: "Produtos detectados" and
    "Vendas sem atribuição" with "Tentar de novo". Raw body cleared with the
    payload retention (7 days); unrouted receipts deleted after 60 days by the
    inbound maintenance job; routed ones stay.
  - **One send for both URLs:** Payt purchase claim (seller + order +
    event); Unnichat automation conversions get a business identity (lead +
    click for lifetime events, the callback for the others) as Meta
    `event_id` / dedupe key; Umbler gets the same identity. Repeatable
    events (Purchase...) are deduplicated between the URLs only when the
    body is identical. Events already sent keep their ids.
  - **Review fixes:** the Umbler number proved by the router is handed to the
    rule (checked against its scope and kept on the delivery for resends and
    reprocesses); the Payt router uses the ad lead's verified CTWA proof when
    no ad entry was materialized and, for a lead with entries on several
    numbers, routes only when exactly one specific rule owns exactly one of
    them (as the old URLs do); a routed callback the rule ignores, gives to
    another rule, filters or blocks becomes `unattributed` with
    `rule_declined` (the rule's own code in `ruleReasonCode`); "Tentar de
    novo" keeps the original receipt time (production gate); receipts of a
    removed URL are not retryable; retention runs in batches; disabling an
    old URL without the workspace URL of that platform/event answers 409.
  - **Old per-rule URL:** keeps working; `PATCH
    /conversion-rules/providers/:id` with `publicUrlDisabled: true` and
    `confirmPublicUrlDisable: true` closes it (404, nothing stored, the rule
    keeps receiving through the workspace URL); `publicUrlDisabled: false`
    reopens it. Audited. `perRuleUrl: false` on create makes a rule for the
    workspace URL only.
  - **Management API** `/integrations/endpoints`: list (with the old URLs and
    their last delivery), create, reveal (audited), rotate, remove, detected
    products (Payt), unattributed sales and retry. Reads for any member,
    writes for integration managers.
  - Migration `20261019120000_integration_single_urls` (additive: two tables,
    one enum, three nullable/defaulted columns). Workspace deletion (backoffice
    and `scripts/delete-workspace.js`) removes the new rows first. No new env
    var or dependency. Guide: `docs/setup/url-unica.md`.

- **Fase 5.2 — Reports per currency and PTAX (API and shared)**, ported from
  the SaaS (`996e7c1`, `5b4fdd4`, `c9428b1` env part, and the PTAX /
  `ExchangeRate` / report-contract parts of `0bf5ebf` and `5981c7c`); the
  student's `meta-reporting.service.ts` (leads novos × que voltaram, CPL) was
  merged by hand, not replaced:
  - **Spend currency per ad account:** manual correction (Configurações →
    Moeda) → Meta currency → BRL. Campaign, ad set and ad rows carry
    `currency`; revenue attributed to an ad is converted to its account
    currency.
  - **Currencies are never summed.** `/reports/campaigns`, `/reports/adsets`
    and `/reports/ads` return `currency` (single currency) or `currency: null`
    plus `byCurrency` (and `summaryByCurrency` for the Overview summary): one
    group per currency with spend or revenue in the period, never an empty
    group. A workspace all in BRL gets the same numbers as before plus
    `currency: "BRL"` (checked by a test against the pre-5.2 output).
  - **Ad account filter:** `adAccountIds` (comma separated or repeated, up to
    50) on the three reports and `campaigns/export.csv`, alongside the existing
    `adAccountId`. The CSV gains **Moeda** and **Receita sem cotacao** columns
    at the end (other columns keep their place). With mixed currencies a
    metric sort groups rows by currency first (BRL, USD, EUR), never
    interleaving them.
  - **PTAX** (`PTAX_SYNC_ENABLED`, **off by default**; not the SaaS
    `WPPTRACK_PTAX_SYNC_ENABLED`). Off: no external call; a sale in another
    currency stays in its original currency, out of the revenue, flagged
    `exchangeRateMissing` with `unconvertedRevenue` ("sem cotação"). On: every
    6 h the API fetches the BCB PTAX (`olinda.bcb.gov.br`, closing sell rate)
    into `ExchangeRate` and fills missing days in the background (a report
    waits at most ~1.5 s; weekday holidays are not fetched again; today only
    after 13:30 Brasília); revenue is converted
    by the rate of the sale day (America/Sao_Paulo), or the last previous
    business day. A sale with no ad account keeps its own currency. BCB down:
    a stored rate from up to 10 days before, else "sem cotação"; reports
    never fail and nothing is sent
    to Meta because of it. A legacy currency code outside BRL/USD/EUR is
    summed as before on a BRL account and is "sem cotação" on a USD/EUR one
    (logged with the codes only).
  - Migration `20261016180000_exchange_rates` (additive: new table
    `ExchangeRate` only). No new dependency. The screen (account selector,
    totals side by side) comes in a later delivery.

- **Fase 5.1 — Conversion currency (API, shared and web)**, ported from the
  SaaS (`0bf5ebf`, `5981c7c` settings part, `ffd0bae`, `e510840`, `c4c0375`
  audit part, `2f79c3c` settings screen, `5ce8393` rule currency):
  - **Moeda das conversões** per workspace: BRL, USD or EUR, **default BRL**.
    Any member reads it (`GET /workspaces/current/currency`); owner/admin
    changes it (`PATCH`, audited `workspace.conversion_currency_updated`,
    423 with a locked license).
  - Optional **currency correction per ad account**
    (`GET /workspaces/current/currency/ad-accounts`, `PATCH .../:id`, audited);
    stored now, used by the reports in Fase 5.2.
  - **Sending to Meta:** a conversion value always travels with a currency,
    resolved as sale/deal currency → rule currency → workspace currency → BRL.
    No exchange conversion. Conversions already sent never change; an unsent
    event goes with the currency it was recorded with (an old one with a value
    and no currency as BRL, as before; one with a code outside BRL/USD/EUR is
    blocked by the Meta preflight with `UnsupportedCurrency`). A value that
    arrives later on a valueless event takes that value's currency.
  - A rule may keep its own currency or none (= follow the workspace); new
    rules no longer get BRL forced by the contract, rules already stored keep
    their currency. **Rule currency accepts only BRL, USD or EUR** on every
    rule contract (provider, old rules, catalog, Kommo, Pipedrive); other
    codes answer 400 "Moeda inválida: use BRL, USD ou EUR". Rules stored before
    with another code still load and, when sending, use the workspace currency.
    Payt no longer forces BRL (it uses the currency the sale declares,
    otherwise rule/workspace); a sale declaring a currency outside the list is
    refused with `payt_currency_unsupported` and nothing reaches Meta.
    Pipedrive uses the deal currency and checks it against the rule's
    (`event_currency_mismatch`); a deal without currency uses the rule's or the
    workspace's; a deal in an unsupported currency is ignored
    (`event_currency_unsupported`). Kommo: a rule without a valid currency
    uses the workspace currency.
  - **Screen (web):** Configurações → Moeda shows the workspace currency
    (BRL/USD/EUR, with a warning before saving that the change only affects new
    conversions; only owner/admin change it) and the ad accounts with the
    currency detected by Meta, the manual correction (removable) and the
    currency in use. The conversion rule (new, edit, old rules) and the Jornada
    stages gain a currency field with "Padrão do workspace" (sends `null`) or
    an own currency. The Kommo and Pipedrive panels start the currency on the
    workspace's and always send it. Conversion values shown on screen use the
    currency of the event or rule via `formatMoney`; the Reports and Overview
    totals are untouched (Fase 5.2). Writes answer the standard locked-license
    message on 423.
  - **Default behavior:** a workspace that never changes the currency keeps
    sending BRL exactly as before.
  - Migration `20261016140000_conversion_currency` (additive: enum
    `CurrencyCode`, `Workspace.conversionCurrency` default `BRL`,
    `MetaReportingAccount.currencyOverride` nullable). No new env var or
    dependency. Zod contracts in `packages/shared` (`currency.ts`,
    `schemas/currency-settings.ts`).

- **Fase 4b — Unnichat conversations and automations as Meta conversions (API,
  shared and web)**, ported from the SaaS with the same behavior and no new env
  var, dependency or Meta permission (the PalmUP social login does not
  change):
  - Unnichat connection bound to the client's WhatsApp number: creating it
    (`POST /integrations/inbound-webhooks` with `provider: "unnichat"` and the
    new `connectedPhone`, required only for Unnichat) also registers that
    number as the connection's channel (normalized phone as channel identity,
    `metaRoutingMode: inherit_workspace`). The entry webhook
    (`POST /webhooks/inbound/:connectionId?token=`, direct JSON or n8n
    single-item envelope) carries no channel id, so the parser receives the
    bound number from the connection, never from the payload. Provisional
    channels are refused for Unnichat.
  - Parsers `unnichat/v1` (conversation entry) and `unnichat/automation-v1`
    (flow movement), with the original-bind proof (click-scoped dedupe key,
    only the sha256 of `ctwa_clid` kept in the summary) and the contact name
    filling only an empty lead name.
  - No `ctwa_clid` → nothing is sent (entry ignored, automation blocked as
    `ctwa_missing`). A CTWA lead with `ctwa_clid` and no ad id (or an ad the
    workspace does not know, kept only as an attribution hint) is materialized
    and sent to the number's unique authorized page + pixel
    (`ctwaDestinationProviderValue()` now returns `unnichat`); the SaaS WABA
    binding is not ported. Known ads keep the canonical ad route.
  - Per-number routing mode (Unnichat only): `routingMode`
    (`inherit_workspace` / `channel_override`) in
    `PUT /integrations/inbound-webhooks/channels/:channelId/routes`; other
    providers get 409. Channel readiness gains `routingSource`,
    `effectiveRouteEligible`, `ctwaDestinationReadiness` and
    `adUnavailableCtwa` (Unnichat only); overview gains
    `automationParserRelease`.
  - Origin `automation_unnichat` in Conversões (capabilities: Unnichat
    channels only, `connectionBound` and `requiresConnection` true, any
    catalog event, not unifiable): the rule is bound to the Unnichat
    connection, the event comes from the rule (never from `event_name`) and
    the rule has its own URL (`POST /webhooks/inbound/conversions/:endpointId`).
    A repeated callback is one occurrence. Payt rules may cover Unnichat
    numbers, and Payt sales of no-ad leads that entered through Unnichat go to
    the page + pixel.
  - SaaS parity fixes on the shared CTWA path: a page/pixel event whose final
    authorization fails before the POST is recorded as `not_configured`
    (never sent) instead of "delivery unknown"; the legacy/shadow decision
    engine keeps ad-only authority; a payload that no longer decrypts gets
    `inbound_webhook_production_payload_decrypt_failed`.
  - Migrations (additive, in order): `20261016130000_unnichat_inbound_provider`
    (enum value `unnichat` in `InboundWebhookProvider` and `DiagnosticSource`)
    and `20261016130100_unnichat_parser_releases` (`v1` and `automation-v1`
    seeded as certified; nothing is activated). Back up the database first.
    Student action: create the connection with the number, paste the entry
    URL and the rule URLs in the Unnichat flows, choose the routing mode,
    check and activate. Locked license: 423 on both public URLs. No recovery
    of earlier Unnichat CTWAs (stays Meta Cloud only). Guide:
    `docs/setup/unnichat.md`. **Roll back:** pause or delete the Unnichat
    rules and connections; reverting the image is safe when no Unnichat
    connection was created (see the guide otherwise).
  - Web: Unnichat card in the Integrations Hub (Atendimento e vendas); create
    a connection with a name and the client's number (entry URL shown once);
    per-number selector "Herdar do workspace" / "Configurar neste número" with
    readiness and reasons; origin "Automação do Unnichat" in Conversões → Nova
    regra (bound to the connection, any catalog event) with Eventos recebidos;
    locked license (423) notice. Publish the web of this release.
- **Fase 4a — Payt sales as Meta conversions (API, web and shared)**, ported from
  the SaaS with the same behavior and no new env var, dependency or Meta
  permission:
  - Payt is a sales platform, not a WhatsApp number: it has no connection of
    its own (creating a `payt` inbound connection is refused). A Payt sale
    rule (`triggerType: provider_automation`, `automationSource: "payt"`,
    origin `automation_payt`) is created in Conversões, bound to the WhatsApp
    connection of its numbers (only the anchor of its signed URL), and may
    scope any WhatsApp number of the workspace (`all_numbers` or
    `specific_numbers`).
  - Rule capabilities gain the optional `requiresConnection` flag (true for
    `automation_umbler` and `automation_payt`); `automation_payt` keeps
    `connectionBound: false` (its numbers may come from any connection). Rule
    responses carry `origin: "automation_payt"` and `automationSource: "payt"`.
  - Events come from each postback status, one rule per event and one URL
    per rule (`POST /webhooks/inbound/conversions/:endpointId?token=`):
    approved purchase (paid, or cash on delivery confirmed) → `Purchase`;
    Pix/boleto generated (waiting payment) → `InitiateCheckout`; abandoned
    cart → `CartAbandoned` (**beta**). Other statuses, and other events on a
    rule, are recorded as ignored, never as errors. The value comes from the
    sale (cents).
  - No `ctwa_clid` → nothing is sent. The buyer must match exactly one tracked
    CTWA lead of the rule's numbers (Brazilian phone forms); a lead that came
    through another number with its own Payt rule is left to that rule. A
    duplicated postback (or two postbacks of the same sale) is one conversion
    (`ProviderPurchaseClaim`). Sales of leads without an ad id are sent only
    for leads that entered through an Unnichat number (Fase 4b, below).
  - Rules start in observation. "Reprocessar selecionados" re-evaluates
    callbacks in observation (new item status `observed`, never sent) and, in
    production, only with the operator's explicit action; the send re-checks
    the sale before materializing.
  - Migrations (additive, in order): `20261016100000_payt_inbound_provider`
    (enum value `payt` in `InboundWebhookProvider` and `DiagnosticSource`)
    and `20261016100100_payt_parser_releases` (Payt `v1` and `automation-v1`
    parser releases seeded as certified; no rule, connection or channel is
    activated). Back up the database before updating. Student action: create
    the rule in Conversões and paste its URL in the Payt postback; check
    "Eventos recebidos". Guide: `docs/setup/payt.md`. **Roll back:** disable
    or delete the Payt rules and remove the postback; reverting the image is
    safe when no Payt rule was created (see the guide otherwise).
  - Web: Payt card in the Integrations hub (Atendimento e vendas tab), which
    explains that Payt has no connection of its own and points to Conversões;
    Payt origin in Conversões > Nova regra with the three events (Carrinho
    abandonado with the beta badge), bound to the connection of the chosen
    numbers; the postback URL is shown only once (on create or "Gerar novo
    endereço") next to the Payt setup steps; Eventos recebidos shows sale
    names, lists postbacks of another status or event as "Ignorado" (neutral
    tone, no longer counted as invalid payloads) and reprocesses in
    observation; license-locked (423) notice.
  - Update: rebuild shared, restart the API and publish the web of the same
    release. No new env var or dependency on the web.
- **Fase 4c — Pipedrive CRM (API + shared + web)**, ported from the SaaS without
  its pilot flags (`PIPEDRIVE_PANEL_*`, `PIPEDRIVE_CONVERSION_PRODUCTION_ENABLED`):
  owner-managed connections (API token sealed with the new optional
  `PIPEDRIVE_CRM_ENCRYPTION_KEY`, Base64 32 bytes, must differ from
  `KOMMO_CRM_ENCRYPTION_KEY`; an invalid or reused value fails boot, an unset
  value keeps boot unchanged), pipeline/stage catalog, stage and "deal won"
  rules (observation → production per rule, owner-activated, only for
  notices after activation), Webhooks v2 `deal`/`change` ingress at
  `POST /webhooks/pipedrive/v1/:connectionId?token=…` (durable `202`, person
  lookup and lead match in the worker). Every write needs the license: HTTP
  writes (including the webhook) get the global `423`, and the worker and the
  sender stop while the license is locked. Additive migration
  `20261016120000_pipedrive_integration` (six `Pipedrive*` tables). Guide:
  `docs/setup/pipedrive.md`. Web: a Pipedrive card in the Integrations Hub
  (CRM tab) with API-token connect, the webhook URL shown once, stage and
  "deal won" rules, authorized channels and received events; Conversions
  lists Pipedrive rules read-only with "Gerenciar no Hub"; Kommo and Pipedrive
  share the WhatsApp number options (any provider, with the reason a number
  cannot be authorized); a locked license (`423`) shows a notice and keeps the
  panel, including the rule forms, read-only.
- **Kommo leads without an ad id (API)**: a lead with `ctwa_clid` and no ad
  id is now sent through the verified workspace page + pixel when it entered
  through a number authorized on the Kommo connection that inherits the
  workspace destination (same as the SaaS). Ad leads keep the route path; an
  ad lead with a known destination but no authorized route is refused as
  `lead_channel_route_unauthorized` for any provider (SaaS code). No
  `ctwa_clid` → nothing is sent (Kommo and Pipedrive).
- **Fase 4.0 — CTWA purchase foundation (API)**, ported from the SaaS with
  the same behavior and no new env var, dependency or Meta permission:
  - **Data Crazy, Gupshup and Umbler (messages) can go to production by
    rule**: migration `20261016090300_validated_parser_certification`
    certifies the `v1` parser releases of `data_crazy`, `gupshup` and
    `umbler` (the same contracts running in production in the SaaS; only
    the parser release row changes, retired stays retired). Connections and
    rules still need their own production activation. Meta Cloud `v1` needs
    no change (built-in eligibility).
  - **CTWA rule**: no `ctwa_clid` → nothing is sent to Meta. A lead with
    `ctwa_clid` and no ad id may be sent to the unique authorized page +
    pixel of its number (`authorized-ctwa-destination.ts`, CAPI
    `pagePixelDestination`, send-time re-verification in
    `ConversionEventsService`), using only the scopes of the existing Meta
    login (`business_management` + `ads_read`/`ads_management`). The SaaS
    WhatsApp destination binding (`MetaConversionDestination.whatsappBinding`,
    `whatsapp_business_management` / `whatsapp_business_manage_events`) is
    not ported. The path is reachable from Unnichat (4b) and CRMs (4c);
    Umbler, Gupshup, Data Crazy, Cloud API, Uazapi and Kommo keep requiring
    a known ad.
  - **`ProviderPurchaseClaim`** (one winner per sale and effect mode, with a
    send outbox recovered every minute) and
    **`InboundWebhookChannel.metaRoutingMode`** (`inherit_workspace` /
    `channel_override`; existing numbers stay `NULL` = legacy, new ones
    default to `inherit_workspace`), plus the effective Meta routing,
    purchase identity and purchase routing helpers used by Payt/Unnichat.
  - **Brazilian phone forms** in the paid-lead resolver, used by **every
    provider rule** (Umbler, Gupshup, Data Crazy, Meta Cloud, Uazapi), not
    only purchases: exact match first, then with/without `55` and the mobile
    9th digit; two leads stay ambiguous. Conversions that were lost because
    of a phone-format difference may now be sent (same as the SaaS).
  - Certification also lets an owner authorize the **controlled replay** of a
    Gupshup/Umbler/Data Crazy connection still in observation.
  - Migrations (additive, in order): `20261016090000_conversion_event_log_workspace_id_key`
    (unique index on `ConversionEventLog(workspaceId, id)`, alone in its
    migration; blocks conversion writes while it builds, ~2.6 s for 1M rows
    in a scratch database), `20261016090100_provider_purchase_claim`,
    `20261016090200_inbound_webhook_meta_routing_mode`,
    `20261016090300_validated_parser_certification`. Back up the database
    before updating. **Roll back:** revert the API image; the new
    table/columns are harmless to it (optional SQL in
    `docs/releases/unreleased.json`).
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

- **Multi-client backoffice** (workspaces, manual activation links, entry action, workspace ID, deletion with confirmation): [#26](https://github.com/samoskito/nod-rastrackdash-wpp/pull/26), [#36](https://github.com/samoskito/nod-rastrackdash-wpp/pull/36), [#44](https://github.com/samoskito/nod-rastrackdash-wpp/pull/44), [#46](https://github.com/samoskito/nod-rastrackdash-wpp/pull/46), [#47](https://github.com/samoskito/nod-rastrackdash-wpp/pull/47)
- **Per-workspace WhatsApp connections** (Uazapi/WAHA/Z-API) with their own webhook receiver, editing, deletion of unused connections and backoffice webhook history; WAHA and Z-API inbound parsers: [#35](https://github.com/samoskito/nod-rastrackdash-wpp/pull/35), [#37](https://github.com/samoskito/nod-rastrackdash-wpp/pull/37), [#38](https://github.com/samoskito/nod-rastrackdash-wpp/pull/38), [#52](https://github.com/samoskito/nod-rastrackdash-wpp/pull/52)
- **Secure external database connectors**: [#43](https://github.com/samoskito/nod-rastrackdash-wpp/pull/43)
- **Meta WhatsApp Cloud API** webhook handshake and CTWA parsing: [#53](https://github.com/samoskito/nod-rastrackdash-wpp/pull/53), [#55](https://github.com/samoskito/nod-rastrackdash-wpp/pull/55)
- **Meta initial sync** period resolved from the earliest connected WhatsApp source: [#58](https://github.com/samoskito/nod-rastrackdash-wpp/pull/58)
- **Installed version in the backoffice** and the live-instance update guide (`docs/setup/update.md`): [#60](https://github.com/samoskito/nod-rastrackdash-wpp/pull/60), [#61](https://github.com/samoskito/nod-rastrackdash-wpp/pull/61)
- **Reports**: global column sorting and deterministic insights: [#63](https://github.com/samoskito/nod-rastrackdash-wpp/pull/63), [#64](https://github.com/samoskito/nod-rastrackdash-wpp/pull/64)
- **Kommo CRM stage conversions** with audited UI: [#65](https://github.com/samoskito/nod-rastrackdash-wpp/pull/65)
- **Owners can retry blocked Meta CAPI events** (Reenviar / Reenviar bloqueados): [#69](https://github.com/samoskito/nod-rastrackdash-wpp/pull/69)

### Fixed

- **Textos da tela com acentuação corrigida** (web e mensagens da API; cabeçalhos de CSV e rótulos do pacote shared ficam como estavam).

- **"Todos os números" rules now send (API, shared and web)**, ported from
  the SaaS #152 (merge `b7fbd552`: `d3be95b`, `57e0b6e`, `5f5e7af`, `5df9130`, `90e5cfd`,
  `5f13151`, `6cbdac7`, `394cbb9`, `5c1d209`, `8fe8e9f`, `1882cb2`, `b0df0a4`,
  adapted to the student edition). Cause: `activateScopedProduction` returned
  early for `all_numbers`, so the QR bridge stayed in observation and every
  decision was blocked with `connection_not_production` (a QR-code phrase
  rule with the default "Todos os números" never sent).
  - **Number activation:** creating a production global rule, turning
    "Envio ativo" on, editing a rule into all numbers or "Unificar" now
    promotes every covered number (connection to production, channel
    active), each one in its own transaction after the rule commit, with
    audit (`provider_conversion_rule.global_numbers_activated`). One failing
    number never rolls back the rule nor the other numbers.
  - **Student edition instead of "paid seat":** there are no seats or charges
    per number here. The conditions are the usable license (every write
    answers `423` while it is locked and the automatic activation skips its
    run) and, for QR numbers, the WhatsApp connection (`WhatsappInstance`)
    being `active`, i.e. not suspended/removed in Integrações (this edition
    only writes `active`/`suspended`; a suspended one is out of the rule
    scope, any other status is `whatsapp_connection_inactive`). The QR
    session itself is not checked: it only shows in the health check
    (`lastHealthStatus`), which may be stale, so it never blocks. The Meta-route rules of the Integrations buttons
    still apply (`meta_route_missing`). Paused connections
    (`connection_paused`) and channels are never resumed by a rule.
  - **Pending numbers:** `pendingNumbers` (with the reason) on every active
    "all numbers" rule; Conversões shows "Esta regra ainda não envia eventos
    em N números" with **"Ativar envio neste número"** (new
    `POST /conversion-rules/providers/:id/numbers/:channelId/activate`) or
    **"Resolver em Integrações"**.
  - **Automatic activation of numbers connected later** (system actor):
    `GlobalRuleAutoActivationService` reacts to the new durable bridge event
    `inbound_webhook.uazapi_bridge_provisioned` and reconciles hourly; only
    numbers that were never live (an operator's promote/observation/pause
    decision is respected), with a 6 h backoff for failures that follows the
    latest real attempt (kept in memory, so repeated failures do not flood the
    audit), one instance at a time (advisory lock) and a time budget also
    checked inside each workspace (it stops before the lock timeout). The
    hourly reconciliation runs per API instance (serialized, idempotent).
  - **"Reprocessar bloqueadas"** in the executions modal (new
    `POST /conversion-rules/providers/:id/reprocess-blocked`): resends, once,
    the QR conversations of the last 7 days (Meta window, minus 1 h) blocked
    only because the number was not live; older ones are shown as expired.
    Conversations of a period an operator paused or held back are never
    resent; on purpose more conservative than the SaaS: any earlier
    promotion/pause/observation of the connection, or pause of the channel,
    before the conversation keeps it out, even an old one. Idempotent (frozen decision, upsert, job id = execution id),
    restricted to the workspace, advisory lock + 30 s cooldown, batches of 50.
  - **Migration** `20261022120000_provider_rule_blocked_reprocess_index`
    (additive: one `CREATE INDEX CONCURRENTLY IF NOT EXISTS` on
    `ProviderConversionRuleExecution` for the panel count and the reprocess
    scan; a single statement, so Prisma runs it outside a transaction, like
    `20260709233000_lead_ctwa_index_concurrently`). An interrupted build may
    leave an INVALID index: check `pg_index.indisvalid`, then
    `DROP INDEX CONCURRENTLY IF EXISTS` and recreate (see the release notes).
  - The web keeps the API error `code` (`ApiRequestError.code`, merged into
    `lib/server-api.ts`), so "Reprocessar bloqueadas" maps
    `provider_rule_reprocess_in_progress` by code, not by message text.
  - Execution and purchase-review reasons with Portuguese accents.
  - Not ported (separate SaaS features, not fixes of this area): #153
    (one conversion per lead across numbers) and #155 (Lead recebido sent by
    the rule, behind a flag), which also touch the reprocess.

- **Fase 5.0 — Payt fixes (API only)**, ported from the SaaS (`d88fc6c`,
  `f5f535b`, `6f5fcf0`, `4ca665b`, `608ec47`, `1d65161`):
  - **Sale value without installment interest.** A Payt Purchase now uses
    `transaction.price_without_installments` (already includes order bumps);
    `total_price` (with card interest) is only the fallback. **Effect on the
    next purchases:** an installment card sale is recorded and sent to Meta
    with a lower value than before (e.g. R$ 247,00 instead of R$ 297,60 in
    12x). In the observed cases (installment card sales) the value becomes
    the product price without interest; other payment methods read the same
    Payt field (not validated for each of them). A decision frozen
    with the old value and not sent yet travels corrected (same `event_id`,
    no double send, `sourcePayload.valueCorrection`).
  - **Backfill of sales already recorded** (optional, run right after the
    update: stored bodies expire in ~7 days):
    `pnpm --filter @wpptrack/api payt:value-backfill -- --limit 200` (dry-run),
    then `... --apply --actor-email <platform owner>` and `--after <nextCursor>`
    until it is `null`. Only conversions **proven not to have reached Meta**
    (refused, not configured, skipped, pending) are corrected; sent,
    dispatching, unknown-outcome (`deliveryUnknown`) and queued (`queued`,
    run again once the queue is empty) ones never change, and nothing is
    resent. Steps in `docs/setup/payt.md`.
  - **Resend with a different body.** The same Payt order resent with a
    changed body no longer fails as `provider_conversion_source_event_mismatch`;
    a sale that failed that way is recoverable (Reprocessar, or a new Payt
    resend). Still one conversion per sale.
  - No migration, no new env var, no new dependency. **Roll back:** redeploy
    the previous API image; values corrected by the backfill stay corrected
    (previous value kept in `sourcePayload.valueCorrection` and in the audit
    log).
- **Kommo destination pinned to the official number the lead arrived on**:
  in `resolveLeadDestination` (`apps/api/src/kommo/kommo.service.ts`), an
  official-API lead (no WhatsApp instance) now reuses an inbound route only
  from the channels of its materialized entry receipt of the same click
  (`crmLeadEntryChannelIds`), instead of any official channel of the
  workspace. With more than one official-API number, a Kommo purchase only
  uses the destination of the number the lead arrived on. The PR #67 fallback
  (unique destination of the ad's account) stays; Uazapi leads are unchanged;
  no unique match still blocks with `lead_destination_unproven`. Pipedrive
  has no inbound-route fallback and is unaffected.
- **Workspace deletion order**: `apps/api/scripts/delete-workspace.js` now
  deletes rule-create claims, purchase claims, Kommo tables and Uazapi chat
  labels before their parents, and fixes the catalog → rule and ad
  destination → ad order (static test against `schema.prisma`, run on a
  scratch database). The backoffice deletion also removes purchase claims.
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
