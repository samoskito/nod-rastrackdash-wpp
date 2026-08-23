# WhatsApp provider registry (F5)

F5 plan: multi-provider WhatsApp connectivity behind one registry, so the
product can plug in different WhatsApp backends per workspace without
rewriting call sites each time.

## Providers

| id          | status (F5.1)             | slice   |
|-------------|----------------------------|---------|
| `uazapi_byo`| **implemented, registered**| F5.1    |
| `nod_api`   | stub only, not registered  | F5.3 (private repo broker) |
| `waha`      | stub only, not registered  | F5.4    |
| `zapi`      | stub only, not registered  | F5.5    |

Only `uazapi_byo` is registered in `WhatsappProvidersModule` today
(`WhatsappProvidersBootstrapService`). The other three exist as real
classes under `./stubs/` that already implement `WhatsappProviderAdapter`
so the later slices can register them by adding one line to the bootstrap
service — but they are **not** wired in, so nothing in the app can
accidentally call a broken provider. Their `getHealth()` returns
`{ status: "disconnected", message: "not_implemented" }`; every other
method throws `NotImplementedException`.

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
