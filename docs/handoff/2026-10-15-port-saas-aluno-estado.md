# Passagem de bastão — port do SaaS para o repositório de aluno (estado em 15/10/2026)

Para continuar numa conversa nova (local ou nuvem). Leia também os planos aprovados em
`docs/plans/` (branch `claude/funny-knuth-bjp2ww`):
- `2026-10-15-port-front-saas-design.md` — plano geral, decisões e regras de adaptação
- `2026-10-15-fase3-conversoes-design.md` — Fase 3 (concluída)
- `2026-10-15-fase4-provedores-design.md` — Fase 4 (em andamento)

Origem: `samoskito/dash-com-ia` (SaaS), `docs/handoff/2026-10-15-front-para-repositorio-aluno.md`.
ClickUp: espaço **Geral** → pasta **Student Rastrackdash Wpp** → lista
**Port front SaaS → aluno (out/2026)**.

## Modo de trabalho combinado com o Samuel

- Português do Brasil, direto e curto. Dizer o que está pronto e verificado e o que não está.
- Orquestrador: Opus (alto raciocínio) para backend/migrations/regras/integrações/revisões;
  Sonnet para UI/prints/mecânico; Haiku para buscas. Cada agente num `git worktree` próprio
  (`.claude/worktrees/<nome>`), branch por fase (`port/<fase>`), a partir de `main`.
- Features maiores: desenho primeiro, perguntas uma a uma com opção recomendada, registrado em
  `docs/plans` antes de implementar.
- Antes de cada push: revisão independente (Opus) com veredito "pode subir"/"ajustes
  obrigatórios", typecheck e testes. Mudança visual: prints desktop 1440 e celular 375 numa página
  Artifact com imagens embutidas (base64) para aprovação. Não mandar caminho de arquivo local.
- Depois da aprovação: push, PR para `main`, **merge feito por nós** (squash, título com `(#N)`),
  autorizado pelo Samuel.
- AGENTS.md do aluno: notas para a comunidade no mesmo commit (`docs/releases/unreleased.json` —
  resumo no limite de 2000 caracteres, não crescer; detalhes em changes/upgradeGuide/rollback — e
  `CHANGELOG.md [Unreleased]`). Nunca publicar tag/Release/aviso sem autorização. Preservar licença,
  onboarding e rodapé `RastrackDash · powered by PalmUP`. Migrations só aditivas.
- Nunca pedir nem digitar segredos.
- Comandos: `pnpm install --frozen-lockfile`, `pnpm --filter @wpptrack/shared build`,
  `pnpm --filter @wpptrack/{api,web} typecheck|test`. Chromium para prints em
  `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` (na nuvem); localmente, Playwright normal.

## Regras de produto decididas pelo Samuel (não reabrir)

- **Princípio:** o que está validado no SaaS vem para o aluno com o mesmo comportamento, sem
  revalidar.
- **`ctwa_clid` é obrigatório** (pixel de mensagem): sem ele nada é enviado à Meta. **ID do
  anúncio é opcional** onde o SaaS permite (Unnichat e CRMs Kommo/Pipedrive, via página + pixel).
  Umbler/Gupshup/Data Crazy sem ID do anúncio não enviam (igual ao SaaS).
- **Login social Meta da PalmUP não muda**; alunos não têm app próprio; nenhuma permissão nova.
- Hub com 4 abas: WhatsApp (Uazapi, WhatsApp Cloud API com logo/nome Meta em texto, WAHA/Z-API/
  NOD API "Em breve"), Atendimento e vendas (Umbler, Gupshup, Data Crazy; Payt e Unnichat na
  Fase 4), Anúncios (Meta Ads, login social), CRM (Kommo; Pipedrive na Fase 4).
  Meta Ads (dados de tráfego/CAPI) e Cloud API (webhook de conversas) nunca misturados.
- Logo da Meta: palavra em texto (opção B), como no SaaS.
- Regras de frase/catálogo: Umbler e Uazapi; etiqueta: Uazapi — igual ao SaaS.
- **Guimoo fora do aluno** (específico de um cliente).
- Assinatura/cobrança (Asaas, vagas) fora do aluno.
- Acentuação dos textos antigos: revisão geral depois (tarefa no ClickUp).
- Parser Z-API: aguardando payload real do Samuel (tarefa no ClickUp).

## Já em `main` do aluno (`samoskito/nod-rastrackdash-wpp`)

| PR | Conteúdo |
|---|---|
| #78 | Leads novos × que voltaram; exportar leads CSV/Excel (`exceljs`) |
| #79 | Rodapé visível no celular; banner de licença fora da sidebar |
| #80 | Hub de Integrações com 4 abas; Kommo no Hub; WAHA/Z-API/NOD "Em breve" |
| #81 | Tela Conversões: alcance "Todos os números"/"Números específicos", Unificar, regras antigas, Kommo só leitura; Configurações só com Jornada |
| #82 | Fase 4.0: base de compra CTWA (página + pixel sem ID do anúncio), `ProviderPurchaseClaim`, `metaRoutingMode`, certificação por migration de Gupshup v1/Umbler v1/Data Crazy v1, telefone BR equivalente |

`main` depois do #82: `d26ef44`. Testes em `main`: API ~1390 ok, web 759 ok, 0 falhas.

## Em andamento

Payt e Pipedrive seguem na conversa LOCAL do Samuel (decisão de 15/10). A licença manual segue na
conversa da nuvem.

