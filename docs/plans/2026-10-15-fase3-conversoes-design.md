# Fase 3 — Tela Conversões (alcance da regra + Unificar) — design aprovado

Data: 15/10/2026. Aprovado pelo Samuel em 15/10/2026.
Plano geral: [`2026-10-15-port-front-saas-design.md`](2026-10-15-port-front-saas-design.md).
Origem no SaaS (`samoskito/dash-com-ia`): commits `90ac4c0`, `8e4fc7c`, `e639851`, `de9260b`,
`7516b33`, `1918e02`, `453518c`, `6dbbfe0`, `e1c23df`, `db961b6`; migrations
`20261012090000` e `20261014120000_provider_rule_workspace_scope`.
Base: Fase 2 (Hub com 4 abas, PR #80). Implementação começa depois do PR #80 em `main`.

## Decisões

| Tema | Decisão |
|---|---|
| Regra global | Sempre ligada, sem variável de ambiente. Alcance: "Todos os números" ou "Números específicos". |
| Números novos | Entram automaticamente nas regras "Todos os números". |
| Precedência | Regra específica com a mesma origem + evento num número sobrepõe a global naquele número. Global roda uma vez por telefone. |
| Regras existentes | Viram "Números específicos" com os mesmos números; comportamento idêntico. "Unificar" é oferecido, nunca forçado, e é reversível. |
| WAHA, Z-API, NOD API | Fora da regra global nesta fase; "Em breve" no Hub (WAHA nunca foi validado). A tela mostra que não são suportados. |
| Kommo (etapa do CRM) | Editado na janela do Kommo no Hub (aba CRM). Conversões lista as regras só para leitura com "Gerenciar no Hub". |
| Painel antigo por conexão | Sai de Configurações no mesmo PR. Configurações fica só com "Jornada". |
| Regras antigas (palavra-chave/etiqueta sem conexão) | Aparecem em Conversões como "Regra antiga": pausar, editar valor, conectar a números. |
| Eventos recebidos | Reprocessar só para automações do provedor. Frase e etiqueta mostram só o histórico de execuções. |
| Sidebar | Item "Conversões" no grupo Gestão, entre Integrações e Configurações; exige `canManageIntegrations`. |

## Dados (migration única e aditiva)

`apps/api/prisma/migrations/2026101512xxxx_provider_rule_workspace_scope` (data após a última
migration de `main` no momento da implementação):
1. `CREATE TABLE "ProviderRuleCreateClaim"` (criação idempotente por `requestKey`), já com
   `connectionId` opcional, CHECKs, índices e FKs como no SaaS (sem o cabeçalho "AUTHOR ONLY").
2. Enum `ProviderConversionRuleScope (all_numbers | specific_numbers)`;
   `ProviderConversionRuleConfig.scope NOT NULL DEFAULT 'specific_numbers'`;
   `unifiedIntoProviderRuleId` (FK para a própria tabela); `connectionId` e `parserReleaseId`
   passam a aceitar NULL; índices do SaaS.
3. Antes dos CHECKs (`binding`: os dois NULL ou os dois preenchidos; `unified_not_self`), um bloco
   `DO $$ … RAISE EXCEPTION` conta linhas que violariam e falha com mensagem clara.
Sem backfill. Preserva `ProviderConversionRuleConfig`, canais, endpoints, execuções, auditorias,
`ConversionRule` antigas e `KommoConversionRule`.

## Backend

- `provider-rule-scope.ts` do SaaS sem a flag `INBOUND_CONVERSION_WORKSPACE_SCOPE_ENABLED` e com a
  mesma matriz do SaaS (`MESSAGE_RULE_CHANNEL_PROVIDERS = umbler, uazapi`;
  `LABEL_RULE_CHANNEL_PROVIDERS = uazapi`, etiqueta por nome entre instâncias); automação continua
  presa à conexão. Gupshup, Data Crazy e Cloud API seguem gerando leads/conversões pelo webhook
  inbound (CTWA), como no SaaS; regra de frase nesses provedores não existe nem no SaaS.
- `provider-conversion-rules.service.ts`: create/update com `scope`, `create-receipt`,
  `unify-candidates`, `unify` (transação, advisory lock, idempotente, auditoria), DTO com canais
  efetivos e "substituída em".
- Endpoints novos em `conversion-rules.controller.ts`: `GET providers/capabilities`,
  `GET providers/unify-candidates`, `POST providers/unify`, `GET providers/create-receipt`.
- Ingestão com alcance: `uazapi-provider-conversion.service.ts` (frase e etiquetas),
  `provider-conversion-observation.service.ts` (umbler, gupshup, data_crazy, meta_cloud),
  production intake, replay, recovery e review-approval.
- Não portar: origens Payt/Unnichat/Guimo/Pipedrive/GoHighLevel (Fase 4), links de cobrança.
- Toda escrita nova passa pelo guard 423 existente.

## Web

- `/conversions`: filtros (origem, número, evento, status), "Nova regra" em passos
  (Origem → Evento → Alcance → Detalhes), avisos "Substituída em X", revisão do Unificar,
  "Gerenciar" por regra, "Eventos recebidos" em lotes de 50, regras antigas, Kommo só leitura.
- Sidebar: `packages/shared/src/navigation.ts` + `components/app-shell.tsx` (mesclar; preservar
  rodapé e `brand.name`).
- Configurações: seção "Jornada e gatilhos" vira "Jornada"; `ProviderConversionRulePanel` sai.
- Kommo: `kommo-conversion-panel` passa para a janela do Kommo no Hub.
- Licença bloqueada: todas as ações de `conversions/actions.ts` mostram o aviso de licença; na
  criação não confirmada, 423 não consulta `create-receipt`.

## Guia de atualização para o aluno

1. Backup do banco (`pg_dump`) antes de atualizar; a migration roda no boot da API.
2. Aparece "Conversões" na sidebar; Configurações fica só com "Jornada"; regras do Kommo ficam
   no Hub → CRM.
3. Todas as regras aparecem como "Números específicos", com os mesmos números. Nada muda até o
   aluno unificar ou criar uma regra "Todos os números".
4. Rollback: antes de voltar de versão, pausar/excluir regras "Todos os números" e reativar as
   originais; a versão anterior ignora as colunas novas. SQL de reversão opcional no guia.
5. Verificação: regras existentes continuam disparando (Eventos recebidos e Eventos Meta).
Sem variável nova e sem dependência nova (confirmar na implementação).

## Testes

API: portar `provider-rule-workspace-scope*.test.ts` e `conversion-rules-controller.test.ts` sem
os casos da flag; novos: mesmo telefone em uazapi_byo e nod_api, etiqueta global entre
instâncias, WAHA ignorado pela global, migration de ida e volta, 423 nas escritas.
Web: `conversions-*.test.ts`, sidebar, Configurações só com Jornada, Kommo no Hub.

## Execução

Worktree `.claude/worktrees/f3-conversions`, branch `port/f3-conversions` a partir de `main` com o
PR #80. Backend (Opus): migration → scope → serviço/endpoints → ingestão → shared → testes.
UI (Sonnet) depois dos contratos shared. Revisão Opus, prints desktop/375, aprovação, PR.

## Riscos

Conversão duplicada ou perdida na ingestão (precedência e "uma vez por telefone"); etiqueta por
nome casando errado; rollback com regra global ativa; merge do `app-shell.tsx`; remoção de seção
grande de Configurações; matriz de capacidade errada para gupshup/data_crazy/meta_cloud.
