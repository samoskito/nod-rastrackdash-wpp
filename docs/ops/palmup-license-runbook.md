# PalmUP license & NOD API ops runbook

Audience: **PalmUP operators** running the private license server and NOD API broker (`dash-com-ia`), supporting **public template** (`nod-rastrackdash-wpp`) consumers — students who self-host this repo.

No secrets, tokens, or internal admin URLs are included here. Where a path is "conceptual", it refers to the private `dash-com-ia` repo, out of scope for this public template.

## 1. License admin (issue / list / revoke)

These operations happen on the **private** `dash-com-ia` admin surface (spec §6.5), not in this public repo:

- **Issue**: created automatically by the Guru purchase webhook (spec §6.4), or manually by an operator for dev/homolog/support cases.
- **List**: internal admin view of `License` + `LicenseActivation` records — use it to see every device/instance that has activated a given key (binding is 1 license = 1 account, unlimited instances per account, spec §6.6).
- **Revoke**: manual revoke (refund, chargeback, abuse) flips the `License` state; the running student instance soft-locks on its **next successful check-in** (activate/heartbeat), even inside an active 72h grace window (spec §15).

Operators: always confirm the account identity on the license record before revoking — a revoke is enforced eagerly, so a wrong revoke locks a paying student's instance immediately.

## 2. Resend key (email / WhatsApp)

Key delivery happens after an approved Guru purchase (spec §6.7):

- Channels: **email** (via the existing outbound queue) and/or **WhatsApp** (outbound admin send, PalmUP-owned number).
- Failure to deliver **never blocks** `License` creation — the license exists and is activatable even if both delivery channels fail.
- The internal admin has a **resend** action for exactly this case.

Known pitfalls (high level, no secrets):

- Outbound email delivery depends on the DI/queue wiring in `dash-com-ia` being configured for the current environment (BYO Brevo/SMTP was generalized for the public template but the **notify path itself is private-side**, using PalmUP's own sending config).
- WhatsApp delivery depends on the PalmUP-owned admin WhatsApp connection being healthy; if it is disconnected, delivery silently degrades to email-only unless explicitly alerted.
- This program has previously hit a **prod notify-skip** issue (delivery silently not firing after a purchase). Do not assume delivery is green without checking recent logs/records before an incident review — see [`docs/release/ACCEPTANCE-v1.md`](../release/ACCEPTANCE-v1.md) (A1) for the current, honest status.

## 3. NOD API (broker-backed WhatsApp)

- The public template's `nod_api` adapter (`apps/api/src/integrations/whatsapp-providers/nod-api-whatsapp.adapter.ts`) is a **licensed add-on**: it only activates when the provider config carries a `nodApiEnabled` flag set to `true`.
- Requests are proxied through the private broker's `/nod-api/*` routes (`dash-com-ia`), authenticated using the student's `LICENSE_KEY` + device fingerprint — never `UAZAPI_ADMIN_TOKEN` (that credential must never appear in the student template).
- For a student to use `nod_api`, they need in their `.env`:
  - `LICENSE_SERVER_URL`, `LICENSE_KEY`, `LICENSE_ACCOUNT_IDENTITY` (license client)
  - `NOD_API_BROKER_URL` (points at the private broker, defaults to the same host as the license server)
- Prod broker health was confirmed reachable during this program via `GET /nod-api/health` returning `400` (not `404`) without auth — i.e., the route exists and correctly rejects unauthenticated calls. Re-verify this before relying on it for an incident.
- Toggling a student's NOD API entitlement (enabling/disabling the `nodApiEnabled` flag on their license/account) is an internal `dash-com-ia` admin action — conceptually a "set NOD API" toggle — out of scope for this repo.

## 4. Public-key / cacheToken contract

- The license server signs a compact cache token as **canonical UTF-8 JSON bytes** (deterministic key ordering, no whitespace variance) using its private signing key.
- The public client verifies that same signature over the same canonical UTF-8 JSON byte sequence, using the server's public key. A mismatch in how the bytes are constructed (e.g. re-serializing with different key order, or verifying over a string instead of the exact byte sequence) breaks verification even when the payload is semantically identical — this was the exact bug fixed in PR #3 (`ebfeb22`, "verify license cacheToken over canonical JSON bytes").
- Never change the canonical serialization on either side (server signing, client verifying) without changing both together and re-running the activation smoke test.

## 5. Soft-lock semantics (72h grace)

- On any successful `activate`/`heartbeat`, the client caches a signed token including status and `lastCheckedAt`.
- While `now - lastCheckedAt < 72h` (`LICENSE_GRACE_WINDOW_MS`), the app reports `grace` and stays **fully usable**, even if the license server is unreachable.
- Once `now - lastCheckedAt >= 72h` with no successful contact, the app reports `blocked` (soft-lock): **reads continue to work** (data already collected stays visible), **writes are blocked** — see `apps/api/src/licensing-client/license-softlock.guard.ts`.
- A revoked/expired license soft-locks on the **next successful** server contact, regardless of where the instance is inside its grace window — grace does not protect against an explicit revoke.
- A renewal approved on Guru clears the block automatically on the next successful check-in — no new key needed.

## 6. Incident: student's `activate` fails signature verification

1. Confirm the student is pointed at the correct `LICENSE_SERVER_URL` (typos happen; e.g. student environments sometimes vendor a stale/mirrored URL).
2. Confirm the license server's **public key** the client is verifying against matches the **current** signing key on the server (a key rotation on the server without a corresponding client update breaks every activation).
3. Confirm the compact-token contract (§4 above) hasn't drifted — e.g. a server-side change to how the cache token JSON is canonicalized without a matching client release.
4. Ask for the exact client error (`LicenseAccountMismatchError` vs. a raw signature-verify failure) — a `403`/`409` is account-mismatch (§6.6, expected behavior, not a bug), not a signature problem.
5. If it's genuinely a signature contract break, this is a **server-and-client-together** release, not a hotfix on one side alone — coordinate a fix on `dash-com-ia` and a new client PR on this repo.

## 7. Deploy notes

- The **private license/broker API** (`dash-com-ia`) needs its own redeploy for any change to license issuance, revocation, notify, or the NOD API broker — none of that ships from this repo.
- The **student template** is this repo (`nod-rastrackdash-wpp`); a student deploys their own instance (API + web) per [`docs/setup/README.md`](../setup/README.md). PalmUP does not operate student instances.
- Tagging a new template release here (`v1.0.0` and beyond) does **not** require a `dash-com-ia` deploy unless the release also changes the license-client protocol (§4/§6) — check the CHANGELOG's "Notes" section for any such coupling before tagging.

## Related documents

- [Acceptance matrix v1](../release/ACCEPTANCE-v1.md)
- [CHANGELOG](../../CHANGELOG.md)
- [TAGGING](../release/TAGGING.md)
- [Setup guides](../setup/README.md)
