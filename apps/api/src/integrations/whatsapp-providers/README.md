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
| `zapi`      | stub only, not registered   | F5.5    |

`uazapi_byo`, `nod_api` and `waha` are registered in
`WhatsappProvidersModule` today (`WhatsappProvidersBootstrapService`), all
unconditionally — an unconfigured provider still shows up in the registry
and reports `disconnected` health instead of being silently absent.
`zapi` exists as a real class under `./stubs/` that already implements
`WhatsappProviderAdapter` so a later slice can register it by adding one
line to the bootstrap service — but it is **not** wired in, so nothing in
the app can accidentally call a broken provider. Its `getHealth()` returns
`{ status: "disconnected", message: "not_implemented" }`; every other
method throws `NotImplementedException`.

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

1. Give the stub class in `./stubs/` a real implementation (HTTP calls,
   config validation, etc.) — its config shape already exists in
   `whatsapp-provider.types.ts`.
2. Register it in `WhatsappProvidersBootstrapService.onModuleInit()`.
3. Only then does `WhatsappProviderRegistry.get(id)` start returning it —
   until that point `get()`/`require()` treat it as absent, not broken.

## Out of scope for F5.1

- Real HTTP for `nod_api`/`waha`/`zapi` (F5.3-F5.5).
- Per-workspace provider selection UI.
- Disconnect alert port (F5.7).
- Inbound WAHA webhook parser (deferred past F5.4 — see F5.6 / follow-up).

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
