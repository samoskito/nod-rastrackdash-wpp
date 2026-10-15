# Fase 4 — Provedores novos: Payt, Unnichat, Pipedrive — design aprovado

Data: 15/10/2026. Aprovado pelo Samuel em 15/10/2026.
Plano geral: [`2026-10-15-port-front-saas-design.md`](2026-10-15-port-front-saas-design.md).
Princípio: o que está validado no SaaS (`samoskito/dash-com-ia`) vem para o aluno com o mesmo
comportamento, sem revalidar; só se adapta à estrutura e às regras do aluno.

## Decisões

| Tema | Decisão |
|---|---|
| Login social Meta | Não muda. Alunos usam o app da PalmUP; nenhuma permissão nova é pedida. |
| `ctwa_clid` | Obrigatório (pixel de mensagem). Sem `ctwa_clid` não se envia nada. Lead com `ctwa_clid` mas sem ID do anúncio (ex.: Unnichat envia como CTWA ID) é enviado normalmente, igual ao SaaS — o caminho "compra sem ID do anúncio" do SaaS é portado. Se ele depender de permissões que o login social PalmUP não tem, investigar e propor sem mudar o login. |
| Parsers validados no SaaS | Data Crazy, Payt e Unnichat semeados como certificados por migration (o aluno não tem tela de certificação). Produção continua dependendo da ativação por regra. |
| Payt "Carrinho abandonado" | Vai junto, com selo "beta". |
| Guimoo | **Fora do aluno** (decisão de 15/10): é específico de um cliente do SaaS. A implementação feita (4d) não foi mesclada. |
| Modo de roteamento por número | Só Unnichat (`inherit_workspace` / `channel_override`), sem "BMs compartilhadas". |
| Flags do SaaS | Não vêm (`PIPEDRIVE_PANEL_*`, `PIPEDRIVE_CONVERSION_PRODUCTION_ENABLED`, flags de inbound). Produção por regra, como o Kommo do aluno. |
| Exclusivo do SaaS | Vagas/cobrança (`whatsapp_seat_*`), backoffice de certificação/recovery, modo suporte de `platform_owner`. |

## Subfases

| Subfase | Conteúdo | Depende de |
|---|---|---|
| 4.0 Fundação compra CTWA | `ProviderPurchaseClaim`, `InboundWebhookMetaRoutingMode` + `InboundWebhookChannel.metaRoutingMode`, `MetaConversionDestination.whatsappBinding`, roteamento efetivo e identidade de compra, `crm-channels`, certificação dos parsers validados (Data Crazy). Origem SaaS: `d02ddb6`, `a90a0c1`, `03ea114`, `3240dc7`, `cc5412f`, `7ca3a69`. | Fase 3 |
| 4a Payt | Enum + parser releases (`payt/v1`, `payt/automation-v1`), parser, origem `automation_payt`, eventos Compra aprovada → `Purchase`, Pix/boleto gerado → `InitiateCheckout`, Carrinho abandonado (beta) → `CartAbandoned`; URL por regra (`/webhooks/inbound/conversions/:id`). Card em Atendimento e vendas. | 4.0 |
| 4b Unnichat | Enum + parser releases, parsers v1 e automation-v1, conexão com `connectedPhone`, seletor de modo de roteamento, origem `automation_unnichat`. Card em Atendimento e vendas. | 4a |
| 4c Pipedrive | Migration consolidada (6 tabelas), módulo `pipedrive/*`, token de API, regras de etapa editadas na janela do Pipedrive no Hub (CRM) e só leitura em Conversões. Variável nova `PIPEDRIVE_CRM_ENCRYPTION_KEY`. | 4.0 |

4.0 mesclada (#82). Paralelo: 4a ∥ 4c; depois 4b. Kommo passa a usar o envio sem ID do anúncio junto com a 4c, como no SaaS. Fase 5 (URL única) depois de 4a e 4b — nada de
`IntegrationEndpoint`, `productFilterCodes`, `publicUrlDisabledAt` ou `ingestRouted` nesta fase.

## Regras de implementação

- Migrations aditivas, datadas depois de `20261015140000`; valor novo de enum e seed em
  migrations separadas; reservar timestamps por subfase para não colidir.
- Atualizar `apps/api/scripts/delete-workspace.js` e a exclusão de workspace com as tabelas novas.
- Variáveis novas geradas pelo próprio aluno (`openssl rand -base64 32`), uma por integração,
  documentadas em `docs/setup/environment.md` e `.env.example`. Nunca pedir segredos no chat.
- Licença bloqueada: guard global 423 nas escritas e webhooks públicos (como o Kommo); toda ação
  nova do web mostra o aviso de licença.
- Logos de Payt, Unnichat, Pipedrive e Guimoo do SaaS, com `SOURCES.md` atualizado.
- Cada subfase: worktree próprio, revisão Opus, testes, prints desktop/375, notas para a
  comunidade (`unreleased.json` + CHANGELOG, resumo ≤ 2000) e guia com o que configurar na
  plataforma de terceiros, verificação e rollback.

## Guia de atualização (resumo por subfase)

Comum: backup (`pg_dump`), migration no boot da API, redeploy.
- 4.0: nada a configurar; regras existentes continuam iguais; Data Crazy passa a poder ir para
  produção por regra.
- 4a Payt: postback da Payt apontando para a URL da regra; conferir em Eventos recebidos.
- 4b Unnichat: criar a conexão com o número, webhook de entrada e URL da regra de automação,
  escolher o modo de roteamento.
- 4c Pipedrive: gerar `PIPEDRIVE_CRM_ENCRYPTION_KEY`, token de API e webhook v2 de negócio alterado.
Rollback: desligar/remover a integração e voltar a imagem; colunas e tabelas novas ficam
inofensivas.

## Riscos

4.0 é grande (mais de 3 mil linhas em serviços que já divergiram) — risco de regressão em
Umbler/Gupshup/Data Crazy/Cloud API; FK composta para `ConversionEventLog(workspaceId,id)`;
webhooks públicos recebendo 423 com licença bloqueada (documentar reenvio).
