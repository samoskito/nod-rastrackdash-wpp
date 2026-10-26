# PLANO — Fase 6: paridade com o SaaS (dash-com-ia até #187)

> **Status: GATE 1 — AGUARDANDO APROVAÇÃO DO SAMUEL.** Nenhum código foi escrito.
>
> - Plano canônico de execução: `.hermes/plans/ACTIVE-STUDENT-EDITION-IMPROVEMENTS.md`. Este arquivo é o plano da fase. Quando a implementação começar, o ACTIVE recebe a linha "Fase 6" com o protocolo de status, conforme a seção "Protocolo de atualização".
> - Base do levantamento:
>   - nod `main` @ `e63e268` (1.2.0, #104);
>   - dash-com-ia `origin/main` @ `087df11b` (#187).
> - Data: 2026-10-26.
> - Escopo pedido pelo Samuel: levar para o nod tudo o que foi feito no dash-com-ia e afeta o uso dos alunos, sem meia-entrega e sem conflito. ROI Chat e Yampi entram por último. Cada fase é um PR testável.

## 0. Regras que valem para todas as subfases

- **Um escritor por worktree.** Branch `feat/fase-6.x-<slug>` a partir do `main` atualizado. Commit, push, PR e merge são gates separados.
- **Commits portados citados** no CHANGELOG ("ported from the SaaS (`hash`, …)"), como nas fases 4 e 5.
- **Nunca reintroduzir:**
  - billing, Asaas, Pix, assinatura, split ou nota fiscal;
  - vagas pagas (`WhatsappSeatProvider`, `package-billing.policy`);
  - o servidor de licença, a liberação de licença ou o WhatsApp da licença;
  - gates de integração privada (`*_WORKSPACE_IDS`, `WorkspacePrivateIntegration`).
- **"Vaga paga" no SaaS vira licença utilizável no nod.** Com a licença bloqueada, toda escrita responde 423 pelo guard global. Para números QR, vale também a conexão `WhatsappInstance` `active`. É a mesma tradução usada no porte do #152.
- **Pontos de adaptação obrigatórios no nod:**
  - a ponte WAHA (`waha:<canal>:<id>`, `inbound_webhook.waha_bridge_provisioned`);
  - Meta Cloud WABA (entrada CTWA `meta_cloud`);
  - o Reprocessar mais conservador do porte do #152.
- **Migrations:**
  - só aditivas e com nome;
  - timestamp **posterior a `20261022130100_waha_parser_release`** (a última do nod);
  - nunca reaproveitar timestamps do SaaS. O `20261022120000` do Brink Park no SaaS colide com o `20261022120000_provider_rule_blocked_reprocess_index` do nod.
- **Timestamps reservados na ordem das fases.** O executor ajusta para a data real, mantendo a ordem relativa, e sempre depois da maior migration existente no `main` naquele momento:

| Fase | Migration no nod (proposta) | Origem no SaaS |
|---|---|---|
| 6.1a | `20261027120000_provider_rule_cross_connection_scope` | `20261021120000_*` (#159) |
| 6.4 | `20261027130000_meta_creative_thumbnail` | `20261013200000_*` (918a0837) |
| 6.4 | `20261027130100_meta_reporting_sync_block` | `20261013210000_*` (c0cec66c) |
| 6.5 | `20261027140000_braip_provider` + `20261027140100_braip_parser_release` | `20261015200000/200100` |
| 6.6 | `20261027150000_hotmart_provider` + `20261027150100_hotmart_parser_release` | `20261025120000/120100` (#182) |
| 6.7 | `20261027160000_yampi_provider` + `20261027160100_yampi_parser_release` | `20261026120000/120100` (#186) |
| 6.8 | `20261027170000_roichat_provider` + `20261027170100_roichat_parser_releases` | `20261025150000/150100` (#183), **sem** `ALTER TYPE "WhatsappSeatProvider"` |

- **Notas de versão.** Cada PR atualiza `docs/releases/unreleased.json` (consolidado; sem versão inventada) e o `CHANGELOG.md` `[Unreleased]`, no mesmo PR do código. Toda subfase com migration pede backup do PostgreSQL antes do redeploy, conforme o Passo "Antes de começar" de `docs/setup/update.md`. Não há tag nem Release sem autorização.
- **Testes:** `pnpm typecheck` em api, web e shared, mais os testes do PR do SaaS adaptados aos caminhos do nod (`apps/api/test/<área>/…`, Vitest). As suítes de licença, onboarding e rodapé rodam sempre:
  - `apps/api/test/licensing-client/*`;
  - `apps/web/tests/brand-footer.test.ts`;
  - `app-layout.test.ts`;
  - `navigation.test.ts`.

  Há revisão independente antes do commit.
- **Antes da 6.0:**
  - decidir o PR #87 do nod (testes de web no Windows/EOL), que ajuda a rodar as suítes localmente. **PENDENTE:** conferir o conteúdo;
  - decidir o #77 (status do ACTIVE). O ACTIVE do `main` está desatualizado (parou em 04/09).

## 1. Inventário: dash-com-ia × nod

Legenda:
- **PORTAR:** igual ao SaaS, com caminhos do nod.
- **ADAPTAR:** muda comportamento ou estrutura para a edição do aluno.
- **NÃO SE APLICA**
- **JÁ NO NOD**

Tamanho: P até 1 dia, M de 2 a 3 dias, G 4 dias ou mais (execução, testes e revisão).

### 1.1 PRs #153–#187

| PR | Assunto | Classe | Motivo / adaptação | Fase | Tam. |
|---|---|---|---|---|---|
| #153 | Uma conversão por lead por pixel, entre números (`lead-lifetime-conversion-guard.ts`) | ADAPTAR | Incluir a ponte WAHA e a entrada CTWA do Meta Cloud no `leadLifetimeGuard`. Mesclar o resumo no Reprocessar conservador do nod | 6.0 | G |
| #154 | Validação CPF/CNPJ/CEP da cobrança | NÃO SE APLICA | Billing/Asaas: o nod não tem `src/billing` | — | — |
| #155 | "Lead recebido" pela regra (flag `LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED`, desligada) | ADAPTAR | Base de #158, #167, #175 e #183. O `auto_lead` do nod inclui WAHA e Meta Cloud | 6.2a | G |
| #156 | CSS da lista de Conversões | PORTAR | Depende do selo do #155 | 6.2a | P |
| #157 | Investimento e conversas da Meta respeitam o período | PORTAR | O bug existe no nod: `meta-reporting.service.ts` cai em `campaign.spendCents` | 6.3a | P/M |
| #158 | Conversão manual no lead (qualquer evento; compra com pedido) | ADAPTAR | Sem vaga: vale licença mais conexão ativa. Destinos para WAHA e Meta Cloud. **Substitui o PR #90 do nod** (ver §2) | 6.2a | G |
| #159 | Regra única por provedor, "todas as conexões" Unnichat/Umbler, "Número removido", reancoragem | ADAPTAR | Migration `crossConnectionScope`. O hunk de `lead-submitted-rule-override.ts` (do #155) fica para a 6.2a | 6.1a | G |
| #160 | Seção "URL antiga" sem rotação; rótulos com acento | PORTAR | Tirar os hunks de guimo se o arquivo não existir no nod | 6.1a | P |
| #161 | Excluir regras em lote; exclusão de regra de número removido | PORTAR | — | 6.1a | M |
| #162 | Brink Park | NÃO SE APLICA (decisão) | Plataforma exclusiva de um cliente do SaaS. Se o Samuel quiser, ADAPTAR sem o gate em fase extra | — | (M) |
| #163 | Integrações privadas por workspace | NÃO SE APLICA | No nod tudo é liberado. O ID do workspace no backoffice já existe (nod #44) | — | — |
| #164 | Plataforma na Nova regra sem números lidos; contagens reais na URL única | ADAPTAR | Só Payt, Braip, Hotmart e Yampi; ancorar também em conexão WAHA ou Meta Cloud | 6.5 | P |
| #165 | `/channels` por SQL agregado, sem carregar todo o histórico CTWA | PORTAR | Crítico em contas antigas. Incluir WAHA e Meta Cloud | 6.1b | M |
| #166 | Liberar leitor na regra; `assertCanReleaseIntegrations` | ADAPTAR | Permissão `platform_owner`/`platform_operator` da instalação. Depende da tela de leitores (b4d71afc) | 6.5 | M |
| #167 | Gráfico "Meta x conversas reais" | PORTAR | Depende do #155 | 6.3a | M |
| #168 | Leitor Braip conferido com o postback oficial | PORTAR | Junto com o Braip | 6.5 | P |
| #169 | "Ver dados recebidos" mascarado; liberar plataforma com venda sem atribuição | ADAPTAR | Permissão do aluno | 6.5 | M |
| #170 | Backoffice "Recebimentos das URLs únicas" | ADAPTAR | Sem o filtro de integração privada | 6.5 | M |
| #171 | Motivo de "em observação" visível; número com conexão em observação nas regras de plataforma | ADAPTAR | Os motivos "vaga" e "motor antigo" viram os do nod (licença, conexão). Depende de `provider-rule-scope` do #159 | 6.1b | M |
| #172 | Split e nota fiscal nas assinaturas | NÃO SE APLICA | Billing | — | — |
| #173 | Payt em hora de Brasília; `event_time` ≤ recebimento + 5 min | ADAPTAR | Criar `sao-paulo-timestamp.ts` e usar na Payt. A parte do Brink Park não se aplica. O `sales-platform-sale.ts` chega na 6.5 e passa a usar o mesmo leitor | 6.0 | P |
| #174 | Aviso de cobertura e atraso da sincronização Meta | PORTAR | Depende do #157 | 6.3a | P |
| #175 | Filtro por número conta conversas com Lead adiado | PORTAR | Depende de #155 e #167 | 6.3a | P |
| #176 | CRM Kanban; arrastar gera conversão | PORTAR | Depende de #158. Deps novas `@dnd-kit/core`, `@dnd-kit/utilities` e `@electric-sql/pglite` (testes). Mexe em navegação e app-shell: risco no rodapé | 6.2b | G |
| #177 | WhatsApp da licença: status e nova tentativa | NÃO SE APLICA | Servidor de licença | — | — |
| #178 | Filtro "WhatsApp com falha" | NÃO SE APLICA | Servidor de licença | — | — |
| #179 | "Bloqueado" sempre com motivo; `fn` com hash na CAPI | PORTAR | Depende do #165. Nova env `META_CAPI_SEND_FIRST_NAME` (desligada) | 6.1b | M |
| #180 | `fn` desligado por padrão | PORTAR | Junto com o #179 | 6.1b | P |
| #181 | "Reenviar bloqueados" reenvia falhas de login da Meta (190/102), janela de 7 dias | PORTAR | `conversion-event-retry.ts` já existe (nod #69). Kommo e Pipedrive ficam fora, como no SaaS | 6.0 | M |
| #182 | Hotmart na URL única | ADAPTAR | Renomear migrations; tirar `package-billing.policy` | 6.6 | M |
| #183 | ROI Chat (API oficial): entrada CTWA e compra pela regra | ADAPTAR | Liberado: sem `roichat-feature-gate` nem `private-integrations`, sem `ADD VALUE` em `WhatsappSeatProvider`, sem hunks de billing. Card no hub ao lado de WAHA e Meta Cloud | 6.8 | G |
| #184 | CSS do formulário de nova conexão | PORTAR | — | 6.5 | P |
| #185 | ROI Chat lê o objeto `anuncio` aninhado | PORTAR | Junto com o #183 | 6.8 | P |
| #186 | Yampi na URL única | ADAPTAR | Liberado: sem `private-sales-platform-gate` nem `yampi-feature-gate` | 6.7 | M |
| #187 | Yampi: produto pelo maior valor; tokens ocultos | PORTAR | Junto com o #186 | 6.7 | P |

### 1.2 Anteriores ao #152 que ainda não estão no nod

Conferido lendo o código do nod, não só os nomes de arquivo.

| Item SaaS | Estado no nod | Classe | Fase | Tam. |
|---|---|---|---|---|
| Braip (09d7303a, f83522af, 072bb61a, 25a7cd76, b3124d65) e a base `sales-platform-sale.ts` | Não portado (o shared só cita `braip` em teste de rejeição) | PORTAR | 6.5 | G |
| b4d71afc: tela de versões do leitor e certificação no backoffice | Não portado (o nod certifica por migration) | ADAPTAR | 6.5 | M |
| 7ac17df7: evento parado em `ready_to_send` há mais de 10 min pode ser reenviado (`isStalledReadyToSendConversionEvent`) | Parcial (`CTWA_SEND_SKIPPED` já veio) | PORTAR | 6.0 (mesmo arquivo do #181) | P |
| #106, #110, #114–#119: Visão Geral e Relatórios por campanha (multi) e por número WhatsApp, combobox com busca | Não portado | PORTAR | 6.3b | G |
| #121–#124: filtros aplicados automaticamente (Relatórios, Leads, Eventos, Revisão de compras) | Não portado (ainda há "Aplicar") | PORTAR | 6.3b | M |
| #125/#126: atividade da instância e leads por instância | Não portado | ADAPTAR (módulo de conexões por workspace; sem `schemas/billing`) | 6.3b | M |
| #103: estatísticas reais da Uazapi no resumo; #105: bloquear "Gerar nova URL" na Uazapi | Não portado | ADAPTAR (incluir a ponte WAHA) | 6.1b | P |
| e4139c4c: "valor corrigido (antes R$ X)" no backoffice | Parcial (o backend grava `valueCorrection`) | PORTAR | 6.3a | P |
| bb76b30e (mesmo estilo de select), e5ef9006 (totais por moeda empilhados, moeda nos exemplos) | Não portado | PORTAR | 6.3b | P |
| d4d70274: "Rotas manuais exigem ao menos uma rota" | Parcial | PORTAR | 6.1b | P |
| Robustez da Meta Graph: breaker de credencial, pausa por uso, dedupe e limite da sincronização (6a3f2c79, c0cec66c, c685ef66) | Não portado (o nod tem só "URGENT — fewer Meta Graph API calls") | PORTAR | 6.4 | G |
| Thumbnails salvos e renovação limitada (918a0837, f1ec6a9e; f44d4f98 = flag que já existe no nod) | Parcial | ADAPTAR (manter `META_VIDEO_THUMBNAILS_ENABLED`; ajustar `delete-workspace.js`) | 6.4 | M/G |
| Insights por anúncio, agregação local, páginas de 500, sincronização incremental (0f16c25c, 213047d3, bc72b208) | Não portado | PORTAR com flags | 6.4 | G |
| Micro-batching da CAPI (70625e41) | Não portado | PORTAR com flag desligada | 6.4 | M |
| #143: ordenação na API pelas etapas do funil | Parcial (só na web) | ADAPTAR, opcional | 6.3b | P/M |
| b65753b7: reenfileirar falhas transitórias de produção | Parcial | ADAPTAR, opcional (sem `external_channel_billing_*`) | 6.1b | P/M |
| #128–#133 GoHighLevel | Não portado (o teste do hub do nod exige GHL fora) | ADAPTAR, **opcional**: no SaaS é só observação e não envia nada à Meta | fora (decisão) | M |
| #120, #134–#142, #144, #148, #151, cc5412f0, 7ca3a69f/56f19a94/ed5fe229, correções Unnichat (b22b651e…), correções Payt CTWA (6f9c2297…), 0cffd7b8, 4b5e674a, #104 | **JÁ NO NOD** (fases 3 a 5, nod #63–#69) | — | — | — |
| #145–#147 (broker OAuth Meta), client-swap (#134/#135), 8094dbd7, todo billing/Pix/Asaas/assinatura, #107–#113 e #127/#149/#150 (licença e claim) | NÃO SE APLICA (lado SaaS, billing ou licença) | — | — | — |

## 2. Sobreposição com os PRs abertos do nod (#90, #91, #92)

Os três estão abertos desde 17/10, sem CI, `CONFLICTING` com o `main` (que avançou do #93 ao #104) e **empilhados**: o #92 contém o #91, que contém o #90. As migrations deles (`20261017090000_lead_manual_status`, `20261017100000_meta_lead_forms`) têm timestamp **anterior** às do `main` e precisam ser renomeadas se algum entrar.

| PR nod | Onde conflita | Recomendação |
|---|---|---|
| **#90** qualificação manual (`PATCH /leads/:id/status`, `QualifiedLead` com `event_id` `{ws}:{lead}:manual_status:QualifiedLead`, status travado) | **Arquivos:** `conversion-events.service.ts` (#153, #155, #158, #159, #181), `leads/[leadId]/page.tsx` e `actions.ts` (#158, #176), `app.module.ts`, `globals.css`, `shared/schemas/leads.ts`, `schema.prisma`. **Comportamento:** o #158 usa o `event_id` fixo do #153 (`lead_<evento>_<hash>`). O #90 usaria outro id, e uma regra de frase QualifiedLead mais o botão do #90 mandariam **dois eventos** à Meta sem dedupe. O status travado também concorre com o Kanban (#176) | **SUBSTITUIR** pelo #158 (6.2a) e pelo #176 (6.2b). Fechar sem mesclar. Se o Samuel quiser a auditoria "quem mudou o status", ela entra na 6.2a, com migration nova posterior |
| **#91** formulários Meta (Lead Ads): `MetaLeadFormConnection`, `leadgen` no `/webhooks/meta`, evento CRM `meta_lead_form_crm` | `conversion-events.service.ts`/`sendReadyEvent` (#181), `webhooks.controller.ts` (#155), `schema.prisma` (#159), `integrations/page.tsx` (cards da 6.5 a 6.8). O "Qualificado" depende do #90 | **ABSORVER depois do porte** (fase 6.9 própria): rebasear sem o #90, ligar o "Qualificado" ao #158/#176, renomear a migration e decidir se o `meta_lead_form_crm` entra no "Reenviar bloqueados" (#181) e no guard do #153 (outro dataset; declarar). Não mesclar antes |
| **#92** importação do Dashboard Leads (script Supabase; `ConversionEventLog` `imported`) | Depende das chaves do #90 e do #91 | **ABSORVER por último** (6.9b): gravar os QualifiedLead importados com a chave e o `event_id` do #158/#153, senão a automação reenvia. A criação de workspaces não conflita |

Se o import do #92 já rodou numa instalação local com as chaves do #90, essa instalação precisa de reconciliação de chaves antes da 6.2a. **PENDENTE:** confirmar com o Samuel se ela é de aluno real ou só de teste.

## 3. Fases (ordem por dependência; cada subfase = 1 PR)

Grafo resumido (A → B: B precisa de A):

```text
6.0 (#153, #181+7ac17df7, #173) → 6.1a (#159, #160, #161) → 6.1b (#171, #165→#179/#180, #103/#105, d4d70274)
6.0 → 6.2a (#155, #156, #158) → 6.2b (#176)
6.2a → 6.3a (#157→#174, #167→#175, e4139c4c) → 6.3b (filtros e auto-aplicar)
6.4 (Meta Graph) é independente; depois da 6.3a, porque os dois mexem em meta-reporting.service
6.0 (#173) + 6.2a (#158 hunk de compra) → 6.5 (base de plataformas, Braip, certificação, #164, #166, #169, #170, #184) → 6.6 Hotmart → 6.7 Yampi
6.0 + 6.1a + 6.2a + 6.5 (#170 schema/recibos) → 6.8 ROI Chat
tudo → 6.9 absorver #91 e #92 do nod
```

Mapeamento para o pedido original:
- Fase A = 6.0 + 6.1a + 6.1b;
- Fase B = 6.5 a 6.7;
- Fase C = 6.8.

O resto foi incluído pela mudança de escopo.

### 6.0 — Envio para a Meta: correções críticas (sem migration)

- **Itens:**
  - #153 (`972f6179`);
  - #181 (`4d2fbf83`) mais 7ac17df7 (parte do `ready_to_send` parado);
  - #173 (`a1b600c2`).
- **Arquivos do nod (equivalentes no SaaS):**
  - `apps/api/src/conversion-events/lead-lifetime-conversion-guard.ts` (novo);
  - `conversion-events.service.ts`;
  - `conversion-event-retry.ts`;
  - `meta-capi.adapter.ts`;
  - `conversion-rules/provider-conversion-decision.engine.ts`;
  - `provider-conversion-rules.service.ts`;
  - `provider-rule-blocked-reprocess.ts`;
  - `inbound-webhook-production/{provider-conversion-production,inbound-webhook-production}.service.ts`;
  - `ctwa-entry-materialization.ts`;
  - `inbound-webhook-replay.service.ts`;
  - `inbound-webhooks/provider-rule-blocked-reprocess.service.ts`;
  - `diagnostics/diagnostics.service.ts`;
  - `reporting/{meta-reporting.service,reporting.controller}.ts`;
  - `inbound-webhooks/providers/sao-paulo-timestamp.ts` (novo);
  - `providers/payt/payt-automation-v1.parser.ts`;
  - `inbound-conversion-automation-ingestion.service.ts`;
  - `integration-endpoints.service.ts`;
  - web: `conversions/{actions.ts,rule-executions.tsx}`, `settings/provider-conversion-labels.ts`, `events/{actions.ts,page.tsx,retry-blocked-events.tsx}`;
  - shared: `schemas/conversion-rules.ts`, `schemas/reporting.ts`.
- **Adaptações:**
  - o guard cobre a frase da ponte WAHA (`waha:` occurrences), a entrada CTWA do `meta_cloud` e a do Unnichat;
  - o resumo "já convertido por outro número" entra no Reprocessar conservador do nod sem relaxar as exclusões dele;
  - as variantes 55 e 9º dígito usam o `common/phone/phone-identity.ts` que já existe;
  - no #173, o `event_time` fica limitado a recebimento + 5 min na Payt; a parte do Brink Park não se aplica.
- **Testes a portar:**
  - `provider-conversion-cross-number-dedupe.test.ts` (22 casos, incluindo concorrência com lock);
  - deltas de `unnichat-ctwa-later-conversions` e `unnichat-page-pixel-no-ad`;
  - helper `first-entry-offline`;
  - web `provider-conversion-cross-number-label`;
  - `diagnostics-service`, `meta-capi-adapter`, `meta-reporting-service` e `reporting-controller` (deltas do #181), web `events-route`;
  - `payt-timestamp-timezone.test.ts`;
  - **novos no nod:** dedupe entre um número WAHA e um Uazapi; entrada Meta Cloud × frase.
- **Riscos:**
  - **licença:** reenviar é escrita, então 423 com licença bloqueada (guard global). Teste explícito;
  - **onboarding e rodapé:** sem impacto.
  - Risco funcional: o `event_id` fixo novo só vale para eventos novos; ids já enviados não mudam.
- **Notas:**
  - "Migration: não se aplica";
  - backup recomendado como rotina;
  - verificação: um lead em dois números gera um único QualifiedLead por pixel;
  - "Reenviar bloqueados" mostra falhas 190/102 dos últimos 7 dias;
  - carrinho Payt mostra a hora de Brasília.
- **Estimativa:** ~5 a 6 dias.

### 6.1a — Regra única por provedor (migration)

- **Itens:** #159 (`42ccbc7c`), #160 (`5141e217`), #161 (`0f6e010d`).
- **Migration:** `20261027120000_provider_rule_cross_connection_scope`: `ALTER TABLE "ProviderConversionRuleConfig" ADD COLUMN IF NOT EXISTS "crossConnectionScope" BOOLEAN;`. Nullable e instantânea. Nenhuma regra existente muda; elas ganham a nota "Ampliar para todas as conexões".
- **Arquivos:**
  - `schema.prisma`;
  - `conversion-rules/{provider-conversion-observation.service,provider-conversion-rules.service,provider-rule-scope}.ts`;
  - `provider-rule-reanchor.ts` (novo);
  - `inbound-webhooks/{inbound-conversion-automation-ingestion.service,inbound-webhook-connections.service,integration-endpoint-routing,integration-endpoints.service}.ts`;
  - `conversion-events.service.ts`;
  - `provider-conversion-production.service.ts`;
  - web `conversions/{actions,conversion-origins,conversion-rules-view,conversions-screen,new-rule-flow,rule-draft,rule-edit,rule-endpoint,rule-manage,unify-review}.tsx/ts`;
  - `integrations/single-url/single-url-panels.tsx`;
  - `styles/{globals,layout-system}.css`;
  - shared `conversion-rules.ts` e `integration-endpoints.ts`;
  - #161: endpoint de exclusão em lote.
- **Adaptações:**
  - "Todos os números da Unnichat/Umbler (todas as conexões)" vale só para Unnichat e Umbler. WAHA e Uazapi já são "todos os números" por workspace;
  - "Número removido" usa o estado `WhatsappInstance`/conexão do nod;
  - a reancoragem automática roda como ator de sistema, com auditoria, e pula quando a licença está bloqueada, como o `GlobalRuleAutoActivationService`;
  - o hunk de `lead-submitted-rule-override.ts` fica para a 6.2a.
- **Testes:**
  - `unnichat-all-connections-rule.test.ts`;
  - deltas de `integration-endpoints`, `provider-rule-workspace-scope(-api)`, `inbound-webhook-connections-service`;
  - web `conversions-unnichat-all-connections`, `conversions-view`, `conversions-actions`, `integrations-single-url`;
  - #161: `conversions-bulk-delete`;
  - teste da migration (coluna nullable, regras antigas intactas).
- **Riscos:**
  - **licença:** "Unificar", "Excluir em lote" e "Pausar" são escritas (423);
  - **onboarding:** nenhum;
  - **rodapé:** `globals.css` e `layout-system.css` (+100) mudam, então rodar `brand-footer`, `app-layout` e o breakpoint ≤900px.
- **Notas:**
  - **backup do PostgreSQL obrigatório antes do redeploy**;
  - a migration roda no boot da API;
  - depois, em cada cliente: Conversões → "Revisar e unificar" → conferir os valores → confirmar;
  - recuperação: a coluna pode ficar (nullable); voltar à versão anterior ignora a coluna. Só restaurar backup com orientação.
- **Estimativa:** ~7 dias.

### 6.1b — Motivos e prontidão dos números (sem migration)

- **Itens:**
  - #171 (`d4c6a419`);
  - #165 (`478f0f9a`);
  - #179 (`a7ccdab3`) e #180 (`c44dc9fb`);
  - #103 e #105 adaptados;
  - d4d70274;
  - b65753b7 (opcional).
- **Arquivos:**
  - `provider-conversion-observation-detail.ts` (novo);
  - `provider-conversion-orchestrator.service.ts`;
  - `provider-rule-scope.ts`;
  - `inbound-webhook-channel-readiness` (SQL agregado);
  - `meta-capi.adapter.ts` (`fn`);
  - web `received-events.tsx`, `provider-conversion-labels.ts`, painel de prontidão;
  - `inbound-webhook-routing-mode.tsx`.
- **Adaptações:**
  - os motivos "vaga" e "motor antigo" do SaaS viram os motivos do nod (licença, conexão suspensa ou removida, número em observação);
  - o SQL de prontidão inclui WAHA e Meta Cloud;
  - o #105 também bloqueia "Gerar nova URL" na ponte WAHA.
- **Env nova:** `META_CAPI_SEND_FIRST_NAME` (opcional, padrão desligado) em `.env.example`, `docs/setup/environment.md` e, se o `scripts/setup.mjs` listar as envs, nele também, sem tornar obrigatória.
- **Testes:**
  - `provider-conversion-observation-service`, `provider-conversion-rules-service`;
  - web `received-events-observation-detail`;
  - `inbound-webhook-channel-readiness`, `meta-capi-first-name`;
  - teste de volume (prontidão sem `findMany` ilimitado).
- **Riscos:**
  - **onboarding:** a env é opcional, e `pnpm setup --dry-run` precisa continuar passando;
  - **licença e rodapé:** nenhum.
- **Notas:**
  - "Migration: não se aplica";
  - variável opcional (finalidade e padrão).
- **Estimativa:** ~5 dias.

### 6.2a — Lead recebido pela regra e conversão manual no lead

- **Itens:** #155 (`4d74d303`, flag desligada), #156 (`2e328e97`), #158 (`be599f49`) e o hunk do #159 em `lead-submitted-rule-override.ts`.
- **Migration:** nenhuma no SaaS. Se o Samuel quiser a auditoria de status do #90, entra a `20261027…_lead_manual_status_audit` (aditiva), **só com aprovação**.
- **Arquivos:**
  - `conversion-rules/lead-submitted-rule-override.ts`;
  - `lead-cohort`;
  - `webhooks.controller.ts`;
  - módulo de conversões manuais (controller, service e `manual-conversion-purchase`);
  - web `leads/[leadId]/{page,actions}` e `globals.css` (+336);
  - shared `manual-conversions` e `leads.ts`.
- **Adaptações:**
  - destino Meta para leads de WAHA e Meta Cloud;
  - no lugar de "sem vaga identificável", vale licença mais conexão ativa;
  - compra manual de Braip, Hotmart e Yampi só depois da 6.5 a 6.7 (deixar o ponto de extensão);
  - **fechar o PR #90 do nod**.
- **Env nova:** `LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED` (padrão desligado).
- **Testes:**
  - `lead-submitted-rule-override`, `ctwa-lead-proof-deferred-entry`, delta do cross-number-dedupe;
  - `manual-lead-conversion` (API e web), `manual-conversions-controller`;
  - shared `manual-conversions`;
  - **novo:** frase QualifiedLead + conversão manual = 1 evento (mesmo `event_id`).
- **Riscos:**
  - **licença:** a conversão manual é escrita (423);
  - **rodapé:** +336 linhas em `globals.css`, então rodar `brand-footer`/`app-layout`.
- **Notas:**
  - "Migration: não se aplica";
  - variável opcional;
  - explicar que o #90 não será publicado.
- **Estimativa:** ~7 dias.

### 6.2b — CRM Kanban da Jornada

- **Itens:** #176 (`f5c2b47b`).
- **Dependências npm novas:** `@dnd-kit/core` 6.3.1, `@dnd-kit/utilities` 3.2.2 e `@electric-sql/pglite` 0.2.17 (dev/testes), fixadas no `pnpm-lock.yaml`.
- **Arquivos:**
  - API `crm-board` (controller, service, SQL);
  - shared `crm`;
  - web: página do quadro, `lead-detail-view.tsx`, `navigation`, `app-shell`.
- **Riscos:**
  - **rodapé, alto:** mexe em navegação e app-shell. Rodar `navigation.test.ts`, `brand-footer.test.ts` e `app-layout.test.ts`, e conferir manualmente desktop e celular;
  - **licença:** arrastar para frente é escrita (423), e a leitura do quadro continua liberada com licença bloqueada.
- **Testes:** `crm-board` (API e web), `crm-board-sql` (pglite), shared `crm`.
- **Notas:** "Migration: não se aplica"; o build da web instala dependências novas.
- **Estimativa:** ~4 a 5 dias.

### 6.3a — Relatórios: números corretos (sem migration)

- **Itens:**
  - #157 (`d4420843`);
  - #174 (`f4aa9878`);
  - #167 (`ea8203a7`);
  - #175 (`d8cefd91`);
  - e4139c4c ("valor corrigido").
- **Arquivos:**
  - `reporting/{meta-reporting.service,reporting.controller,reporting-metrics-engine}.ts`;
  - shared `reporting.ts`;
  - web `overview/*`, `events/event-audit-details.tsx`.
- **Testes:**
  - `meta-reporting-service` (+9 do #157), auto-sync;
  - `meta-sync-coverage` (API e web);
  - `reporting-metrics-engine`, `overview-route`.
- **Riscos:** nenhum em licença, onboarding ou rodapé (só leitura).
- **Notas:** "Migration: não se aplica".
- **Estimativa:** ~4 dias.

### 6.3b — Filtros da Visão Geral e Relatórios, aplicados automaticamente (sem migration)

- **Itens:**
  - #106, #110, #114–#119;
  - #121–#124;
  - #125/#126 adaptados;
  - bb76b30e, e5ef9006;
  - #143 (opcional).
- **Arquivos:**
  - web `components/filter-combobox.tsx`, `lib/search-text.ts`;
  - `overview/{overview-labels,overview-pending,overview-campaign-params,overview-filters}`;
  - `reports/{report-filter-state,report-period-filter,meta-report-filters}`;
  - `leads/lead-filters.tsx`;
  - `integrations/whatsapp-instance-activity.tsx`;
  - API `meta-reporting.service.ts` (`campaignOptions`, `campaignIds`, `whatsappInstanceId`), `leads.service.ts` e o módulo de conexões por workspace do nod (`GET …/activity`).
- **Adaptações:** a atividade por instância fica no módulo de conexões do nod (Uazapi e WAHA), sem `schemas/billing`.
- **Testes:** os testes web e API de cada PR, mais o export CSV de leads com filtros (já existe no nod).
- **Riscos:** os filtros aplicados automaticamente mudam a UX. Sem impacto em licença, onboarding ou rodapé.
- **Notas:** "Migration: não se aplica".
- **Estimativa:** ~7 dias.

### 6.4 — Robustez das chamadas à Meta Graph (migrations)

- **Itens:**
  - 6a3f2c79, c0cec66c, c685ef66 (breaker de credencial, pausa por uso, dedupe e limite da sincronização);
  - 918a0837, f1ec6a9e (thumbnails salvos);
  - 0f16c25c, 213047d3, bc72b208 (insights por anúncio, incremental);
  - 70625e41 (micro-batching da CAPI).
- **Migrations:**
  - `20261027130000_meta_creative_thumbnail`;
  - `20261027130100_meta_reporting_sync_block`.

  Conferir no SQL do SaaS que as duas são aditivas.
- **Envs novas, todas opcionais com padrão seguro:**
  - `META_INSIGHTS_LEVEL_MODE`, `META_INSIGHTS_PAGE_LIMIT`;
  - `META_INSIGHTS_ASYNC_ENABLED` (desligada);
  - `META_CAPI_BATCH_ENABLED` (desligada), `META_CAPI_BATCH_WINDOW_MS`, `META_CAPI_BATCH_MAX_EVENTS`;
  - `WPPTRACK_META_USAGE_PAUSE_PERCENT`, `WPPTRACK_META_SYNC_DEDUPE_WINDOW_MINUTES`, `WPPTRACK_META_SYNC_MAX_DEFERRALS`.
- **Adaptações:**
  - conciliar com a mitigação "URGENT — fewer Meta Graph API calls" do nod (`META_VIDEO_THUMBNAILS_ENABLED` continua valendo);
  - o app Meta do aluno pode ser próprio ou o broker PalmUP, então os limites valem por app;
  - `apps/api/scripts/delete-workspace.js` precisa apagar as novas tabelas na ordem certa das FKs (teste `delete-workspace-order`).
- **Testes:** os do SaaS (breaker, throttle, aggregation, thumbnail, capi batch) mais `delete-workspace-order`.
- **Riscos:**
  - **onboarding:** só envs opcionais; `pnpm setup` e o checklist `/onboarding/status` não mudam;
  - **licença:** a sincronização em segundo plano respeita o soft-lock como hoje.
- **Notas:**
  - **backup obrigatório**;
  - as duas migrations rodam no boot;
  - envs opcionais (nome e finalidade, sem valor).
- **Estimativa:** ~8 a 10 dias.

### 6.5 — Base de plataformas de venda na URL única, Braip e certificação no app (migrations)

- **Itens:**
  - Braip (09d7303a, f83522af, 072bb61a, 25a7cd76, b3124d65) e #168;
  - `sales-platform-sale.ts`, que passa a usar o `sao-paulo-timestamp.ts` da 6.0;
  - b4d71afc (tela de leitores);
  - #166, #169, #170, #164, #184;
  - o hunk de compra do #158 para Braip.
- **Migrations:**
  - `20261027140000_braip_provider` (enum, aditiva);
  - `20261027140100_braip_parser_release` (release **não certificada**).
- **Decisão do Samuel (Gate 1):**
  - **(a) Recomendado:** o aluno, como `platform_owner`/`platform_operator` da própria instalação, certifica o leitor no app com um evento real ("Liberar plataforma", #166/#169).
  - **(b) Alternativa:** o leitor só sai de observação por uma migration de certificação da PalmUP, depois que o SaaS validar. Mantém o modelo atual, mas atrasa Braip e Hotmart.
- **Adaptações:**
  - o card aparece sempre no hub, sem gate;
  - sem `package-billing.policy`;
  - os Recebimentos (#170) aparecem no backoffice do aluno, sem filtro privado, com payload mascarado e respeitando a retenção.
- **Testes:**
  - `braip-*` (incluindo `braip-official-sample`), `inline-parser-certify`, `unattributed-sale-certify`, `backoffice-integration-events`;
  - delta de `integration-endpoints`;
  - web `braip-integration`, `unattributed-sale-*`, telas de leitores.
- **Riscos:**
  - **licença:** certificar ou liberar é escrita (423);
  - **onboarding:** um card novo no hub, e o teste `integrations-hub-registry` precisa ser atualizado.
- **Notas:**
  - **backup obrigatório**;
  - passo a passo para configurar a Braip e liberar a plataforma.
- **Estimativa:** ~10 a 12 dias.

### 6.6 — Hotmart (migrations)

- **Itens:** #182 (`b134534b`).
- **Migrations:** `20261027150000_hotmart_provider` e `…150100_hotmart_parser_release` (não certificada).
- **Adaptações:** sem billing.
- **Testes:** `hotmart-*` (parser, certification, migration), integration-endpoints, web.
- **Notas:** backup obrigatório.
- **Estimativa:** ~3 dias.

### 6.7 — Yampi (migrations; entra por último junto com o ROI Chat)

- **Itens:** #186 (`1889af48`) e #187 (`087df11b`).
- **Migrations:** `20261027160000_yampi_provider` e `…160100_yampi_parser_release`.
- **"Já certificados":**
  - se, na hora do porte, o SaaS já tiver validado a Yampi com venda real, a release entra **certificada por migration** (como `20261016090300_validated_parser_certification`), citando a evidência;
  - sem essa evidência, ela entra não certificada e com `PENDENTE:` nas notas.
- **Adaptações:** liberada, sem `private-sales-platform-gate` nem `yampi-feature-gate`; os tokens de login continuam ocultos nos links.
- **Testes:** `yampi-*`, `unattributed-sale-certify` (#187).
- **Notas:** backup obrigatório.
- **Estimativa:** ~3 a 4 dias.

### 6.8 — ROI Chat (migrations; por último)

- **Itens:** #183 (`f4f74673`) e #185 (`37bee70d`).
- **Migrations:** `20261027170000_roichat_provider` e `…170100_roichat_parser_releases`, **removendo** o `ALTER TYPE "WhatsappSeatProvider" ADD VALUE`, que não existe no nod. A certificação segue a mesma regra da 6.7.
- **Adaptações:**
  - sem `roichat-feature-gate`, sem `private-integrations` e sem hunks de billing ou vaga;
  - card em "Conexões WhatsApp" do hub, convivendo com Uazapi, WAHA e Meta Cloud;
  - a entrada CTWA passa pelo guard do #153 e a compra pela regra (#155 e #159).
- **Testes:**
  - `roichat-parsers` com a fixture real do #185, `roichat-integration`, `roichat-provider-migration`, web;
  - **novo:** dedupe entre o ROI Chat e um número WAHA do mesmo lead.
- **Riscos:**
  - **onboarding:** o registry de provedores e o checklist precisam continuar verdes;
  - **licença:** criar conexão é escrita (423).
- **Notas:** backup obrigatório; guia de configuração do webhook do ROI Chat.
- **Estimativa:** ~6 a 8 dias.

### 6.9 — Absorver os PRs do nod (#91 e #92), fora do porte

- Plano próprio depois da 6.8: rebase sem o #90, migration renomeada e chaves de dedupe do #158/#153.
- Estimativa à parte (~5 a 7 dias).

### Totais

- **6.0 a 6.8:** ~60 a 70 dias de execução com revisão, um escritor por vez. A 6.4 e a 6.3b podem correr em worktree separado da 6.5 a 6.8, porque têm poucos arquivos em comum. Com isso, o calendário fica em ~45 a 55 dias.
- **Mínimo para a Fase A original** (6.0 + 6.1a + 6.1b): ~17 dias.

## 4. Gate 2 por subfase (preencher ao iniciar)

```text
Status: IMPLEMENTANDO
Branch: feat/fase-6.x-<slug>
Executor: (Claude Code / Codex)
Modelo/reasoning:
Task file: .hermes/plans/PORTE-SAAS-PARIDADE-FASE-6.md §6.x
Escopo: itens da subfase, nada além
Migrations: (nome; aditiva; timestamp > maior do main)
Testes: (lista da subfase + licensing-client + brand-footer/app-layout/navigation)
```

## 5. Checklist ponta a ponta (instância de aluno, depois da 6.8)

Use uma instância de teste com uma licença real de teste, num workspace sem dados de cliente real.

1. **Backup** do PostgreSQL feito e conferido no Dokploy.
2. **Atualização:** redeploy da API e da web pelo `docs/setup/update.md`. O log da API mostra as migrations novas aplicadas em ordem, sem erro. `/health` e `/health/ready` estão OK. O backoffice mostra o commit novo em "Versão instalada".
3. **Licença:**
   - `/backoffice/license` ativa;
   - bloquear a licença de teste e conferir 423 em "Reenviar bloqueados", "Unificar", "Excluir em lote", conversão manual, Kanban, "Liberar plataforma" e criar conexão ROI Chat; a leitura continua funcionando;
   - desbloquear depois.
4. **Onboarding:** `pnpm setup --dry-run` passa sem envs novas obrigatórias, e `/onboarding/status` está verde como antes.
5. **Rodapé:** "RastrackDash · powered by PalmUP" visível em desktop e celular (≤900px), inclusive no Kanban e na tela do lead.
6. **#153:** o mesmo lead fala com dois números (Uazapi e WAHA) e uma regra QualifiedLead "Todos os números" gera **um** evento no Gerenciador de Eventos. Um segundo pixel recebe o seu próprio evento. As Execuções mostram "Lead já convertido por outro número".
7. **#181:** com um evento 190 simulado ou real dos últimos 7 dias, "Reenviar bloqueados e falhas de login da Meta" reenvia; um evento com mais de 7 dias aparece como expirado; um erro 100 não é reenviado.
8. **#173:** o carrinho Payt das 21:39 aparece como 21:39, e o `event_time` nunca fica no futuro.
9. **#159:**
   - duas conexões Unnichat e uma regra "todas as conexões": um evento do segundo número converte;
   - "Revisar e unificar" mostra as diferenças;
   - remover um número exibe "Número removido" e reancora a regra.
10. **#171/#165/#179:** o motivo de "em observação" aparece em Eventos recebidos; a prontidão dos números carrega rápido numa conta com histórico; "Bloqueado" sempre vem com motivo.
11. **#155/#158/#176:**
    - com a flag desligada, nada muda;
    - a conversão manual de QualifiedLead num lead que já converteu pela frase **não** gera segundo evento;
    - compra manual com pedido;
    - arrastar no Kanban gera a conversão.
12. **Relatórios:** o investimento respeita o período; o aviso de sincronização aparece quando há atraso; o gráfico Meta × conversas reais aparece; os filtros de campanha e número se aplicam sozinhos; o CSV respeita os filtros.
13. **Meta Graph:** com as flags novas desligadas, a sincronização se comporta como antes. Com o breaker, um token inválido pausa a sincronização sem repetir chamadas.
14. **Plataformas:**
    - Braip, Hotmart e Yampi recebem uma venda real (ou o postback oficial) pela URL única;
    - aparecem em Recebimentos;
    - "Ver dados recebidos" vem mascarado;
    - liberar a plataforma e a próxima venda envia `Purchase`.
15. **ROI Chat:** a entrada CTWA cria o lead; a compra pela regra envia `Purchase`; o dedupe com um número WAHA funciona.
16. **Regressão:**
    - WAHA: frase da equipe envia;
    - Meta Cloud: inscrição na WABA;
    - Kommo e Pipedrive enviam;
    - Payt pela URL única;
    - exportar leads;
    - excluir workspace (ordem das FKs com as tabelas novas).
17. **Recuperação:** documentado que voltar o código não desfaz migrations; restaurar o backup só com orientação.

## 6. Decisões pendentes do Samuel (Gate 1)

1. Aprovar a ordem 6.0 → 6.8 e a divisão em PRs.
2. Certificação dos leitores novos: (a) no app pelo aluno, recomendado; ou (b) só por migration PalmUP.
3. Brink Park e GoHighLevel: fora (recomendado) ou incluir.
4. PR #90 do nod: fechar e substituir pelo #158/#176 (recomendado). Auditoria de status: sim ou não.
5. #91 e #92: absorver na 6.9, depois do porte (recomendado).
6. Instalação onde o import do #92 já rodou: é de aluno real? Se for, precisa reconciliar as chaves antes da 6.2a.

## Decisões do Samuel (26/10/2026): GATE 1 APROVADO

1. **Ordem das fases aprovada:** 6.0 → 6.1a → 6.1b → 6.2a → 6.2b → 6.3a → 6.3b → 6.4 → 6.5 → 6.6 → 6.7 (Yampi) → 6.8 (ROI Chat) → 6.9 (#91/#92).
2. **Brink Park NÃO vai** para o nod: é exclusiva de um cliente.
3. **GoHighLevel VAI.** Antes disso, a integração precisa ser **terminada no SaaS (dash-com-ia)**, porque hoje ela só observa. O Samuel tem um exemplo para isso. Depois, entra como fase própria no nod.
4. **PR #90 (qualificação manual) será fechado.** Quem o substitui são o #158 (conversão manual) e o #176 (Kanban). Os PRs **#91 e #92 entram na 6.9**, depois do porte.
5. **Importação #92:** só foi rodada em teste, não em aluno real. Não há dados a corrigir.
6. **Certificação:** um leitor validado com venda real no SaaS vai **certificado por migration** para o nod. O aluno não precisa liberar nada; a regra continua começando em observação e é ativada pelo aluno. Leitor ainda não validado no SaaS (hoje, o ROI Chat) só é portado depois de validado.
7. **Escopo:** levar **tudo** que afeta o uso dos alunos, sem entregar pela metade. O prazo não é o problema.
