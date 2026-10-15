# Integration logos — sources and usage

Logos shown on the Integrations hub cards (`/integrations`). Use is nominative:
each logo only identifies the platform the customer is connecting. Follow each
owner's guidelines — no recoloring, cropping, stretching or effects. Files were
sourced on 2026-10-14 (distribution to students approved by the maintainer on
2026-10-15), validated (magic bytes, < 200 KB) and, for SVG, sanitized (no
scripts, event handlers, foreignObject, external references or `@import`;
`viewBox` kept). The card puts dark-ink logos on a neutral light tile
(`logoSurface: "light"` in `hub/integration-registry.ts`) instead of recoloring
them.

To swap a file, keep the same name (or update `logoAssets` in the registry).
If a file is missing or fails to load, the hub shows the platform's initials
instead of a broken image.

| File | Source (official) | Notes |
| --- | --- | --- |
| `umbler.svg` | https://assets.umbler.com/site/shared/umblertalk.svg (Umbler Talk logo used on umbler.com) | Dark ink, shown on light tile. |
| `gupshup.svg` | https://gs-upload.gupshup.io/revamp/assets/v3/images/new-home-page/new-logo-gupshup.svg (gupshup.io header) | Guidelines: https://www.gupshup.io/resources/wp-content/uploads/2022/03/Gupshup-Brand-Guidelines-2022.pdf. Dark text, light tile. |
| `kommo.png` | https://www.kommo.com/static/images/pages/support/kommo-logo.png (1200x256) | Dark ink, light tile. No public brand kit found. |

## Plain wordmark fallbacks (official file not used)

| File | Reason |
| --- | --- |
| `datacrazy.svg` | datacrazy.io only serves a 175x59 WebP logo (below 256 px, not SVG/PNG). |
| `meta.svg` | Meta's brand resource center requires accepting its terms and Brand Review approval before use — the account owner must do this. |
| `meta-cloud.svg` | Same as Meta (WhatsApp Cloud API card). |
| `uazapi.svg`, `nod-api.svg`, `waha.svg`, `zapi.svg` | Self-hosted / API-first products without a public logo kit found; neutral wordmarks. |

Providers that arrive in later updates (Payt, Unnichat, Pipedrive, Go High Level)
add their own logo file and a row here.
