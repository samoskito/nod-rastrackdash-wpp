# Fase 5 — Payt, moeda configurável e URL única — design aprovado

Data: 16/10/2026. Aprovado pelo Samuel em 16/10/2026.
Plano geral: `docs/plans/2026-10-15-port-front-saas-design.md` (branch `claude/funny-knuth-bjp2ww`).
Origem: `samoskito/dash-com-ia` (`origin/main` `cbfd276`). Princípio: o que está validado no SaaS
vem para o aluno com o mesmo comportamento, sem revalidar; só se adapta à estrutura do aluno.
Base: `main` do aluno `0d3f81c` (Fase 4 completa: #82, #83, #84, #85, #86).

## Decisões

| Tema | Decisão |
|---|---|
| Correções da Payt do SaaS | Entram antes, como Fase 5.0, em PR próprio. |
| Lugar da URL única | No modal de cada plataforma no Hub (Payt, Unnichat, Umbler). Conversões mostra a URL dentro da regra, como no SaaS. |
| Moeda configurável | Vem nesta fase (BRL, USD, EUR), igual ao SaaS. |
| Ordem | 5.0 Payt → 5.1 moeda das conversões → 5.2 relatórios por moeda → 5.3 URL única. |
| Cotação PTAX | Variável `PTAX_SYNC_ENABLED`, **desligada por padrão**, documentada. Liga quem anuncia ou vende em outra moeda. Não é a flag do SaaS (`WPPTRACK_PTAX_SYNC_ENABLED`). |
| Plataformas da URL única | Payt, Unnichat e Umbler. Braip fora (parser não certificado no SaaS). Guimoo fora. |
| URL antiga | Convive com a nova; desativada regra por regra, com confirmação, reversível. |
| Envio duplo | Mesma venda pelas duas URLs = um envio à Meta (claim de compra da Payt; identidade de negócio da Unnichat, SaaS `73a9a56`). |
| Filtro de produto | Só Payt, por código do produto. |
| Vendas sem atribuição | Lista com "Tentar de novo"; postbacks não roteados apagados em 60 dias. |
| Licença bloqueada | 423 (padrão do aluno), não 404 como no SaaS. |
| Fora | Pix/cobrança/vagas do SaaS, painel Guimoo, Braip, flags do SaaS. |

Regras que continuam: `ctwa_clid` obrigatório; login social Meta da PalmUP sem mudança e sem
permissão nova; migrations só aditivas; notas para a comunidade no mesmo commit
(`docs/releases/unreleased.json` + `CHANGELOG.md`); nada de tag/Release/aviso sem autorização.

## 5.0 — Correções da Payt

Origem SaaS: `d88fc6c`, `6f5fcf0` (reenvio com corpo diferente), `4ca665b`, `608ec47`, `1d65161`
(valor sem juros e backfill).

- Reenvio do mesmo pedido com conteúdo alterado é reconciliado como no SaaS; hoje uma decisão
  congelada com o corpo antigo falha em produção sem reavaliar.
- A conversão usa o valor do produto, sem juros do parcelamento. O backfill só corrige o que ainda
  não foi enviado à Meta; o que já foi enviado não muda.
- Migration, se houver, só aditiva. Notas avisam o efeito no valor das próximas compras.
- Risco: mesmo trecho da ingestão da 4a; parser e testes da Payt servem de rede.

## 5.1 — Moeda das conversões

Origem SaaS: `0bf5ebf` (migration `20261015220000_configurable_currency`), `ffd0bae`, `e510840`,
`5ce8393`, `c4c0375`. Design no SaaS: `docs/plans/2026-10-15-moeda-configuravel-design.md`.

- Dados: enum `CurrencyCode` (BRL, USD, EUR); `Workspace.conversionCurrency` (padrão BRL);
  `MetaReportingAccount.currencyOverride` (opcional); moeda opcional na regra. Workspaces existentes
  ficam em BRL.
- Configurações → Moeda: qualquer membro vê; dono/admin altera, com auditoria. Correção da moeda por
  conta de anúncio (usada na 5.2).
- Regra: "Padrão do workspace" ou moeda própria — Nova regra, regras antigas, painéis do Kommo e do
  Pipedrive.
- Envio à Meta: moeda da venda → da regra → do workspace → BRL. Valor nunca vai sem moeda; eventos já
  enviados não mudam. Parser da Payt deixa de forçar BRL. Pipedrive usa a moeda do negócio e confere
  com a da regra. Sem conversão no envio.
- A tela avisa, antes de salvar, que trocar a moeda do workspace afeta as conversões novas.

## 5.2 — Relatórios por moeda e cotação PTAX

Origem SaaS: `996e7c1`, `2f79c3c`, `5b4fdd4`, `c9428b1`.

- Moeda do gasto por conta de anúncio: correção manual → moeda da Meta → BRL.
- Moedas diferentes nunca são somadas: um total por moeda, lado a lado, só as que tiveram movimento
  no período. Quem tem tudo em real vê a tela igual a hoje.
- Filtro por conta de anúncio na Visão Geral e em Relatórios.
- `PTAX_SYNC_ENABLED` desligada: nenhuma busca externa; receita em outra moeda aparece na moeda
  original e o ROAS dessa parte mostra "sem cotação".
- Ligada: a cada 6 h busca a PTAX do Banco Central (`olinda.bcb.gov.br`) e guarda em `ExchangeRate`.
  Receita e ROAS convertidos para a moeda do gasto da conta atribuída, pela cotação do dia da venda
  (America/Sao_Paulo); sem cotação no dia, último dia útil anterior. Venda sem conta atribuída fica na
  moeda original. Falha do BCB: última cotação guardada ou "sem cotação"; nada quebra, nada é enviado
  à Meta por causa disso.
- Notas: variável em `docs/setup/environment.md` e `.env.example`; quando ligar; acesso de rede.
- Risco maior da Fase 5: `meta-reporting.service.ts`, `reports/page.tsx` e `overview/page.tsx`
  divergiram nas Fases 1–3 (leads novos × que voltaram, CPL); junção manual. Prints com uma e com duas
  moedas.

## 5.3 — URL única por plataforma e URLs por evento

Origem SaaS: `6d4aa02` (migration `20261015120000_integration_single_endpoints`), `a9d2d3c`,
`613beb3`, `73a9a56`, `ca783a1`, `f2e676b`, `6574aad`.

- Dados: `IntegrationEndpoint` (uma URL viva por workspace + plataforma + evento; Payt uma URL para
  todos os eventos, Unnichat/Umbler uma por evento; token reexibível só com auditoria);
  `IntegrationEndpointEvent` (recibo idempotente com destino e motivo); `productFilterCodes` na regra;
  `publicUrlDisabledAt` na URL antiga; `InboundWebhookDelivery.integrationEndpointId`. Atualizar
  `apps/api/scripts/delete-workspace.js` e a exclusão de workspace.
- Rota pública `POST /webhooks/inbound/integrations/:endpointId?token=`; roteia e entra no mesmo
  processamento da URL por regra (`ingestRouted`), sem caminho paralelo.
- Roteamento: Payt pelo telefone do lead e número de chegada (específica > todos os números; com
  filtro > sem filtro; mais antiga); Unnichat pelo `ctwa_clid`; Umbler pelo canal do payload ou última
  mensagem do contato.
- Controller `integrations/endpoints`: listar (com URLs antigas), criar, mostrar URL (auditado),
  girar, remover, produtos detectados, vendas sem atribuição, tentar de novo. Desativar/reativar URL
  antiga no PATCH da regra.
- Tela: modal de cada plataforma no Hub (URL única ou por evento, vendas sem atribuição, produtos
  detectados, URLs antigas com último recebimento); Conversões mostra URL e filtro de produto na regra.
- Riscos com teste próprio: envio duplo entre as URLs; URL antiga desativada enquanto a plataforma
  posta nela; filtro descartando vendas; mudança de destino pela prioridade entre regras; retenção.

## Execução

Cada entrega: worktree e branch próprios a partir de `main`, Opus no backend e nas revisões, Sonnet
na tela e nos prints; migrations testadas em Postgres 16 descartável (do zero e por cima da `main`);
revisão Opus independente; typecheck e suítes completas; prints desktop 1440 e 375 em página
Artifact quando mudar tela; aprovação do Samuel; PR e merge squash.

Notas para a comunidade: `summary`, `changes` e `upgradeGuide` de `docs/releases/unreleased.json`
estão a menos de 50 caracteres do limite (`docs/RELEASE_NOTES_AI.md`). Antes de acrescentar a 5.0,
consolidar o texto ou o Samuel definir a versão e publicar (só com autorização).
