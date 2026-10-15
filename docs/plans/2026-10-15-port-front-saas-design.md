# Port do front-end do SaaS para a edição de aluno — design aprovado

Data: 15/10/2026. Aprovado pelo Samuel em 15/10/2026.
Origem: `samoskito/dash-com-ia` (`docs/handoff/2026-10-15-front-para-repositorio-aluno.md`).
Acompanhamento: ClickUp → Geral → Student Rastrackdash Wpp → "Port front SaaS → aluno (out/2026)".

Objetivo: trazer a reorganização do front do SaaS (Hub de Integrações, Conversões, URL única,
leads novos × que voltaram, exportar leads) **adaptando** à edição de aluno — não copiar.

## Decisões aprovadas

| Tema | Decisão |
|---|---|
| Logos de terceiros | Podem ser distribuídos aos alunos (`apps/web/public/integrations/*` + `SOURCES.md`). |
| Payt e Unnichat | Vão para o aluno (provedores completos). |
| Pipedrive | Vai para o aluno. |
| Regra de conversão global | Sempre ligada, sem variável de ambiente. O aluno escolhe o alcance da regra (todos os números ou números específicos), igual ao SaaS. |
| Regras por número existentes | Mantidas; "Unificar" é oferecido, nunca forçado. |
| Sidebar | Continua fixa (`position: fixed; height: 100vh`). |
| Hub: abas (15/10) | 4 abas: **WhatsApp** (Uazapi, WAHA, WhatsApp Cloud API, Z-API e NOD API "Em breve"), **Atendimento e vendas** (Umbler, Gupshup, Data Crazy; Payt/Unnichat na Fase 4), **Anúncios** (Meta Ads), **CRM** (Kommo; Pipedrive na Fase 4). |
| Meta: dois conceitos (15/10) | **Meta Ads** (aba Anúncios) = login social/token para trazer dados de tráfego, cruzar com leads e enviar conversões; o login social é mantido. **WhatsApp Cloud API** (aba WhatsApp, logo da Meta) = webhook direto da Meta para receber as conversas. Nunca misturar os dois. |
| Z-API e NOD API (15/10) | "Em breve" no Hub. Parser Z-API será criado/validado quando o Samuel enviar payload real. |
| Logos (15/10) | Cloud API usa a logo da Meta; pesquisar logos oficiais de Uazapi e WAHA. |
| Acentuação (15/10) | Textos sem acento existentes ficam para uma revisão geral depois; texto novo já sai acentuado. |
| Assinatura (`/subscription`) | Não vai para o aluno (cobrança Asaas/vagas do SaaS). |
| Execução | Em fases; cada fase sai documentada para o aluno antes de seguir. |

## Fora do escopo (exclusivo do SaaS)

Asaas, vagas, trial, planos, nota fiscal, `/subscription`, `/billing/package/*`; backoffice do
SaaS (diagnósticos, certificação de parsers, replay); `license_claim_ledger` e broker Meta do
lado emissor; controller `nod-api` do SaaS; flags `INBOUND_CONVERSION_WORKSPACE_SCOPE_ENABLED`
e afins; ajustes de clientes específicos. O hotfix de miniaturas Meta (`f469460`) já está aqui.

## Regras de adaptação (valem para todas as fases)

1. **Licença e rodapé**: mesclar, nunca sobrescrever, `components/app-shell.tsx`,
   `app/(backoffice)/layout.tsx` e `components/brand-footer.tsx`. O rodapé
   `RastrackDash · powered by PalmUP` e o `brand.name` (whitelabel `BRAND_*`) ficam intactos.
2. **Soft-lock 423**: não trocar `lib/server-api.ts`, `lib/api.ts` e `(app)/layout.tsx` pelos do
   SaaS. Toda ação nova de escrita (criar/unificar regra, gerar/girar/desativar URL, conectar
   provedor) precisa mostrar o aviso de licença bloqueada quando a API responder 423.
3. **Migrations**: o histórico do aluno divergiu do SaaS (90 × 112). Não copiar pastas de
   migration. Escrever migrations novas, datadas depois de `20261005160000`, apenas aditivas
   (`CREATE TABLE`, `ADD COLUMN ... DEFAULT`, `DROP NOT NULL`, enum novo). CHECKs só depois de
   validar/normalizar os dados existentes na própria migration.
4. **Provedores do aluno**: o Hub e as regras usam o registro do aluno (`uazapi_byo`, `nod_api`,
   `waha`, `zapi`, `meta_cloud`, `umbler`, `gupshup`, `data_crazy`, `kommo` + os novos desta
   leva). Remover número usa o fluxo do provedor, não `/billing/package`.
