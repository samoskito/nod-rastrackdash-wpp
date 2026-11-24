# PLANO — Porte do CRM do SaaS (estado do main com o #303)

> **Status: CRM-1 APROVADA pelo Samuel em 24/11/2026 e implementada no PR `feat/crm-periodo-conversao` (aguardando merge). CRM-2 e CRM-3 não pedidas.**
>
> - Base do levantamento:
>   - nod `origin/main` @ `35d87c58` (#146);
>   - dash-com-ia `origin/main` @ `73cab362` (#304, já com o #303).
> - Data: 2026-11-24.
> - Pedido: portar o CRM (quadro kanban) do SaaS para o nod, incluindo o filtro de período do #303.

## 0. Achado que muda o pedido

**O nod já tem o CRM.** Ele entrou na Fase 6.2b (`7ba91bf9`, porte do SaaS #176) e foi ajustado na 6.4, 6.9, 1.3.1 e no visual novo (`2fcbc7f6`). O `origin/main` do nod já tem:

- a API `apps/api/src/crm/*`: controller, módulo, `crm-board.service.ts`, `crm-board-query.ts` e o "Carregar mais" por coluna;
- o schema compartilhado `packages/shared/src/schemas/crm.ts`;
- a tela `apps/web/src/app/(app)/crm/*`: quadro, colunas pela Jornada, arrastar gerando conversão, "Mover para…", "Carregar mais", layout mobile com abas por etapa e quadro arrastável (`useDragToPan`);
- os testes `apps/api/test/fase6-crm-kanban/*` (SQL com pglite, service, conversão manual importada, bloqueio pela licença), `apps/web/tests/crm-board.test.ts` e `packages/shared/tests/crm.test.ts`.

O que tinha "sumido" na checagem anterior é que o checkout local do nod está 50 commits atrás do `origin/main`. Por isso este plano porta **só a diferença** entre o CRM do SaaS e o do nod, e não o CRM inteiro.

## 1. O que o SaaS tem a mais (PRs de CRM depois do #176)

| PR SaaS | O que é | Depende de | No nod hoje | Decisão proposta |
|---|---|---|---|---|
| #303 | Filtro de período: Leads novos (e a coluna base) pela chegada do lead; as outras colunas pela data da conversão (`eventOccurredAt`); conta todo status exceto `skipped`; fuso `WPPTRACK_REPORT_TIMEZONE` (padrão America/Sao_Paulo) | Nada novo. A Visão geral do nod já conta `status <> skipped` (`leads/lead-cohort.ts`) e a variável já existe | Período só pela chegada do lead e só conversões válidas | **PORTAR (Fase CRM-1)** |
| #204 | Quadro arrastável e colunas ajustáveis | `drag-to-pan` | Já portado | — |
| #205 / #202 / #203 | Densidade, marca e moldura | — | Já portado (`2fcbc7f6`) | — |
| #196 / #197 / #198 / #201 | Pipeline **Formulário** no CRM (`crm-form-board.*`, abas de pipeline, "Registrar no") | Formulários Meta inteiros (`meta-lead-forms`, webhook `leadgen`, `MetaLeadFormConnection`), `ConversionEventLog.deliveryChannel` (migration `20261028090000_meta_lead_form_pages`) e o gate de produto `workspace-products` | **Retirado na 1.3.1**, com o teste `retired-lead-form-crm` garantindo que a etapa de CRM do Formulário termina como `skipped` | **FORA.** Voltar com o Formulário é outro porte grande (várias migrations, tela de Integrações e webhook), com plano próprio se você quiser |
| #284 | Filtro "Origem do lead" (CTWA, Formulário, Site) | `Lead.origins` (migration `20261027180000_lead_identity`) e o mesmo filtro na Visão geral e em Leads | Não existe. No nod todo lead é CTWA; o filtro só aparece com mais de uma origem | **FORA** (sem efeito com uma origem só). Entra junto com o Formulário, se ele voltar |
| #292 | Selo "Em observação" no card | `Lead.observationOnly` (migration `20261123130000_lead_observation_only`) e o modo observação por conexão (`processingMode: observation`) | Não existe esse modo no nod | **FORA deste porte.** Precisa do modo observação inteiro antes; candidato a plano próprio |
| — | Gate de produto (`workspace-products`) no controller | Contratação de produto do SaaS | — | **NUNCA** (é comercial do SaaS) |

Também nunca vão para o aluno: billing, Asaas, licença do SaaS, integrações privadas (`*_WORKSPACE_IDS`, One Code, Kinbox privada) e Brink Park.

## 2. Customizações do nod que o porte preserva

- **Conversão manual importada** (`IMPORTED_MANUAL_CONVERSION_STATUS`, linhas da importação da 1.3.0) continua valendo como conversão do quadro. O SaaS não tem essa regra; o teste `crm-board-imported-manual-conversion.test.ts` continua passando.
- **Achado na implementação:** o nod tinha um teste dizendo que logs `imported` da importação MySQL externa nunca posicionam o card. Pela regra do #303 ("todo status exceto `skipped`", como a Visão geral), eles passam a posicionar depois de Leads novos. A Visão geral do nod já os conta (`meta-reporting.service.ts`, `status: { not: "skipped" }`). Segui o #303 e atualizei o teste; a entrada importada de outro gatilho continua fora de Leads novos. Isso está nas notas de release.
- **Bloqueio pela licença** (423 ao mover card com a licença bloqueada) continua igual; o teste `crm-kanban-license-lock.test.ts` não muda.
- **Saneamento de strings vazias** do nod no service (campanha, anúncio e número sem nome não quebram o quadro) fica como está. As diferenças de formatação do SaaS não são portadas.
- **Mensagens de erro em português** ("Consulta inválida") ficam.
- **Sem filtro por `deliveryChannel`:** o nod não tem a coluna. Sem o Formulário, todo log é de mensagem (CTWA), e o filtro do SaaS seria sempre verdadeiro.

## 3. Migration

**Nenhuma.** O #303 só muda a consulta (SQL) e o schema compartilhado. O índice que o SaaS usa já existe no nod: `ConversionEventLog(workspaceId, eventName, eventOccurredAt)` (conferido no `schema.prisma` do `origin/main`).

## 4. Fases

### CRM-1 — Filtro de período pela data da conversão (porte do #303)

Branch `feat/crm-periodo-conversao`, num worktree novo a partir do `origin/main` (o checkout local tem arquivos não rastreados que ficam intactos).

- **shared** (`packages/shared/src/schemas/crm.ts`): `CRM_OVERVIEW_EXCLUDED_STATUS = "skipped"`, com o comentário do SaaS. `CRM_BASE_STAGE_EVENT` já existe.
- **API** (`apps/api/src/crm/crm-board-query.ts`):
  - `stageConversionSql`: uma conversão válida (regra atual do nod, **com** a manual importada) **ou**, nas etapas depois da base, qualquer status exceto `skipped`. Mesma regra com e sem período, para o "mover card" concordar com o quadro;
  - com período: o lead entra se chegou no período **ou** tem conversão de etapa no período. São três selects unidos por `UNION`, em vez de um `OR` (aproveita os índices);
  - com período, só as conversões dentro dele posicionam o card (a mais avançada). Colunas até a base filtram por `arrived_at`; as seguintes, por `entered_at`;
  - fica fora do SaaS: `crmObservationConversionSql`, a coluna `observed`, `origin` e `deliveryChannel` (ver §1 e §2).
- **API** (`crm-board.service.ts`): `CRM_TIMEZONE = process.env.WPPTRACK_REPORT_TIMEZONE ?? "America/Sao_Paulo"`, o mesmo limite de dia da Visão geral.
- **Web:**
  - `crm-board.tsx`: o texto vazio vira "Nenhum lead de anúncio neste período com estes filtros.";
  - `crm-filters.tsx`: o comentário e a ajuda do período dizem "chegada nas primeiras colunas, data da conversão nas outras".
- **Testes:**
  - portar `apps/api/test/crm-board-conversion-period.test.ts` (254 linhas, pglite) para `apps/api/test/fase6-crm-kanban/`, sem os casos de Formulário, origem e observação. O `test/helpers/crm-pglite.ts` do nod recebe só o que esse teste usar;
  - os ajustes do #303 em `crm-board-sql.test.ts` e `crm-board.service.test.ts`;
  - nada de `crm-form-pipeline` nem `lead-form-pipeline`.
  - Casos obrigatórios:
    - lead que chegou antes do período e comprou dentro dele aparece em Compra;
    - lead novo de ontem não pula para uma compra feita hoje quando o período termina ontem;
    - conversão com erro/bloqueada (status diferente de `skipped`) posiciona o card;
    - `skipped` não posiciona;
    - a manual importada continua contando;
    - limite de dia no fuso de São Paulo.
- **Verificação:** `pnpm --filter api test`, `pnpm --filter web test`, `pnpm --filter shared test` e `tsc --noEmit` nos três, tudo limpo.
- **Prints** (fora do git, dados fictícios): `/crm` em 1440 e 375, com um período em que um lead antigo aparece em Compra.
- **Docs para a IA do aluno:**
  - `docs/GUIA-ALUNO.md`, seção 10.7 (CRM Kanban): como o período funciona;
  - `CHANGELOG.md`: "ported from the SaaS (#303)";
  - `docs/setup/update.md`: só se mudar algum passo; sem migration nem variável nova, deve bastar uma linha;
  - notas em `docs/releases/unreleased.json`, consolidadas com o que já está lá (GoHighLevel e #146). Sem versão inventada; `PENDENTE:` para o que não foi testado em instalação de aluno.
- **PR no nod, sem mesclar.** Merge só com o seu OK na conversa orquestradora.

### Opcionais (só se você pedir; cada um com plano próprio)

- **CRM-2:** modo observação por conexão + selo "Em observação" (#292). Tem migration aditiva `Lead.observationOnly` e mexe na entrada CTWA.
- **CRM-3:** Formulários Meta de volta (#191–#201), com pipeline Formulário no CRM e filtro Origem do lead (#284). Tem migrations aditivas (`deliveryChannel`, `origins`, páginas do Formulário) e desfaz a retirada da 1.3.1.

## 5. Riscos

- **Desempenho do `UNION`** em contas grandes. O SaaS já roda assim em produção; o teste SQL confere o plano com pglite, não com volume.
- **Mudança de número visível para o aluno:** com período, colunas como Compra passam a mostrar mais leads, os que chegaram antes e converteram no período, e erros e bloqueios também contam. As notas explicam que agora o quadro bate com a Visão geral.
