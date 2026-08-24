# Setup guides

Índice dos guias de instalação do RastrackDash (edição aluno / self-host).

> Template público sanitizado (G4+) com license **client**, multi-provider WhatsApp, whitelabel e backoffice simplificado já no código. O **license server** PalmUP continua privado e fora deste repo.

## Atalho

```bash
pnpm setup          # scripts/setup.mjs — .env, install, prisma, checklist final
pnpm setup -- --dry-run
```

## Ordem recomendada

1. [VPS](./vps.md) — dimensionamento e perguntas (clientes / leads/dia)
2. `pnpm setup` ou cópia manual de `.env.example` → `.env` (preencher `replace-me-*`)
3. Banco + migrations (`prisma migrate deploy` / `dev`)
4. **License client** — `LICENSE_SERVER_URL`, `LICENSE_KEY`, `LICENSE_ACCOUNT_IDENTITY` → conferir `/backoffice/license`
5. Admin boot + primeiro workspace/cliente
6. [Meta manual](./meta-manual.md) (System User)
7. WhatsApp: Uazapi BYO / NOD API / WAHA / Z-API (ver `.env.example` e `apps/api/src/integrations/whatsapp-providers/README.md`)
8. Whitelabel opcional: `BRAND_*` (footer residual não removível)
9. Deploy Dokploy (API) + Vercel (web)
10. [Billing guia](./billing/README.md) — opcional, gateway BYO do aluno

## Checklist in-app

Com a API no ar e sessão autenticada, `/backoffice` mostra o checklist real:

- banco conectado
- licença utilizável
- Meta conectado (workspace atual)
- pelo menos um workspace

API: `GET /onboarding/status` (auth required).

## AI-first

Peça a uma IA (Claude Code, Codex, Grok) para ler `AGENTS.md` / `docs/AI_AGENTS.md` e conduzir estes passos com verificação a cada etapa.

## Release

- [Acceptance matrix v1](../release/ACCEPTANCE-v1.md)
- [Changelog](../../CHANGELOG.md)
- [Tagging v1.0.0](../release/TAGGING.md) (human gate)
- [PalmUP license ops runbook](../ops/palmup-license-runbook.md)
