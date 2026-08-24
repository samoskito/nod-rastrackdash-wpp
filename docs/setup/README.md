# Guias de instalação

Índice central dos guias de instalação do RastrackDash (edição aluno / self-host).

> Template público sanitizado (G4+) com cliente de **licença**, múltiplos provedores WhatsApp, personalização de marca e backoffice simplificado já no código. O **servidor de licenças** PalmUP continua privado e fora deste repositório.

Comece pelo [README do aluno em pt-BR](../../README.pt-BR.md) e pelo [prompt oficial de onboarding com IA](../AI_ONBOARDING_PROMPT.pt-BR.md) se for usar Claude Code/Codex para guiar a instalação. Para a narrativa completa da compra ao primeiro workspace, veja o [Guia do Aluno](../GUIA-ALUNO.md).

## Atalho

```bash
pnpm setup          # scripts/setup.mjs — .env, install, prisma, checklist final
pnpm setup -- --dry-run
```

## Escolha seu caminho

| Caminho | Quando usar | Guia |
|---|---|---|
| **Local (Docker Compose)** | Desenvolver, homologar, conhecer o produto antes de decidir a VPS | [`local.md`](local.md) |
| **VPS com Dokploy** | Deploy real da API/banco/Redis para uso com clientes | [`dokploy.md`](dokploy.md) (dimensionamento em [`vps.md`](vps.md)) |

Os dois caminhos convergem nos mesmos passos de produto: licença, admin, workspace, Meta, WhatsApp, marca.

## Ordem recomendada

1. Escolha o caminho acima ([`local.md`](local.md) ou [`vps.md`](vps.md) → [`dokploy.md`](dokploy.md)).
2. `pnpm setup` ou cópia manual de `.env.example` → `.env` (preencher `replace-me-*`) — veja a tabela completa em [`environment.md`](environment.md).
3. Banco + migrations (`prisma migrate deploy` / `dev`).
4. **Cliente de licença** — `LICENSE_SERVER_URL`, `LICENSE_KEY`, `LICENSE_ACCOUNT_IDENTITY` → confira `/backoffice/license`.
5. Crie o primeiro administrador e o primeiro workspace/cliente.
6. [Meta manual](meta-manual.md) (usuário do sistema).
7. WhatsApp: Uazapi BYO / NOD API / WAHA / Z-API (consulte [`environment.md`](environment.md) e `apps/api/src/integrations/whatsapp-providers/README.md`).
8. Personalização de marca opcional: `BRAND_*` (rodapé residual não removível).
9. Deploy Dokploy (API) + Vercel (web) — ou permaneça local.
10. [Guia de cobrança](billing/README.md) — opcional, gateway BYO do aluno.

Algo deu errado em qualquer passo? Vá direto para [`troubleshooting.md`](troubleshooting.md).

## Checklist in-app

Com a API no ar e sessão autenticada, `/backoffice` mostra o checklist real:

- banco conectado
- licença utilizável
- Meta conectado (workspace atual)
- pelo menos um workspace

API: `GET /onboarding/status` (autenticação obrigatória).

## IA como ponto de partida

Cole o [prompt oficial de onboarding](../AI_ONBOARDING_PROMPT.pt-BR.md) em Claude Code, Codex ou outra IA para conduzir estes passos com explicação e verificação a cada etapa, sem nunca manusear seus segredos.

## Referência

- [Guia do Aluno — da compra ao primeiro workspace](../GUIA-ALUNO.md)
- [Local (Docker Compose)](local.md)
- [VPS — dimensionamento](vps.md) · [Deploy com Dokploy](dokploy.md)
- [Variáveis de ambiente](environment.md)
- [Troubleshooting](troubleshooting.md)
- [Meta manual](meta-manual.md)
- [Guia de cobrança (BYO)](billing/README.md)

## Release

- [Matriz de aceite v1 (pt-BR)](../release/ACCEPTANCE-v1.pt-BR.md) · [English](../release/ACCEPTANCE-v1.md)
- [Changelog (EN)](../../CHANGELOG.md)
- [Tagging v1.0.0](../release/TAGGING.md) (etapa manual)
- [Runbook operacional de licenças PalmUP](../ops/palmup-license-runbook.md)