5. **Notas para a comunidade** no mesmo commit: `docs/releases/unreleased.json` (consolidar,
   sem apagar o conteúdo pendente de Meta Cloud) e `CHANGELOG.md [Unreleased]`. Cada fase lista:
   benefício, mudanças, variáveis novas, `pnpm install` se houver dependência nova, migrations,
   ação manual do aluno, preservação de customizações, verificação e rollback. Nada de
   tag/Release/aviso sem autorização.
6. **Verificação por fase** (não há CI aqui): `pnpm --filter @wpptrack/api typecheck`,
   `pnpm --filter @wpptrack/api test`, `pnpm --filter @wpptrack/web typecheck`,
   `pnpm --filter @wpptrack/web test`; revisão independente (Opus) com veredito; prints
   desktop + 375px aprovados antes do push.

## Fases

### Fase 0 — Preparação
Este documento; linha de base de typecheck/testes; ClickUp.

### Fase 1 — Leads novos × que voltaram + exportar leads (1.4 + 1.5)
- API: `lead-cohort.ts` (primeiro contato em America/Sao_Paulo via `Lead.firstMessageAt`),
  CPL sobre leads novos, atribuição ao anúncio do primeiro contato; ajustes em
  `leads.service`, `meta-reporting.service`, `reporting-metrics.engine` (merge manual).
- API: `GET /leads/export?format=csv|xlsx` respeitando filtros/período, com data/hora de
  entrada, escondendo ids quando mascarados. Dependência nova `exceljs`.
- Shared: campos Zod de leads/relatórios, `lead-labels.ts`.
- Web: bloco "Leads no período" na Visão Geral, filtros em Leads, Relatórios, menu de exportar
  e `leads/export/route.ts`.
- Sem migration. Ação do aluno: `pnpm install` (exceljs) e redeploy.

### Fase 2 — Hub de Integrações (1.1)
- Web: `integrations/hub/*` (abas WhatsApp / Conversões e vendas / CRMs, cards com logo,
  estados Ativo/Disponível, modal por provedor), `components/modal.tsx`, logos.
- Kommo sai de Configurações e vai para o Hub; remover número QR passa para o Hub.
- Cards de Payt, Unnichat e Pipedrive entram nas fases em que o backend deles chega.
- Sem migration.

### Fase 3 — Tela Conversões (1.2)
- API: migration aditiva com `ProviderRuleCreateClaim` (se ausente), enum
  `ProviderConversionRuleScope (all_numbers | specific_numbers)`, colunas `scope` e
  `unifiedIntoProviderRuleId`, `connectionId`/`parserReleaseId` opcionais; serviço de escopo;
  endpoints `providers/capabilities`, `providers/unify-candidates`, `providers/unify`,
  `providers/create-receipt`; ingestão (uazapi_byo/nod_api/waha/zapi/meta_cloud) avalia regra
  global uma vez por número, e a regra específica sobrepõe a global (mesma origem + evento).
- Regra global sempre ligada; sem variável de ambiente.
- Web: `/conversions` (filtros, Nova regra em passos, Unificar, Eventos recebidos com
  reprocessar), item novo na sidebar, Configurações só com "Jornada".
- Ação do aluno: backup do banco antes de atualizar (migration roda no boot da API).

### Fase 4 — Provedores novos
- 4a **Payt** (parser + provedor de entrada; eventos Compra aprovada → `Purchase`,
  Pix/boleto gerado → `InitiateCheckout`, Carrinho abandonado (beta) → `CartAbandoned`).
- 4b **Unnichat** com modo de roteamento por número (`inherit_workspace` /
  `channel_override`), sem "BMs compartilhadas" (1.7).
- 4c **Pipedrive** (CRM; nova variável `PIPEDRIVE_CRM_ENCRYPTION_KEY`, gerada pelo próprio
  aluno no `.env` — documentar em `docs/setup/environment.md`).
- Cada subfase: migrations aditivas próprias, card no Hub, guia do aluno.

### Fase 5 — URL única por plataforma e URLs por evento (1.3)
- API: `IntegrationEndpoint` / `IntegrationEndpointEvent`, `productFilterCodes`,
  `publicUrlDisabledAt`, `InboundWebhookDelivery.integrationEndpointId`; controller
  `integrations/endpoints` (listar, criar, mostrar URL auditado, girar, desativar, produtos,
  vendas sem atribuição, reprocessar evento); rota pública nova.
- Web: painéis `single-url/*`, `conversions/rule-endpoint.tsx`.
- URLs antigas continuam funcionando até o aluno clicar "Desativar URL antiga".

## Fluxo de trabalho
Cada fase roda em worktree próprio (`.claude/worktrees/<fase>`), com Opus no backend e Sonnet
na UI; fases 1 e 2 podem correr em paralelo; 3 depois de 2; 4 depois de 3; 5 depois de 4a/4b.
