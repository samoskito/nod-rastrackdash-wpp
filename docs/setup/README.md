# Guias de instalação

Índice dos guias de instalação do RastrackDash (edição aluno / self-host).

> Template público sanitizado (G4+) com cliente de **licença**, múltiplos provedores WhatsApp, personalização de marca e backoffice simplificado já no código. O **servidor de licenças** PalmUP continua privado e fora deste repositório.

Comece pelo [README do aluno em pt-BR](../../README.pt-BR.md), que explica os papéis e as variáveis essenciais.

## Atalho

```bash
pnpm setup          # scripts/setup.mjs — .env, install, prisma, checklist final
pnpm setup -- --dry-run
```

## Ordem recomendada

1. [VPS](./vps.md) — dimensionamento e perguntas (clientes / leads/dia)
2. `pnpm setup` ou cópia manual de `.env.example` → `.env` (preencher `replace-me-*`)
3. Banco + migrations (`prisma migrate deploy` / `dev`)
4. **Cliente de licença** — `LICENSE_SERVER_URL`, `LICENSE_KEY`, `LICENSE_ACCOUNT_IDENTITY` → confira `/backoffice/license`
5. Crie o primeiro administrador e o primeiro workspace/cliente
6. [Meta manual](./meta-manual.md) (usuário do sistema)
7. WhatsApp: Uazapi BYO / NOD API / WAHA / Z-API (consulte `.env.example` e `apps/api/src/integrations/whatsapp-providers/README.md`)
8. Personalização de marca opcional: `BRAND_*` (rodapé residual não removível)
9. Deploy Dokploy (API) + Vercel (web)
10. [Guia de cobrança](./billing/README.md) — opcional, gateway BYO do aluno

## Checklist in-app

Com a API no ar e sessão autenticada, `/backoffice` mostra o checklist real:

- banco conectado
- licença utilizável
- Meta conectado (workspace atual)
- pelo menos um workspace

API: `GET /onboarding/status` (autenticação obrigatória).

## IA como ponto de partida

Peça a uma IA (Claude Code, Codex, Grok) para ler `AGENTS.md` / `docs/AI_AGENTS.md` e conduzir estes passos com verificação a cada etapa.

## Release

- [Matriz de aceite v1 (pt-BR)](../release/ACCEPTANCE-v1.pt-BR.md) · [English](../release/ACCEPTANCE-v1.md)
- [Changelog (EN)](../../CHANGELOG.md)
- [Tagging v1.0.0](../release/TAGGING.md) (etapa manual)
- [Runbook operacional de licenças PalmUP](../ops/palmup-license-runbook.md)
