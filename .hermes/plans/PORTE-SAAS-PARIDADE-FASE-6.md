# PLANO — Fase 6: paridade com o SaaS (dash-com-ia até #187)

> **Status: GATE 1 APROVADO (26/10/2026).** A 6.0, a 6.1a, a 6.1b e a 6.1c estão na branch de integração `integracao/fase-6` (PR #105, #106, #107 e #108); a 6.2a está implementada e aguarda revisão (branch `feat/fase-6.2a-lead-regra-conversao-manual`). **Regra fixa "produção direta" (26/10/2026) na §0, valendo para todas as fases seguintes.** A auditoria de 26/10 e as decisões do Samuel do mesmo dia estão na seção "Decisões do Samuel (26/10/2026, depois da auditoria)", no fim, e já entraram nas fases abaixo.
>
> - Plano canônico de execução: `.hermes/plans/ACTIVE-STUDENT-EDITION-IMPROVEMENTS.md`. Este arquivo é o plano da fase. Quando a implementação começar, o ACTIVE recebe a linha "Fase 6" com o protocolo de status, conforme a seção "Protocolo de atualização".
> - Base do levantamento:
>   - nod `main` @ `e63e268` (1.2.0, #104);
>   - dash-com-ia `origin/main` @ `087df11b` (#187).
> - Data: 2026-10-26.
> - Escopo pedido pelo Samuel: levar para o nod tudo o que foi feito no dash-com-ia e afeta o uso dos alunos, sem meia-entrega e sem conflito. ROI Chat e Yampi entram por último. Cada fase é um PR testável.

## 0. Regras que valem para todas as subfases

- **Produção direta (regra fixa do produto, definida pelo Samuel em 26/10/2026; vale para a 6.1c e para todas as fases seguintes, da 6.5 à 6.8b).** O que foi validado no SaaS vai para o aluno **em produção**. O aluno **não retesta, não certifica e não libera nada**: a mesma plataforma manda o mesmo payload. Em cada porte:
  - o leitor (parser release) de uma integração validada no SaaS entra **certificado** pela migration do próprio porte, citando a evidência da validação;
  - as **conexões** dessa integração nascem **em produção** e cada número nasce com o envio ativo (`apps/api/src/inbound-webhooks/production-direct.ts`: `bornConnectionStatus` / `bornChannelState`);
  - as **regras de conversão** nascem **enviando**: a criação não manda `mode` e a API decide (`bornRuleMode`); nada de "Ativar envio" para começar;
  - a observação só existe para o que ainda não foi validado no SaaS; um leitor não validado não é portado até ser validado (decisão 6 do Gate 1);
  - continuam valendo as travas que não são "teste": licença utilizável (423), rota Meta válida e destino com pixel e página (e, no Meta Cloud, `META_APP_SECRET`). Faltando algo, a tela diz exatamente o que configurar, nunca "em observação";
  - nenhum texto novo da tela fala em observação, teste, liberar ou certificar.
- **No nod não existe conexão por QR code.** As APIs não oficiais (Uazapi BYO e WAHA) são conectadas pela **URL do servidor + token**, e a URL de webhook é colada na plataforma; cada conexão tem um único número. Nunca escrever "QR" em texto, nota ou código novo do nod.

- **Um escritor por worktree.** Branch `feat/fase-6.x-<slug>` a partir do `main` atualizado. Commit, push, PR e merge são gates separados.
- **Commits portados citados** no CHANGELOG ("ported from the SaaS (`hash`, …)"), como nas fases 4 e 5.
- **Nunca reintroduzir:**
  - billing, Asaas, Pix, assinatura, split ou nota fiscal;
  - vagas pagas (`WhatsappSeatProvider`, `package-billing.policy`);
  - o servidor de licença, a liberação de licença ou o WhatsApp da licença;
  - gates de integração privada (`*_WORKSPACE_IDS`, `WorkspacePrivateIntegration`).
- **"Vaga paga" no SaaS vira licença utilizável no nod.** Com a licença bloqueada, toda escrita responde 423 pelo guard global. Para números Uazapi BYO e WAHA (conexão por URL do servidor + token), vale também a conexão `WhatsappInstance` `active`. É a mesma tradução usada no porte do #152.
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
| 6.8b | `20261027180000_*` (reservado; nomes definidos quando o GoHighLevel estiver terminado no SaaS) | branch `feat/gohighlevel-automation` do dash-com-ia (em revisão) |

- A 6.1c usou o horário reservado: `20261027125000_production_direct_validated_integrations` (só dados: promoção da produção direta), entre a da 6.1a e a da 6.4.

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
| #155 | "Lead recebido" pela regra (flag `LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED`: desligada no SaaS, ligada por padrão no nod) | ADAPTAR | Base de #158, #167, #175 e #183. O `auto_lead` do nod inclui WAHA e Meta Cloud | 6.2a | G |
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
| #188 | Yampi: itens reais do pedido (com order bump) na Compra enviada à Meta (`contents`/`order_id`) | PORTAR | Junto com o #186 (achado em 27/10, depois do levantamento) | 6.7 | P |

### 1.2 Anteriores ao #152 que ainda não estão no nod

Conferido lendo o código do nod, não só os nomes de arquivo.

| Item SaaS | Estado no nod | Classe | Fase | Tam. |
|---|---|---|---|---|
| Braip (09d7303a, f83522af, 072bb61a, 25a7cd76, b3124d65) e a base `sales-platform-sale.ts` | Não portado (o shared só cita `braip` em teste de rejeição) | PORTAR | 6.5 | G |
| b4d71afc: tela de versões do leitor e certificação no backoffice | Não portado (o nod certifica por migration) | ADAPTAR: com a produção direta (§0) o aluno não certifica nada; no máximo uma tela só de leitura das versões | 6.5 | M |
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
| #128–#133 GoHighLevel | Não portado (o teste do hub do nod exige GHL fora) | ADAPTAR. **Decisão de 26/10: VAI**, depois de terminado no SaaS (hoje só observa; o branch `feat/gohighlevel-automation` do dash-com-ia está em revisão) | 6.8b | M/G |
| #66 (`37572ad9`), #85 (`ff28d8a1`), #86 (`71e69a95`): a ativação da regra não trava com número órfão (conexão removida) nem com número duplicado/redescoberto | Não portado (achado na auditoria de 26/10) | ADAPTAR: cobrir a ponte WAHA/Uazapi removida; o `retireBridge` do SaaS não existe no nod | 6.1a | P |
| 75f6f4b3 (parcial): janela de 7 dias da Meta também para eventos com anúncio nas automações (Payt, Unnichat, Umbler) | Parcial (a aprovação do operador no "Reprocessar selecionados" já veio) | PORTAR a parte da janela de 7 dias | 6.1b | P |
| #61 (`c95961f0`): ordem canônica do funil e filtros de evento configurados no workspace | Não portado | PORTAR | 6.3a | P/M |
| #69 (`45f18c2b`): cards de KPI da Visão Geral configuráveis por funil | Não portado | PORTAR | 6.3a | M |
| #83 (`58d5e51b`, parcial): preservar os períodos já sincronizados da Meta | Parcial | PORTAR só a parte de relatórios (a parte de client-swap não se aplica) | 6.3a | P |
| #62 (`d2a5f76e`): barra de filtros dos Relatórios agrupada em período / escopo / ações | Não portado | PORTAR | 6.3b (primeiro item) | P |
| #63 (`6be4bdcd` / `86aaac21`): alerta de desconexão do WhatsApp por instância, só depois de 2 leituras seguidas | No nod o alerta por instância **nunca roda** | ADAPTAR (Uazapi e WAHA). **Decisão de 26/10: VAI** | 6.1c | P/M |
| #91 (`f7c61c07`): reenviar os itens de replay que falharam, com o payload retido | Não portado | ADAPTAR na recuperação do aluno (owner), onde o replay vive no nod. **Decisão de 26/10: VAI** | 6.1c | M |
| 7570fe14 (parcial, Kommo): revalidar `/integrations` depois das ações do CRM | Parcial | PORTAR só a parte do Kommo (e Pipedrive); Guimo não se aplica | 6.5 | P |
| Guimo (CRM de um cliente só: `guimo-conversion-panel`, migrations `guimo_*`) | Não portado | **NÃO SE APLICA** (decisão de 26/10: é de um cliente só) | — | — |
| #120, #134–#142, #144, #148, #151, cc5412f0, 7ca3a69f/56f19a94/ed5fe229, correções Unnichat (b22b651e…), correções Payt CTWA (6f9c2297…), 0cffd7b8, 4b5e674a, #104 | **JÁ NO NOD** (fases 3 a 5, nod #63–#69). #134/#135 são o Kommo (front e back) | — | — | — |
| #145–#147 (broker OAuth Meta), client-swap (#102, `52d255dc`, e a parte de client-swap do #83), 8094dbd7, todo billing/Pix/Asaas/assinatura, #107–#113 e #127/#149/#150 (licença e claim) | NÃO SE APLICA (lado SaaS, billing ou licença) | — | — | — |

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
6.0 (#153, #181+7ac17df7, #173) → 6.1a (#66/#85/#86, #159, #160, #161) → 6.1b (#171, #165→#179/#180, #103/#105, d4d70274, 75f6f4b3 parcial) → 6.1c (#63, #91 do SaaS)
6.0 → 6.2a (#155, #156, #158) → 6.2b (#176)
6.2a → 6.3a (#61, #69, #83 parcial, #157→#174, #167→#175, e4139c4c) → 6.3b (#62 primeiro; filtros e auto-aplicar)
6.4 (Meta Graph) é independente; depois da 6.3a, porque os dois mexem em meta-reporting.service
6.0 (#173) + 6.2a (#158 hunk de compra) → 6.5 (base de plataformas, Braip, certificação, #164, #166, #169, #170, #184, 7570fe14 parcial) → 6.6 Hotmart → 6.7 Yampi
6.0 + 6.1a + 6.2a + 6.5 (#170 schema/recibos) → 6.8 ROI Chat → 6.8b GoHighLevel (depois de terminado no SaaS)
tudo → 6.9 absorver #91 e #92 do nod
```

Atenção ao número: o "#91" da 6.1c é o PR #91 do **SaaS** (`f7c61c07`, reenviar itens de replay); o "#91" da 6.9 é o PR #91 do **nod** (formulários Meta).

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

- **Itens:**
  - antes do #159, os achados da auditoria: #66 (`37572ad9`, commit `3f59e2f7`), #85 (`ff28d8a1`) e #86 (`71e69a95`). A ativação da regra ("Envio ativo") não trava com número órfão (conexão removida, inclusive a ponte WAHA/Uazapi) nem com número redescoberto com outra identidade na mesma conexão;
  - #159 (`42ccbc7c`), #160 (`5141e217`), #161 (`0f6e010d`).
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
  - 75f6f4b3 (parcial, achado da auditoria): a janela de 7 dias da Meta (`event_time`) também para eventos com anúncio nas automações (Payt, Unnichat, Umbler), com `not_eligible` / `MetaEventTimeExpired`;
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

### 6.1c — Produção direta, alerta de desconexão por conexão e reenvio de itens de replay (migration de dados)

Fase nova, proposta depois da auditoria de 26/10 (decisão do Samuel: os dois itens VÃO). Fica logo depois da 6.1b porque os dois mexem em prontidão e operação dos números, e não depende das fases de relatório nem das plataformas. Em 26/10 o Samuel acrescentou a **produção direta** (regra fixa da §0) como item 1 da 6.1c.

- **Produção direta (implementado):**
  - levantamento dos pontos que nasciam em observação ou exigiam ativação manual: conexão genérica (Umbler, Gupshup, Data Crazy, Meta Cloud, Unnichat e o número da Unnichat), ponte Uazapi/WAHA (conexão e número), número descoberto pela entrega, número cadastrado à mão, regras (frase, catálogo, etiqueta, automação Umbler/Unnichat, Payt e regra antiga adaptada) com `mode` padrão `observation` no contrato, Kommo e Pipedrive (`mode` padrão `observation`), "Retomar" voltando em observação, e o servidor com `INBOUND_CONVERSION_PRODUCTION_ENABLED` desligado por padrão (a documentação mandava manter `false`). Releases no banco em `observation_only`: só `meta_cloud v1` (o código já o tratava como certificado). Leitor não validado no nod: nenhum;
  - o que mudou: `production-direct.ts` (nascimento), criação de conexões/números/ponte, `bornRuleMode` nas regras (o contrato deixou de forçar `observation`), "Retomar" volta enviando, Kommo/Pipedrive nascem em produção (Pipedrive só com a conexão pronta), padrão novo da env, textos das telas e da documentação;
  - Meta Cloud: nasce em produção só com `META_APP_SECRET` (em produção a API exige a assinatura e recusaria as entregas);
  - migration `20261027125000_production_direct_validated_integrations` (só dados, horário reservado da 6.1c): promove uma vez o que estava em observação, respeitando pausas, unificações, remoções, decisões explícitas (conexão voltada para observação; regra que já esteve em produção) e replay em curso; Meta Cloud fica de fora (depende do segredo). Escolhida no lugar de uma rotina de boot porque roda uma única vez, dentro da transação do deploy, depois do backup pedido nas notas, fica registrada em `_prisma_migrations` e não volta a promover algo que o aluno desligar depois.

- **Itens:**
  - alerta de desconexão do WhatsApp **por instância** (SaaS #63: `6be4bdcd`, `86aaac21`, sobre a base do #26 `832cb677`). No nod esse alerta nunca roda. No SaaS ele só dispara depois de **2 leituras seguidas** de "desconectado" (pending/qr/error/hibernado/offline são ambíguos e não contam nem quebram a sequência; uma leitura "conectado" zera a sequência; falha no `getStatus` nunca alerta);
  - reenviar os itens de replay que falharam, com o payload retido (SaaS #91, `f7c61c07`). **Implementado na recuperação do aluno** (owner do workspace, Integrações → Meta Cloud → "Recuperar CTWAs anteriores"), onde o replay vive no nod; o nod não tem replay no backoffice.
- **Adaptações:**
  - o alerta vale para Uazapi e WAHA (`WhatsappInstance`), por workspace, com o destino de alerta que o aluno já configura em `ops-alerts`; sem WhatsApp da licença PalmUP;
  - o alerta respeita a licença: com a licença bloqueada, nada é enviado (como a ativação automática);
  - o reenvio é uma ação do owner na recuperação do aluno, por lote de replay, só para itens com payload ainda retido (`INBOUND_WEBHOOK_RAW_RETENTION_DAYS`), revalidando cada item como uma autorização nova e nunca reenviando um CTWA que já gerou evento; é escrita, então responde 423 com a licença bloqueada.
  - o alerta é conferido para toda conexão Uazapi BYO/WAHA ativa (aparece em Integrações mesmo sem telefone); a mensagem só sai com alerta ligado, telefone e licença utilizável. WAHA: `STOPPED` e a sessão esperando novo pareamento contam; `STARTING`, `FAILED` e desconhecido são ambíguos.
- **Testes:** os do SaaS (`ops-alerts` com a sequência de 2 leituras, `inbound-webhook-replay` do #91) adaptados, mais: WAHA desconectada duas vezes alerta uma vez; uma leitura ambígua não alerta; reenvio com licença bloqueada responde 423; item sem payload retido não é reenviado.
- **Riscos:** onboarding (o alerta precisa de destino configurado; sem destino, não faz nada e não quebra o `/onboarding/status`); rodapé intacto (tela do backoffice).
- **Notas:** migration de dados `20261027125000_production_direct_validated_integrations` (backup obrigatório); nenhuma variável obrigatória nova; padrão novo de `INBOUND_CONVERSION_PRODUCTION_ENABLED` (sem valor acompanha `INBOUND_CONVERSION_RULES_ENABLED`); `OPS_ALERT_UAZAPI_BASE_URL`/`OPS_ALERT_UAZAPI_TOKEN`/`OPS_ALERT_SCAN_INTERVAL_MS` (já existentes, opcionais) documentadas.
- **Estimativa:** ~3 a 4 dias.

### 6.2a — Lead recebido pela regra e conversão manual no lead

- **Status (26/10/2026): IMPLEMENTADA**, branch `feat/fase-6.2a-lead-regra-conversao-manual` (a partir de `origin/integracao/fase-6`), aguardando revisão. Sem migration. Flag `LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED` **ligada por padrão** (produção direta).
- **Itens:** #155 (`4d74d303`; no SaaS, flag desligada; no nod, ligada por padrão, ver Env nova), #156 (`2e328e97`), #158 (`be599f49`) e o hunk do #159 em `lead-submitted-rule-override.ts`.
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
- **Env nova:** `LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED`, **ligada por padrão** (produção direta, regra fixa da §0: validada em produção no SaaS). Sem valor = ligada; `false`/`0`/`off`/`no` explícito desliga. Um único leitor (`apps/api/src/config/lead-submitted-rule-override-flag.ts`) para todos os espelhos (regras, lead-cohort, relatórios, guard de conversão única, capacidades).
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

- **Status (26/10/2026): IMPLEMENTADA**, branch `feat/fase-6.2b-crm-kanban` (a partir de `origin/integracao/fase-6`), aguardando revisão. Sem migration e sem variável nova; sem feature flag (produção direta). Nenhuma correção posterior de CRM no SaaS até `origin/main` (#189). Adaptações: licença bloqueada = quadro legível e cards sem arrastar (423 ao mover); números = conexões WhatsApp ativas; campanhas = estrutura Meta sincronizada (o filtro pesquisável por período vem na 6.3b); miniatura pela URL do CTWA/anúncio (miniatura guardada vem na 6.4).
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
  - achados da auditoria: #61 (`c95961f0`, ordem canônica do funil e filtros de evento do workspace), #69 (`45f18c2b`, cards de KPI da Visão Geral por funil) e #83 (`58d5e51b`, parcial: preservar os períodos já sincronizados da Meta; a parte de client-swap não se aplica);
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
- **Execução (26/10/2026, branch `feat/fase-6.3a-relatorios-numeros`):** portados #61, #69, #83 (parte de relatórios), #157, #167, #174 e e4139c4c. O #175 foi para a 6.3b: ele só atua com o filtro por número WhatsApp dos relatórios (`whatsappInstanceId`), que o nod ainda não tem. Na #174, o motivo "bloqueada" depende da coluna `reportingSyncBlockedAt` da 6.4; até lá nenhuma conta aparece como bloqueada.

### 6.3b — Filtros da Visão Geral e Relatórios, aplicados automaticamente (sem migration)

- **Itens:**
  - **primeiro:** #62 (`d2a5f76e`, achado da auditoria): a barra de filtros dos Relatórios agrupada em período / escopo / ações, base dos filtros abaixo;
  - #175 (`d8cefd91`, vindo da 6.3a): com o filtro por número, as conversas incluem as entradas adiadas para a regra (`metricEventLeadIds`); portar junto com o #106, com os testes "override mode + number filter" do `meta-reporting-service`;
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
- **Execução (26/10/2026, branch `feat/fase-6.3b-filtros`):** portados #62 (primeiro), #106, #110, #114–#119, #121–#124, #175 (com os testes "override mode + number filter"; no nod o "modo normal" usa `LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED=false` explícito), bb76b30e e e5ef9006, mais as peças posteriores do SaaS nos mesmos arquivos (2f79c3c7: filtro de contas na FilterCombobox; 996e7c12: várias contas nas opções de campanha; be599f49: origem "Manual" em Eventos; 82448211: número na rota de exportação de Leads; o filtro de número na busca dos leads adiados do 4d74d303). #125/#126 adaptados: `GET /integrations/whatsapp-connections/:id/activity` no módulo de conexões do nod (Uazapi BYO e WAHA), `whatsappInstanceActivitySchema` no schema de integrações (sem `schemas/billing`), atividade no card de cada conexão e na ponte das regras de frase ("Não medido" nos contadores de entrada). Os números dos filtros vêm de `/integrations/whatsapp-connections`. O filtro de campanha do CRM (6.2b) passou para a FilterCombobox. #143 não foi portado (opcional; a web não envia a ordenação por etapa nem no SaaS). Sem migration e sem variável nova. Correções do nod achadas na revisão (o SaaS ainda não tem): o resumo da Visão Geral com várias campanhas fica nas campanhas escolhidas (`summaryMetricScope` lê `campaignIds`); o CSV de Relatórios leva o número; a campanha do drill-down fora do BM/conta vira tabela vazia (404), não "API indisponível". Levar ao SaaS: as duas primeiras.

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
- **Execução (27/10/2026, branch `feat/fase-6.4-meta-robustez`):** portados 918a0837, 0403cbce, f1ec6a9e, 6a3f2c79, c0cec66c, c685ef66, 0f16c25c, 213047d3, 70625e41 e bc72b208 (notas: 33adb781). Correções posteriores do SaaS nos mesmos trechos: só o `reportingSyncBlockedAt` da cobertura (#174), agora ligado no nod; nenhuma outra até `origin/main`. Migrations `20261027130000_meta_creative_thumbnail` e `20261027130100_meta_reporting_sync_block` aditivas e idempotentes (IF NOT EXISTS; FK num bloco DO). Adaptações: a mitigação URGENT fica (prévias salvas reaproveitadas no `listAds`, `META_VIDEO_THUMBNAILS_ENABLED`, primeira sincronização em 10 a 30 min no lugar do jitter do SaaS); o uso do app Meta é contado por app (`palmup` = credencial "Login social PalmUP", `own` = o resto) via AsyncLocalStorage no processador, na pausa das miniaturas e na decisão da varredura automática; o batch do nod não lança erro, então o limite de taxa das miniaturas vira `MetaGraphError` código 4; a CAPI em lote mantém a confirmação estrita do nod (events_received, messages, fbtrace_id) e não guarda o corpo da Meta. Ligados: o "bloqueada" da cobertura (6.3a) e a miniatura guardada no card do CRM (6.2b). Padrões: `META_INSIGHTS_ASYNC_ENABLED` e `META_CAPI_BATCH_ENABLED` desligados (sem comprovação de uso em produção no SaaS; PENDENTE do Samuel), `META_INSIGHTS_LEVEL_MODE=legacy`, incremental 3 dias e páginas de 500 ligados como no SaaS.

### 6.5 — Base de plataformas de venda na URL única, Braip e certificação no app (migrations)

- **Itens:**
  - Braip (09d7303a, f83522af, 072bb61a, 25a7cd76, b3124d65) e #168;
  - `sales-platform-sale.ts`, que passa a usar o `sao-paulo-timestamp.ts` da 6.0;
  - b4d71afc (tela de leitores);
  - #166, #169, #170, #164, #184;
  - o hunk de compra do #158 para Braip;
  - 7570fe14 (parcial, achado da auditoria): revalidar `/integrations` depois das ações do Kommo (e do Pipedrive); a parte do Guimo não se aplica.
- **Migrations:**
  - `20261027140000_braip_provider` (enum, aditiva);
  - `20261027140100_braip_parser_release`: **certificada** (produção direta, §0), citando a validação do SaaS (venda real no SaaS, confirmada pelo Samuel em 27/10/2026; o #168 também conferiu o postback oficial). Sem validação no SaaS, a Braip não é portada.
- **Produção direta (§0, substitui a decisão (a)/(b) do Gate 1):** o leitor entra certificado; a conexão (quando houver) e a regra nascem em produção. "Liberar plataforma" (#166/#169) **não** vira passo do aluno: no máximo, uma ação de suporte/diagnóstico sem efeito no envio.
- **Adaptações:**
  - o card aparece sempre no hub, sem gate;
  - sem `package-billing.policy`;
  - os Recebimentos (#170) aparecem no backoffice do aluno, sem filtro privado, com payload mascarado e respeitando a retenção.
- **Testes:**
  - `braip-*` (incluindo `braip-official-sample`), `inline-parser-certify`, `unattributed-sale-certify`, `backoffice-integration-events`;
  - delta de `integration-endpoints`;
  - web `braip-integration`, `unattributed-sale-*`, telas de leitores.
- **Riscos:**
  - **licença:** criar e editar regra são escrita (423);
  - **onboarding:** um card novo no hub, e o teste `integrations-hub-registry` precisa ser atualizado.
- **Notas:**
  - **backup obrigatório**;
  - passo a passo para configurar a Braip e liberar a plataforma.
- **Estimativa:** ~10 a 12 dias.
- **Correção (27/10/2026, na 6.9):** a Braip foi validada com **venda real** no SaaS, confirmado pelo Samuel em 27/10/2026. O comentário da migration `20261027140100_braip_parser_release` (só o comentário; o SQL não mudou), o `docs/setup/braip.md`, o `CHANGELOG.md` e o `unreleased.json` foram corrigidos. Continuam PENDENTE só os pontos técnicos: `trans_value` (juros e frete), fuso das datas, nome do aviso de abandono e renovações de assinatura. Pela regra de 27/10/2026 (abaixo), não há PENDENTE de "venda real numa instalação de aluno".
- **Execução (27/10/2026, branch `feat/fase-6.5-plataformas-venda-braip`):** validação conferida no SaaS: #168 (`8af225f4`) conferiu o leitor com o exemplo **oficial** do postback da Braip (área de membros; fixtures sanitizados e `braip-official-sample`); a release do SaaS ainda nasce `observation_only`, e no nod nasce **certificada** (`20261027140100_braip_parser_release`, separada da `20261027140000_braip_provider` por causa do P3009). Portados: 09d7303a, f83522af, 072bb61a, 25a7cd76, b3124d65 (logo), #168, #164 (contagens reais da URL; a parte web do `useServerEndpoint` já existia no nod pelo `mergeEndpoints`), #169 só a leitura ("Ver dados recebidos" mascarado e auditado; `integration-event-inspection.ts` com o mascaramento de tokens em URL do SaaS final), #170 (Recebimentos das URLs únicas no backoffice do aluno, recibos `rejected`, retry só para sem atribuição/pendente, retenção de 60 dias), #184 (CSS), o hunk de compra do #158 pelo ponto de extensão `manual-conversion-sales-platforms.ts` (pedido = `trans_key`) e 7570fe14 parcial (Kommo; o Pipedrive já revalidava). Adaptações: `sales-platform-sale.ts` só com Payt e Braip (sem `saleCapiCustomData`/`informedSaleValue`, que são da Yampi/Brink Park), datas da Braip pelo `sao-paulo-timestamp.ts` da 6.0 com o teto do recebimento; a URL própria da regra Braip nasce sempre desativada também na API; card sempre no hub; sem `package-billing.policy`, sem filtro privado e sem a checagem de acesso da conta na URL (licença bloqueada = 423 no guard global). b4d71afc/#166/#169 (certificar/"Liberar plataforma") **não** viraram passo do aluno: só a tela "Leitores de webhook", somente leitura, com "Em uso". Sem variável nova.

### 6.6 — Hotmart (migrations)

- **Itens:** #182 (`b134534b`).
- **Migrations:** `20261027150000_hotmart_provider` e `…150100_hotmart_parser_release`, **certificada** pela produção direta (§0) se o SaaS já tiver validado a Hotmart; sem essa validação, a Hotmart espera.
- **Adaptações:** sem billing.
- **Testes:** `hotmart-*` (parser, certification, migration), integration-endpoints, web.
- **Notas:** backup obrigatório.
- **Estimativa:** ~3 dias.

### 6.7 — Yampi (migrations; entra por último junto com o ROI Chat)

- **Itens:** #186 (`1889af48`), #187 (`087df11b`) e #188 (`bce48c6c`). Não há outro commit Yampi no `origin/main` do SaaS (`git log -i --grep=yampi`, 27/10/2026).
- **Migrations:** `20261027160000_yampi_provider` e `…160100_yampi_parser_release`.
- **Produção direta (§0):** a Yampi está **validada**: payloads reais da Yampi chegaram ao SaaS e foram lidos corretamente pelo leitor; o #187 e o #188 foram feitos a partir desse formato real (regra do Samuel de 27/10/2026: payload real recebido e lido corretamente = validado). A release entra **certificada por migration** e as regras nascem enviando. Veja "Decisões do Samuel (27/10/2026): Yampi", no fim.
- **Adaptações:** liberada, sem `private-sales-platform-gate` nem `yampi-feature-gate`; os tokens de login continuam ocultos nos links.
- **Testes:** `yampi-*`, `unattributed-sale-certify` (#187).
- **Notas:** backup obrigatório.
- **Estimativa:** ~3 a 4 dias.
- **Execução (27/10/2026, branch `feat/fase-6.7-yampi`):** portados #186, #187 e #188. Leitor `yampi/automation-v1` (pedido pago e mudança de status para pago = a mesma compra; boleto/Pix = `InitiateCheckout`; `cart.reminder` = `CartAbandoned`; valor só dos produtos, BRL; produto principal pelo maior valor), `saleCapiCustomData` da Yampi em `sales-platform-sale.ts` e na produção (itens reais com order bump, `num_items`, `content_name`, `order_id`; aviso `sale_capi_items_value_mismatch` sem dados pessoais) e `customData` gravado no `ConversionEventLog` por `recordExternalConversion`. Migrations `20261027160000_yampi_provider` (só enum) e `20261027160100_yampi_parser_release` (certificada, `ON CONFLICT`, só promove `observation_only`). Adaptações: liberada para todos os workspaces (sem `private-sales-platform-gate`, `yampi-feature-gate`, `yampiEnabled` nem chave em Integrações privadas); sem o hunk de billing (`package-billing.policy`); a URL própria da regra Yampi nasce sempre desativada também na API (reabrir/girar responde 409, como a Braip); card sempre no hub (Atendimento e vendas, logotipo neutro provisório igual ao do SaaS); textos sem "em certificação"; compra manual pelo id do pedido (`manual-conversion-sales-platforms.ts`); mascaramento de `x-yampi-hmac-sha256`, `login_url` e tokens em links (já portado na 6.5). Fixtures sanitizadas (pedido pago, pedido com order bump e links de login, boleto/Pix, carrinho). Sem variável nova. Docs: CHANGELOG, `unreleased.json` (passo 23 da verificação), `docs/setup/yampi.md`, GUIA-ALUNO, `url-unica.md`, README do setup.

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
- **Execução (27/10/2026, branch `feat/fase-6.8-roichat`):** decisão do Samuel de 27/10 (§ "Decisões do Samuel (26/10/2026): GATE 1 APROVADO", item 6): o ROI Chat entra agora, validado com os payloads reais recebidos no SaaS, em produção direta. Portados #183 (`f4f74673`) e #185 (`37bee70d`); nenhuma correção posterior do ROI Chat no `origin/main` do SaaS (`git log -i --grep=roichat --grep="roi chat"`). Migrations `20261027170000_roichat_provider` (só enum, ADD VALUE IF NOT EXISTS em `InboundWebhookProvider` e `DiagnosticSource`, **sem** `WhatsappSeatProvider`) e `20261027170100_roichat_parser_releases` (`roichat/v1` e `roichat/automation-v1` **certificadas**, ON CONFLICT, só promove o que estiver `observation_only`, retirada continua retirada). Adaptações: sem `roichat-feature-gate`, sem integrações privadas, sem hunks de billing/vaga (`externalChannelSeatProviders` e `legacy-billing-backfill` não existem no nod) e sem a contagem de evidência do replay (só existe no SaaS); card sempre no hub, na aba WhatsApp ao lado de WAHA e Meta Cloud; o número ROI Chat é roteado como os provedores genéricos (rota aprendida pelo anúncio da entrada; o modo Herdar do workspace é só do Unnichat); `receivedAt` entra no `inboundWebhookParserContext` do nod (observação, produção e replay); origem `automation_roichat` na matriz de capacidades do nod; leitores no `inboundParserProductionEligible`. Novo: dedupe entre a entrada do ROI Chat e um número WAHA do mesmo lead (trava do #153), 423 nas escritas do ROI Chat e guia `docs/setup/roichat.md`. Sem variável nova.

### 6.8b — GoHighLevel (reservada; depois de terminado no SaaS)

- **Decisão de 26/10:** o GoHighLevel VAI, mas só depois de **terminado no SaaS**. Hoje ele só observa e não envia nada à Meta; o branch `feat/gohighlevel-automation` do dash-com-ia está em revisão.
- **Itens:** #128–#133 do SaaS mais o que o `feat/gohighlevel-automation` trouxer quando for mesclado no `main` do dash-com-ia (hashes a definir).
- **Migration:** timestamp reservado `20261027180000_*` (nomes definidos no porte).
- **Adaptações previstas:** card no hub sem gate de integração privada; o teste `integrations-hub-registry` do nod, que hoje exige o GHL fora, muda junto; envio pela regra (#155/#159) e guard do #153.
- **Gate:** só começa com o GHL mesclado e validado no SaaS. **PENDENTE:** escopo e estimativa depois do merge no SaaS.

### 6.9 — Absorver os PRs do nod (#91 e #92), fora do porte

- Plano próprio depois da 6.8: rebase sem o #90, migration renomeada e chaves de dedupe do #158/#153.
- Estimativa à parte (~5 a 7 dias).
- **Ordem real (27/10/2026):** a 6.9 vem **antes** da 6.6, 6.7 e 6.8, que esperam validação no SaaS. Ela não depende delas.

```text
Status: IMPLEMENTADA (27/10/2026), aguardando revisão; sem push nem PR
Branch: feat/fase-6.9-absorver-91-92 (a partir de origin/integracao/fase-6 @ ca3485fa)
Executor: Claude Code
Modelo/reasoning: Claude Opus 5.5
Task file: .hermes/plans/PORTE-SAAS-PARIDADE-FASE-6.md §6.9
Escopo: PR #91 (formulários Meta / Lead Ads + etapa via CAPI for CRM) e PR #92 (importação do Dashboard Leads), sem o #90
Migrations: 20261027145000_meta_lead_forms (aditiva, idempotente; > 20261027140100_braip_parser_release e < 20261027150000 reservado à 6.6)
Testes: meta-lead-forms (parser, roteamento, payload CRM, ingestão, envio), conversão manual + etapa CRM, import do Dashboard Leads,
        delete-workspace-order, migration; licensing-client + brand-footer/app-layout/navigation
```

**O #90 é dependência dos dois e não entra.** O #91 e o #92 foram empilhados sobre ele (`lead-status.service`, `PATCH /leads/:id/status`, `manual_status`, `Lead.statusChangedAt`/`statusChangedByUserId`, migration `20261017090000_lead_manual_status`). O #90 já está fechado no GitHub; nada dele é trazido.

**O que entra do #91 (portado):**
- tabelas `MetaLeadFormConnection` e `MetaLeadSubmission` (tokens cifrados com `META_TOKEN_ENCRYPTION_KEY`);
- `apps/api/src/meta-lead-forms/*`: leitor do webhook `leadgen`, roteamento por Página/formulário com catch-all, cliente Graph (`appsecret_proof` com `META_APP_SECRET`), payload CAPI for CRM (`system_generated`, `lead_id` como literal numérico, `em`/`ph` com hash, janela de 28 dias, `event_time` de no máximo 6 dias), CRUD `/integrations/meta-lead-forms` (só quem gerencia integrações) e "Assinar Página";
- `POST /webhooks/meta`: depois da assinatura conferida, um `leadgen` de Página com conexão ativa vira lead (uma pessoa por telefone, variantes do nono dígito, atribuição do WhatsApp preservada) e envio de formulário; Página sem conexão segue o caminho antigo de diagnóstico;
- `ConversionEventsService.recordLeadFormCrmConversion` e o desvio no `sendReadyEvent` para o dataset do CRM (`sendLeadFormCrmEvent`);
- web: seção "Formulários Meta" no card Meta de Integrações, origem "Formulário Meta" no lead, gatilho "Formulário Meta (CRM)" nos eventos;
- guia `docs/setup/meta-lead-forms.md`.

**O que é adaptado no #91:**
- **"Qualificado" ligado ao #158/#176:** não existe mais botão de status. A etapa de CRM sai quando um QualifiedLead é registrado pela **conversão manual** (#158) ou pelo **arraste no Kanban** (#176, que usa a mesma conversão manual): se o lead tem envio de formulário lido, grava também o evento `meta_lead_form_crm` (evento da conexão, padrão `LeadQualificado`) e o enfileira. "Não enviar à Meta" na conversão manual também não envia a etapa. Se a conversão manual responder "Lead já convertido" (o lead já tinha QualifiedLead por regra), a etapa do CRM ainda é registrada uma vez, porque é outro dataset.
- **Dedupe (#153/#158):** o evento de CRM fica **fora** do guard de uma conversão por lead por pixel: é outro dataset (CRM), com `event_id` próprio `{lead_id da Meta}:{evento}` (o mesmo do Dashboard Leads, para a Meta descartar duplicatas) e chave `{ws}:meta_lead_form_crm:{event_id}`. O QualifiedLead do WhatsApp continua com o `event_id` e a chave do #158/#153; um lead com formulário e WhatsApp manda os dois, cada um ao seu destino.
- **"Reenviar bloqueados" (#181):** entra. Configuração faltando (dataset, conexão pausada, token ilegível) fica `not_configured`/`MissingMetaDestination` e é reenviada pelo botão; falha de login da Meta (190/102) passa a guardar `error.code` na resposta e entra na janela de 7 dias do #181. Recusa comum (código 100…) não é reenviada.
- **Produção direta:** a conexão nasce **ativa** e envia sem passo de liberação; a única ação é "Assinar Página" (é a inscrição do app na Página, não uma liberação). Textos sem "observação", "teste" ou "liberar".
- **Licença:** criar, editar, assinar, pausar e remover conexão são escritas (423 pelo guard global); o webhook também é POST e segue a mesma regra de todos os webhooks.
- **Excluir workspace:** `delete-workspace.js` apaga `metaLeadSubmission` e `metaLeadFormConnection` antes de `lead`.
- Textos com acentuação; nenhum dado de cliente nos testes (fixtures sanitizados, telefones e nomes fictícios).

**O que entra do #92 (portado com adaptação):**
- script `pnpm --filter @wpptrack/api dashboard-leads:import` (`--map`, `--create-workspaces --owner-email --actor-email`, dry-run por padrão, `--apply`, idempotente), leitor PostgREST do Supabase sem dependência nova, guia `docs/setup/dashboard-leads-import.md`.
- **Chaves de dedupe adaptadas:** o que o Dashboard Leads já enviou vira evento `imported` com a chave que o nod usaria:
  - formulário com conexão: a mesma chave e o mesmo `event_id` do `meta_lead_form_crm` acima (a etapa não é reenviada);
  - WhatsApp: `manual_conversion` com o `event_id` do #153 (`leadLifetimeMetaEventId`) e chave `manual:{ws}:dashboard-leads:{id}`; só para `QualifiedLead` e `LeadSubmitted` (eventos "uma vez por lead" do catálogo). Outro nome de evento não é importado e o relatório conta (`eventsNotImported`).
  - o guard do #153 passa a contar a conversão manual `imported` (o Dashboard Leads já enviou), e o Kanban a põe na coluna da etapa; assim nem a automação nem um novo registro manual reenviam.
- Status do lead mapeado e só para frente (`Lead.status`); sem `statusChangedAt` (era do #90).
- `--create-workspaces` com as mesmas travas da tela do backoffice (`acquirePlatformWorkspaceWriteLocks`, responsável cliente ativado, autor `platform_owner`).
- **Licença:** com a licença bloqueada, `--apply` recusa (equivalente ao 423 das escritas); o dry-run continua.
- **"Só em teste" (decisão 5 do Gate 1):** a importação do #92 só rodou numa instalação de teste, nunca em aluno real. Não há dados a reconciliar nem migration de correção de chaves; o script entra como comando manual opcional, sem variável de ambiente.

**O que fica fora e por quê:**
- todo o #90 (substituído pelo #158 e pelo #176; fechado);
- a migration `20261017090000_lead_manual_status` e as colunas `Lead.statusChangedAt`/`statusChangedByUserId` (auditoria do #90; a conversão manual já audita quem registrou);
- o "status travado" do #90 (concorre com o Kanban);
- a fonte `web` e o campo `notes` do Dashboard Leads (como no #92);
- billing, servidor de licença, integrações privadas e Brink Park (regra fixa do nod).

**Migrations:** só `20261027145000_meta_lead_forms` (renomeada de `20261017100000_meta_lead_forms`): `CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS` e as FKs dentro de blocos `DO` que conferem `pg_constraint`. Aditiva, sem tocar em dados existentes. Timestamp maior que `20261027140100_braip_parser_release` (a maior da integração) e menor que os reservados da 6.6 em diante, que continuam válidos.

**Conflitos com as fases 6.x já mescladas e como ficaram:**
- **#153 (guard) / #158 (conversão manual):** CRM fora do guard (outro dataset); `imported` manual conta como convertido; a etapa sai da conversão manual (ver acima).
- **#159 (regra única por provedor):** sem relação: o formulário não é provedor de regra.
- **#176 (CRM Kanban):** arrastar para QualifiedLead usa a conversão manual, logo envia a etapa; o quadro aceita a conversão manual `imported`.
- **#181 (Reenviar bloqueados):** ver acima.
- **Produção direta (6.1c):** conexão nasce ativa; nada a liberar.
- **6.4 (CAPI em lote):** o evento de CRM sai antes do roteamento e nunca entra no lote (outro dataset e outro token).

**Riscos:** o envio real do `leadgen`, a leitura real na Graph e o envio real ao dataset do CRM não foram feitos no nod (**PENDENTE:** validação com uma Página real); a importação contra o Supabase real só rodou em teste.

**Execução (27/10/2026):** implementada como planejado. Ajustes vindos da revisão independente: etapa sem dataset nasce `not_configured`/`MissingMetaDestination` (sai por "Reenviar bloqueados" depois de corrigir); "Editar" no painel (dataset, evento e tokens; o PATCH já existia no #91); envio ao dataset com trava `ready_to_send → dispatching` e coberto pela recuperação de envio interrompido da conversão manual; cópia de auditoria com `lead_id` em texto; o webhook ingere só os `leadgen` das Páginas conectadas e manda o resto ao caminho de diagnóstico, respeita `x-workspace-id` e responde 503 quando a leitura na Graph falha (a Meta reentrega); uma Página só pode ser conectada em um workspace da instalação; lead já qualificado por regra ganha "Enviar só a etapa do formulário" na confirmação; etapa importada do formulário com o nome de evento que o Dashboard Leads realmente enviou. Migration validada num PostgreSQL 16 descartável (deploy sobre a integração e num banco vazio, SQL reaplicado sem efeito, sem drift novo). Correção da Braip (venda real no SaaS, Samuel, 27/10/2026) aplicada no comentário da migration `20261027140100` (o checksum dessa migration muda; `migrate deploy` e `migrate status` aceitaram no Docker), no guia, no CHANGELOG e nas notas. Fica PENDENTE: botão "Ler de novo" para envios `fetch_failed`; rodar o import dentro do container do Dokploy.

### Totais

- **6.0 a 6.8** (com a 6.1c proposta, ~3 a 4 dias, e sem a 6.8b, ainda sem estimativa): ~63 a 74 dias de execução com revisão, um escritor por vez. A 6.4 e a 6.3b podem correr em worktree separado da 6.5 a 6.8, porque têm poucos arquivos em comum. Com isso, o calendário fica em ~45 a 55 dias.
- **Mínimo para a Fase A original** (6.0 + 6.1a + 6.1b): ~17 dias (a 6.1a ganhou #66/#85/#86, ~1 dia).

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

```text
Status: IMPLEMENTANDO
Branch: feat/fase-6.8-roichat (worktree C:\Users\samue\Documents\nod-fase-6.8, a partir de origin/integracao/fase-6 @ ca3485fa)
Executor: Claude Code
Modelo/reasoning: Claude Opus 5.5
Task file: .hermes/plans/PORTE-SAAS-PARIDADE-FASE-6.md §6.8
Escopo: #183 (f4f74673) e #185 (37bee70d); dedupe ROI Chat x WAHA; 423; nada além
Migrations: 20261027170000_roichat_provider (enum, aditiva, IF NOT EXISTS) e 20261027170100_roichat_parser_releases (releases certificadas, ON CONFLICT, idempotente); timestamps > 20261027140100_braip_parser_release
Testes: fase6-roichat (parsers com a fixture real do #185, integration, purchase-rule, provider-migration, license-lock 423), dedupe ROI Chat x WAHA em fase6-envio-meta, web roichat-integration + integrations-hub-registry; licensing-client + brand-footer/app-layout/navigation
```

### Gate 2 — 6.7 (preenchido em 27/10/2026)

```text
Status: IMPLEMENTANDO
Branch: feat/fase-6.7-yampi (worktree C:\Users\samue\Documents\nod-fase-6.7, a partir de origin/integracao/fase-6; rebase em 53ffd184, depois da 6.9, 6.9b e 6.8)
Executor: Claude Code (subagente do orquestrador)
Modelo/reasoning: Claude Opus 5.5
Task file: .hermes/plans/PORTE-SAAS-PARIDADE-FASE-6.md §6.7
Escopo: SaaS #186 (1889af48), #187 (087df11b) e #188 (bce48c6c), nada além; sem gates privados, sem billing
Migrations: 20261027160000_yampi_provider (só enum, ADD VALUE IF NOT EXISTS) e 20261027160100_yampi_parser_release (certified, ON CONFLICT, só promove observation_only); aditivas; timestamp > 20261027140100_braip_parser_release
Testes: apps/api/test/fase6-yampi/* (parser, migrations, URL única, ingestão por regra, contents/order_id, mascaramento, compra manual, 423), produção com itens (fase4-unnichat/payt-no-ad-ctwa-purchase), web yampi-integration + hub/route, shared yampi-sales-platform-contracts; mais licensing-client e brand-footer/app-layout/navigation
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
    - sem regra de Lead recebido, ou com `LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED=false`, nada muda (a flag vem ligada por padrão);
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
6. **Certificação:** um leitor validado com venda real no SaaS vai **certificado por migration** para o nod. O aluno não precisa liberar nada. ~~a regra continua começando em observação e é ativada pelo aluno~~ **Substituído em 26/10 pela produção direta (§0): conexões e regras nascem em produção.** **Decisão do Samuel (27/10/2026):** o ROI Chat vai para o aluno agora, sem esperar validação no SaaS (o teste real é numa conta de aluno). Entra funcionando em produção direta: leitores certificados por migration, conexão e regras nascendo enviando, sem passo de observar, retestar ou liberar para o aluno. Ajuste da regra no mesmo dia: payload real recebido e lido corretamente pelo leitor = validado; o ROI Chat conta como validado com os payloads reais recebidos no SaaS (o #185 corrigiu o leitor a partir do formato real).
7. **Escopo:** levar **tudo** que afeta o uso dos alunos, sem entregar pela metade. O prazo não é o problema.

## Decisões do Samuel (26/10/2026, depois da auditoria)

A auditoria de 26/10 releu o histórico do SaaS anterior ao #152 e achou itens que afetam o aluno e não estavam no inventário. Eles entraram nas fases assim:

| Item do SaaS | Fase | Observação |
|---|---|---|
| #66 (`37572ad9`), #85 (`ff28d8a1`), #86 (`71e69a95`) | 6.1a (antes do #159) | A ativação da regra não trava com número órfão ou duplicado. Cobre a ponte WAHA/Uazapi |
| 75f6f4b3 (parcial) | 6.1b | Janela de 7 dias da Meta também nos eventos com anúncio das automações |
| #63 (alerta de desconexão por instância, 2 leituras) | 6.1c | **VAI.** No nod o alerta por instância nunca roda |
| #91 do SaaS (reenviar itens de replay que falharam) | 6.1c | **VAI**; implementado na recuperação do aluno (owner) |
| #61, #69, #83 (parcial) | 6.3a | #83: só a parte de relatórios |
| #62 | 6.3b (primeiro item) | Base da barra de filtros |
| 7570fe14 (parcial, Kommo) | 6.5 | Sem a parte do Guimo |
| Guimo | — | **NÃO VAI**: é de um cliente só |
| GoHighLevel | 6.8b (reservada) | **VAI** depois de terminado no SaaS (`feat/gohighlevel-automation` em revisão) |

- Correção do inventário: "client-swap" é o SaaS #102 (`52d255dc`, mais a parte de client-swap do #83), e não "#134/#135"; #134/#135 são o Kommo (front e back), que já está no nod.
- Ordem atualizada: 6.0 → 6.1a → 6.1b → 6.1c → 6.2a → 6.2b → 6.3a → 6.3b → 6.4 → 6.5 → 6.6 → 6.7 → 6.8 → 6.8b → 6.9.
- Confirmado: a 6.1c (alerta de desconexão, reenvio de replay e, desde 26/10, produção direta) fica logo depois da 6.1b.

## Regra fixa: produção direta (26/10/2026)

Registrada a pedido do Samuel, que já a repetiu muitas vezes; vale para todas as fases seguintes (6.5 a 6.8b) e está detalhada na §0. Resumo: o que foi validado no SaaS chega ao aluno **em produção**. Os leitores entram **certificados**; conexões e regras nascem **em produção**; o aluno não retesta, não certifica e não libera nada. Observação só para o que não foi validado (e isso não é portado). As travas reais (licença, rota Meta, pixel e página, `META_APP_SECRET` no Meta Cloud) continuam, e a tela diz o que configurar. No nod **não existe QR**: Uazapi BYO e WAHA conectam por URL do servidor + token, uma conexão por número.

## Regra fixa: o que conta como validado (27/10/2026)

Ajuste do Samuel: **payload real recebido e lido corretamente pelo leitor = validado**. Não se escreve PENDENTE de "venda real" (no SaaS nem numa instalação de aluno) para nenhuma plataforma, nem nas notas, nem nos guias, nem neste plano. Continuam valendo os PENDENTEs técnicos genuínos (por exemplo, na Braip: `trans_value`, fuso, abandono e renovações).

## Regra fixa: documentar para a IA do aluno (26/10/2026)

Pedido do Samuel, válido para todas as fases. Toda mudança que pede ação do aluno precisa estar escrita no repositório, para que o Claude ou o Codex do aluno saibam exatamente o que fazer quando ele atualizar ou mexer na instalação. Isso vale para variável nova ou com padrão alterado, passo diferente na atualização e mudança no fluxo de uso.

A fase só fecha com os seguintes arquivos atualizados no mesmo commit:
- `.env.example`;
- `docs/setup/environment.md`;
- a linha de notas de atualização do `CHANGELOG.md`;
- o guia de `docs/releases/unreleased.json`;
- `docs/setup/update.md`, se o procedimento mudar;
- o guia da integração afetada.

A seção "Quando o aluno pedir para atualizar ou mudar algo" do `docs/AI_AGENTS.md` aponta a IA do aluno para esses arquivos.

## Decisões do Samuel (27/10/2026): Yampi

- **A Yampi vai para o aluno agora** (fase 6.7). O teste real será feito numa conta de aluno, não no SaaS: não se espera mais validação no SaaS.
- **Payload real recebido e lido corretamente = validado.** Payloads reais da Yampi já chegaram ao SaaS e foram lidos corretamente; o #187 e o #188 foram feitos a partir do formato real. A Yampi conta como **validada** (sem `PENDENTE: validar com venda real`, nem na conta de aluno nem no SaaS). No guia do aluno, o "teste" é só a conferência de funcionamento depois da instalação.
- **Produção direta:** leitor certificado por migration (`20261027160100_yampi_parser_release`); URL única e regras nascem enviando; nenhum passo de observar, retestar ou liberar para o aluno.
- **Liberada para todos os alunos:** no SaaS a Yampi é plataforma privada de um cliente; no nod ela entra **sem** `private-sales-platform-gate` e **sem** `yampi-feature-gate` (nem `yampiEnabled`, nem chave em Integrações privadas).
- Os PENDENTEs técnicos genuínos continuam no guia (`docs/setup/yampi.md`): nome do status do `order.created` de boleto/Pix, `value_products` com cupom, marcador do envio de teste, caminho do menu de webhooks no painel da Yampi, logo oficial e itens reais do carrinho abandonado.
