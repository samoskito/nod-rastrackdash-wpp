# WhatsApp provider registry (F5)

F5 plan: multi-provider WhatsApp connectivity behind one registry, so the
product can plug in different WhatsApp backends per workspace without
rewriting call sites each time.

## Providers

| id          | status                      | slice   |
|-------------|------------------------------|---------|
| `uazapi_byo`| **implemented, registered** | F5.1    |
| `nod_api`   | **implemented, registered** | F5.3b (private repo broker) |
| `waha`      | **implemented, registered, BYO** | F5.4 |
| `zapi`      | **implemented, registered, BYO** | F5.5 |

All four providers are registered in `WhatsappProvidersModule` today
(`WhatsappProvidersBootstrapService`), unconditionally — an unconfigured
provider still shows up in the registry and reports `disconnected` health
instead of being silently absent. No stub adapters remain as of F5.5.

### `waha` (F5.4) — BYO self-hosted WAHA

Pure BYO: the student runs their own [WAHA](https://github.com/devlikeape/waha)
instance and this adapter talks to it directly — no PalmUP broker, no
admin tokens.

Contract:
```
GET {WAHA_BASE_URL}/api/sessions/{WAHA_SESSION}
Header: X-Api-Key: {WAHA_API_KEY}
```

Env vars: `WAHA_BASE_URL`, `WAHA_API_KEY`, `WAHA_SESSION` (default
`"default"`). Missing `WAHA_BASE_URL`/`WAHA_API_KEY` → `getHealth()`
reports `disconnected` with a clear message (never throws). Session
status is mapped to `IntegrationStatus`:

| WAHA status      | `IntegrationStatus`  |
|------------------|-----------------------|
| `WORKING` / `authenticated` | `connected`   |
| `SCAN_QR_CODE`   | `needs_reconnect`      |
| `STOPPED`        | `disconnected`         |
| `FAILED` / other / HTTP error / network error | `error` |

`listLabels` is intentionally left `undefined` — WAHA has no Uazapi-style
label catalog. **Inbound webhook parsing for WAHA events is out of scope
for F5.4** — see the F5.6 / follow-up slice; existing inbound providers
(uazapi) are untouched by this change.

### `zapi` (F5.5) — BYO Z-API instance

Pure BYO: the student runs (or subscribes to) their own
[Z-API](https://www.z-api.io/) instance and this adapter talks to it
directly — no PalmUP broker, no admin tokens.

Contract:
```
GET {ZAPI_BASE_URL}/instances/{ZAPI_INSTANCE_ID}/token/{ZAPI_TOKEN}/status
```

Env vars: `ZAPI_BASE_URL`, `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`. Missing any of
the three → `getHealth()` reports `disconnected` with a clear message
(never throws). Z-API's documented response field names vary slightly
across their docs/versions, so the response is read defensively — the
boolean `connected` field is the primary signal, with `state`/`status`
strings used only to detect a pending-QR hint when disconnected:

| Response shape                                   | `IntegrationStatus`  |
|---------------------------------------------------|-----------------------|
| `connected: true`                                  | `connected`            |
| `connected: false` + `state`/`status` matching `/qr/i` (e.g. `"qrCode"`, `"pendingQR"`) | `needs_reconnect` |
| `connected: false`, no qr hint                     | `disconnected`         |
| HTTP non-2xx / network error                       | `error`                |

`listLabels` is intentionally left `undefined` — Z-API has no
Uazapi-style label catalog. **Inbound webhook parsing for Z-API events is
out of scope for F5.5** — see the F5.6 / follow-up slice; existing
inbound providers (uazapi) are untouched by this change.

## Interface

`WhatsappProviderAdapter` (see `whatsapp-provider.types.ts`) is
deliberately thin — it was extracted from the *actual* call sites of
`UazapiAdapter` (`integrations.service.ts`, `uazapi-provider-conversion.service.ts`),
not invented up front:

- `readonly id: WhatsappProviderId` — required, used by the registry key.
- `getHealth(): Promise<WhatsappProviderHealthDto>` — required; the only
  method every current caller needs (`IntegrationsService.getHealthSummary`).
- `listLabels?(instanceRef, instanceToken?): Promise<WhatsappLabelListResult>`
  — optional; only `uazapi-provider-conversion.service.ts` calls it today,
  and only against Uazapi.

Methods like `sendText`, `getQr`, `connectInstance`, `createInstance` are
**not** on the interface yet — nothing outside `UazapiAdapter` calls them
today. Add them when a real caller needs them from more than one provider,
to keep the interface from becoming an unused superset.

## Adding a provider

1. Implement `WhatsappProviderAdapter` for the new backend (HTTP calls,
   config validation, etc.) — add its config shape to
   `whatsapp-provider.types.ts` first.
2. Register it in `WhatsappProvidersBootstrapService.onModuleInit()`.
3. Only then does `WhatsappProviderRegistry.get(id)` start returning it —
   until that point `get()`/`require()` treat it as absent, not broken.

## Out of scope for F5.1

- Per-workspace provider selection UI.
- Disconnect alert port (F5.7).
- Inbound WAHA/Z-API webhook parser (deferred past F5.4/F5.5 — see F5.6 /
  follow-up).

## F5.2: call sites now route through the registry

`IntegrationsService.getHealthSummary()` and
`UazapiProviderConversionService.listLabelCatalog()` (in
`inbound-webhooks/uazapi-provider-conversion.service.ts`) no longer inject
`UazapiAdapter` directly — both resolve `registry.require("uazapi_byo")`
and call `getHealth()` / `listLabels()` off the returned adapter. The
health summary now reports provider id **`uazapi_byo`** (not the legacy
`"uazapi"`) — `@wpptrack/shared`'s `integrationProviderSchema` was widened
to accept both.

`InboundWebhooksModule` imports `WhatsappProvidersModule` for this (it no
longer declares its own separate `UazapiAdapter` provider). A student
running this edition only needs to configure `UAZAPI_BASE_URL` and
`UAZAPI_TOKEN` (your own Uazapi instance token — never a PalmUP admin
fleet token); there is no `UAZAPI_ADMIN_TOKEN` anywhere in this repo, and
`UazapiAdapter.createInstance()` stays a stub that returns
`not_configured` in the BYO edition.

## F5.6: inbound webhook parsers — how to plug a new provider

Inbound webhooks flow through `InboundWebhookParserRegistry`
(`apps/api/src/inbound-webhooks/providers/inbound-webhook-parser.registry.ts`).
Registered parsers:

| provider | parser | notes |
|---|---|---|
| `umbler` | `umbler-v1` | legacy inbound |
| `gupshup` | `gupshup-v1` | legacy inbound |
| `waha`   | `waha-v1`   | F5.6 — see `providers/waha/waha-v1.parser.ts` |
| `zapi`   | `zapi-v1`   | F5.6 — see `providers/zapi/zapi-v1.parser.ts` |

### Classification choices (v1)

- `fromMe: true` → `ignored_outbound`
- group chat (`@g.us` / `isGroup`) → `unsupported_event` ("groups not supported in v1")
- inbound without CTWA fields → `eligible_route_unresolved` (reason `no_ctwa_in_{waha,zapi}_payload`)
- CTWA object/`ad_id` present → `hasCtwa = true` + route resolution pending
- non-`message` events (WAHA `message ACK` etc.) → `unsupported_event`
- malformed payload → delivery-level `invalid_payload` error

### How to add a parser

1. Create `providers/<name>/<name>-v1.parser.ts` implementing `InboundWebhookParser`
   (`provider`, `parserVersion`, `parse(payload): InboundWebhookParserResult`) —
   mirror `waha-v1.parser.ts` for JID normalization and classification handling.
2. Add it to `defaultParsers()` in `inbound-webhook-parser.registry.ts`.
3. Add payload tests under `apps/api/test/inbound-webhooks/providers/`.
4. Update the table above.

Example WAHA payload (message, inbound):

```json
{ "event": "message", "session": "default",
  "payload": { "from": "5511999999999@c.us", "to": "5521888888888@c.us",
               "timestamp": 1724400000, "fromMe": false, "type": "chat",
               "body": "olá, vi o anúncio" } }
```

Example Z-API payload:

```json
{ "phone": "5511999999999", "message": "olá, vi o anúncio",
  "connectedPhone": "5521888888888", "instanceId": "3CXY25DZSUKAPXJYHUGA",
  "messageId": "3EB0D7...", "timestamp": 1724400000, "fromMe": false,
  "isGroup": false }
```