### 4a Payt — parado em WIP `e3589a4` (branch `port/f4-a-payt`, no GitHub)
Feito (só backend): migrations `20261016100000_payt_inbound_provider` e `20261016100100_payt_parser_releases` (v1 e automation-v1 certificados, sem ativar regras; NÃO aplicadas em Postgres ainda); parser + classificação de eventos de venda; recebimento na URL da regra, reprocessar em observação com aprovação do operador; decisão (canal do lead, valor da Payt, compra duplicada = 1 conversão via claim); envio reconfere a venda; `payt` aceito no envio; conexão Payt própria não pode ser criada; shared (schemas, alcance, capacidades com selo beta); 47 testes novos em `apps/api/test/fase4-payt/` passando ("sem ctwa_clid nada é enviado", "postback duplicado = 1 conversão").
Última suíte API completa: 1389 ok + 1 falha (capacidades, corrigida depois). Depois disso NÃO rodou typecheck/suíte completa da API; web NÃO rodado.
Falta: web inteiro (card Payt em Atendimento e vendas com logo do SaaS, origem Payt em Nova regra com selo beta e regra presa à conexão dos números escolhidos, mensagens 423, Eventos recebidos); docs do aluno; `unreleased.json` + CHANGELOG; aplicar migrations em banco temporário; renomear teste "fails closed on a sale identity no shipped provider can verify"; acentuar mensagens novas da API.
Próximos passos: typecheck + suíte API completa → web + notas → migrations em banco temporário → revisão Opus → prints → aprovação → PR/merge.
Observações: venda de lead sem ID do anúncio só funciona com Unnichat (4b). Filtro de produto é Fase 5.

### 4c Pipedrive + Kommo sem ID do anúncio — parado em WIP `d885796` (branch `port/f4-c-pipedrive`, no GitHub)
Feito: shared `pipedrive.ts` e `crm-channels.ts` + campo `crmDestinationReadiness` (37 testes de `pipedrive.test.ts` ok); migration `20261016120000_pipedrive_integration` (6 tabelas) aplicada em Postgres 16 descartável sem drift; módulo `pipedrive/*` sem flags do SaaS, com checagem de licença no worker e no envio; `crm-channels/*` e `crm-dispatch-context`; `PIPEDRIVE_CRM_ENCRYPTION_KEY` validada no boot só quando definida (≠ chave do Kommo); Kommo com caminho CTWA sem ID do anúncio portado do SaaS (códigos de recusa para leads com anúncio iguais); body parser, log sem `?token=`, `app.module`, exclusão de workspace. Typecheck da API ok; 5 arquivos de teste existentes corrigidos (133 testes ok); suíte completa NÃO rodada depois.
Falhando: 35 dos 399 testes Pipedrive/CRM portados — supõem flags do SaaS (`PIPEDRIVE_CONVERSION_PRODUCTION_ENABLED`, `pipedrive-feature-gate`), mensagens agora acentuadas, harness do Kommo sem `inboundWebhookEvent`, falta stub de licença no DI dos testes HTTP, `crm-channels-any-provider` usa a mesma chave de teste para Kommo e Pipedrive (trocar `alloc(32,7)` por `alloc(32,9)` ~linha 494), `pipedrive-pg-runtime.prepared.ts` não passa a licença.
Falta: corrigir os 35 testes + testes novos (Kommo sem anúncio, "sem ctwa_clid nada é enviado", migration); web (`lib/crm-channel-options.ts`, opções de número no painel do Kommo, `pipedrive-actions` + modal no Hub aba CRM com logo do SaaS e `SOURCES.md`, leitura em Conversões com "Gerenciar no Hub", aviso de licença, testes web); docs (`docs/setup/pipedrive.md`, `environment.md`, `.env.example`, `GUIA-ALUNO.md`, README do setup), CHANGELOG e `unreleased.json` (resumo 1989/2000, não crescer); suítes completas (referência API 1390, web 759); revisão Opus → prints → aprovação → PR/merge.

### Liberar licença manual (SaaS) — CONCLUÍDO
Mesclado em `samoskito/dash-com-ia` (PR #149, 15/10). Falta só o deploy do SaaS e o Samuel liberar o
aluno em Backoffice → Licenças → Liberar licença manual. Conferir na primeira liberação a entrega do
e-mail e a ativação (não testadas em ambiente real).

## Próximos passos

1. (Local) Terminar 4a e 4c a partir dos WIPs acima → revisão Opus → prints → aprovação → merge.
2. 4b Unnichat (depois da 4a): enum + parsers certificados, conexão com `connectedPhone`, seletor
   de modo de roteamento por número (`inherit_workspace`/`channel_override`), origem
   `automation_unnichat`; envio sem ID do anúncio passa a valer.
3. Fase 5: URL única por plataforma e URLs por evento (`IntegrationEndpoint`), depois de 4a e 4b.
4. Licença manual no SaaS: mesclada (#149); falta deploy e a liberação pelo backoffice.
5. Pendências registradas: revisão geral de acentuação; parser Z-API com payload real; barra de
   filtros de Relatórios passando da largura em 1440px (já existia em `main`); export `.xlsx` do SaaS
   provavelmente quebrado por `import ExcelJS from` (corrigido no aluno com `import * as`).
6. Versão/Release: as notas estão acumuladas em `docs/releases/unreleased.json` com versão
   PENDENTE; publicar só com autorização do Samuel.
