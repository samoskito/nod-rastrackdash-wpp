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

## Em andamento (só local no container da nuvem — NÃO está no GitHub)

| Frente | Branch / repositório | Estado |
|---|---|---|
| 4a Payt | `port/f4-a-payt` (aluno) | Implementação por agente Opus em andamento |
| 4c Pipedrive + Kommo sem ID do anúncio | `port/f4-c-pipedrive` (aluno) | Implementação por agente Opus em andamento |
| Liberar licença manual | `feat/licenca-manual-backoffice` (SaaS `dash-com-ia`) | Implementação por agente Opus em andamento |

Se a sessão da nuvem cair antes do push, esse trabalho se perde e precisa ser refeito a partir dos
planos. Escopo de cada um:
- **4a Payt:** enum + parser releases certificados (migrations `2026101610xxxx`), parser
  `payt-automation-v1`, eventos Compra aprovada → `Purchase`, Pix/boleto → `InitiateCheckout`,
  Carrinho abandonado (beta) → `CartAbandoned`; URL por regra; card em Atendimento e vendas; origem
  `automation_payt` em Conversões. Sem nada da Fase 5 (`IntegrationEndpoint`).
- **4c Pipedrive:** migration consolidada (6 tabelas, `2026101612xxxx`), módulo `pipedrive/*`
  (token de API + URL da empresa, webhook v2), variável `PIPEDRIVE_CRM_ENCRYPTION_KEY`
  (`openssl rand -base64 32`), card CRM com editor de regras, leitura em Conversões; Kommo passa a
  usar o envio sem ID do anúncio como no SaaS. Sem flags do SaaS.
- **Licença manual (SaaS):** `POST backoffice/licenses/grant` só dono da plataforma, motivo
  obrigatório + auditoria, mesmo `issueLicenseForPurchase`, 409 se já houver licença ativa, chave por
  e-mail e mostrada uma vez; botão no backoffice; doc em `docs/integrations/community-license.md`.

## Próximos passos

1. Terminar 4a e 4c → revisão Opus → prints → página de aprovação → merge.
2. 4b Unnichat (depois da 4a): enum + parsers certificados, conexão com `connectedPhone`, seletor
   de modo de roteamento por número (`inherit_workspace`/`channel_override`), origem
   `automation_unnichat`; envio sem ID do anúncio passa a valer.
3. Fase 5: URL única por plataforma e URLs por evento (`IntegrationEndpoint`), depois de 4a e 4b.
4. Licença manual no SaaS: revisão, aprovação, PR, deploy; Samuel libera o aluno pelo backoffice.
5. Pendências registradas: revisão geral de acentuação; parser Z-API com payload real; barra de
   filtros de Relatórios passando da largura em 1440px (já existia em `main`); export `.xlsx` do SaaS
   provavelmente quebrado por `import ExcelJS from` (corrigido no aluno com `import * as`).
6. Versão/Release: as notas estão acumuladas em `docs/releases/unreleased.json` com versão
   PENDENTE; publicar só com autorização do Samuel.
