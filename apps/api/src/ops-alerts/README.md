# Ops alerts

This module hosts two independent operational-alerting features that
happen to share a directory:

- **Per-workspace ops alerts** (`OpsAlertService`/`OpsAlertsController`/
  `OpsAlertNotifier`) — DB-backed (`WorkspaceOpsAlertSettings`), sends
  WhatsApp text messages to phone numbers a workspace manager configures,
  covers webhook silence + (currently stubbed) instance disconnects. Pre-
  existing feature, unrelated to F5.7 below.
- **WhatsApp provider disconnect alerts** (`WhatsappDisconnectAlertsService`,
  F5.7) — global, in-memory, watches the `WhatsappProviderRegistry`
  adapters (`uazapi_byo`/`nod_api`/`waha`/`zapi`) and logs + optionally
  POSTs a webhook when a provider's health stays `disconnected` for too
  long. This is the ops-facing "is any configured WhatsApp provider down"
  signal, independent of any single workspace.

The rest of this file documents the F5.7 feature.

## How it works

`WhatsappDisconnectAlertsService` follows the same template as
`MetaReportAutoSyncService` / `InboundWebhookMaintenanceService`: a plain
`setInterval` started from `OnModuleInit` and cleared in
`OnModuleDestroy` — no `@nestjs/schedule`.

On every tick (`runOnce()`), it iterates every adapter registered in
`WhatsappProviderRegistry` (`registry.list()` — all four providers are
always registered, even unconfigured ones) and evaluates each one
(`evaluateProviderHealth(providerId)`, exposed publicly so tests can call
it directly instead of racing the timer):

- `getHealth()` → `status === "connected"` — resets that provider's
  streak to zero.
- `status === "disconnected"` — increments the streak. Once the streak
  reaches the configured threshold (default 3 consecutive checks) **and**
  no alert has fired for the current streak yet, it alerts once.
- Any other status (`needs_reconnect`, `error`, `syncing`,
  `pending_payment`, a missing/unknown status, or `getHealth()` throwing)
  is **ambiguous**: it neither counts toward nor resets the streak (logged
  at `debug`). A single flaky check shouldn't erase real disconnect
  progress, but it also shouldn't count as a disconnect.

Once an alert has fired for a streak, the provider stays quiet on
subsequent disconnected checks — the next alert only fires after a
`connected` observation resets the streak and a fresh streak reaches the
threshold again.

### Alert action

1. `Logger.warn` (structured, greppable):
   ```
   whatsapp_disconnect_alert provider=<id> streak=<n> message=<health.message>
   ```
2. If `OPS_ALERT_WEBHOOK_URL` is set, `POST`s that URL with:
   ```json
   {
     "type": "whatsapp_disconnect",
     "provider": "uazapi_byo",
     "streak": 3,
     "message": "instance offline",
     "checkedAt": "2026-08-24T16:00:00.000Z"
   }
   ```
   Request has a 5s timeout (`AbortController`); a failed/timed-out
   webhook call is logged (`Logger.warn`) and never thrown — it can't
   crash the interval loop or block the next provider's check.

## In-memory limitation

Streaks live in a `Map<providerId, StreakState>` on the service instance
only. They **reset on process restart** (a provider that was 2/3 of the
way to alerting starts back at 0) and are **not shared** across multiple
API instances/replicas — each replica tracks and alerts independently.
This is intentional for this slice: no new DB table, no cross-instance
coordination. If that becomes a problem, persist `StreakState` per
provider (e.g. a small table or the existing
`WorkspaceOpsAlertDelivery`-style dedupe pattern) in a follow-up.

## Env vars

| Var | Default | Meaning |
|-----|---------|---------|
| `DISCONNECT_ALERTS_ENABLED` | `false` | Must be exactly `"true"` to start the interval. Anything else (including unset) leaves the service inert — it logs one line at boot and never calls `getHealth()`. |
| `DISCONNECT_ALERT_STREAK` | `3` | Consecutive `disconnected` checks required before alerting once. |
| `DISCONNECT_ALERT_INTERVAL_MS` | `900000` (15 min) | Interval between health-check sweeps. |
| `OPS_ALERT_WEBHOOK_URL` | unset | Optional. When unset, only the `Logger.warn` line fires — no HTTP call. |

See `.env.example` at the repo root for the same block with comments.
