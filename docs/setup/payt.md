# Payt — vendas da Payt viram conversões na Meta

A Payt é uma plataforma de venda (checkout), não um número de WhatsApp. Com esta integração, cada
venda da Payt feita por um lead que chegou por anúncio de clique para o WhatsApp (CTWA) vira um
evento na Meta, com o valor real da venda. É o mesmo comportamento que já roda em produção no SaaS.

> **Regra fixa:** sem `ctwa_clid` nada é enviado à Meta. O comprador precisa ser um lead rastreado,
> que chegou por anúncio em um dos números da regra. Venda de quem não é lead CTWA fica registrada
> como ignorada, nunca é enviada.

## Eventos

| Na Payt | Evento na Meta | Observação |
|---|---|---|
| Compra aprovada (pago, ou pagamento na entrega confirmado) | `Purchase` | Valor real da venda, em reais |
| Pix ou boleto gerado (aguardando pagamento) | `InitiateCheckout` | Valor do pedido |
| Carrinho abandonado | `CartAbandoned` | **Beta**; o valor pode não vir |

O evento vem do status de cada postback, nunca da URL. Cancelamento, reembolso e outros status são
ignorados (não é erro).

**Uma regra por evento.** Cada regra tem a sua própria URL. Para enviar compra aprovada e Pix/boleto
gerado, por exemplo, crie duas regras e cadastre as duas URLs na Payt. Uma regra só aceita o seu
evento: postbacks de outros status chegam, aparecem como ignorados em **Eventos recebidos** e nada é
enviado por ela. A URL única por plataforma fica para uma fase futura.

**Compra repetida conta uma vez.** Se a Payt reenviar o mesmo postback (ou mandar dois postbacks da
mesma venda), só um evento é criado para aquela venda e aquele evento.

## Antes de começar

- API atualizada com as migrations desta versão (veja [Atualizar](update.md)).
- As variáveis dos gatilhos de conversão ligadas na API (`INBOUND_WEBHOOKS_ENABLED`,
  `INBOUND_WEBHOOK_ENCRYPTION_KEY`, `INBOUND_CONVERSION_RULES_ENABLED` e, para produção,
  `INBOUND_WEBHOOK_PRODUCTION_ENABLED`) — as mesmas da Umbler; veja
  [`environment.md`](environment.md#gatilhos-de-conversão--obrigatórias-no-caminho-do-aluno).
  Nenhuma variável nova para a Payt.
- Pelo menos uma conexão de WhatsApp com os números que recebem os leads dos anúncios (Umbler,
  Gupshup, Data Crazy, WhatsApp Cloud API ou Uazapi), com a rota Meta do número configurada.
- Licença utilizável. Com a licença bloqueada, a API responde `423` também aos postbacks da Payt e
  nada é gravado; depois de regularizar, reenvie os postbacks pela Payt.

A Payt **não** tem conexão própria no Hub: a regra de venda é criada em **Conversões**.

## Passo a passo

1. **Conversões → Nova regra → origem Payt.** Escolha o evento (compra aprovada, Pix/boleto gerado
   ou carrinho abandonado, este com selo beta) e o alcance: **Todos os números** ou **Números
   específicos**. A regra fica presa à conexão de WhatsApp dos números escolhidos (é só a âncora da
   URL; a venda pode ser de um lead de qualquer número de WhatsApp do workspace dentro do alcance).
2. **Copie o endereço (URL) da regra.** Ele aparece uma única vez, completo, com `?token=`. Se
   perder, use **Gerar novo endereço** na regra (o anterior para de funcionar na hora; cole o novo
   na Payt).
3. **Na Payt, cadastre o postback.** No painel da Payt, abra a configuração de Postback (webhook de
   vendas) do produto e cole a URL completa. Só preencha o token num campo separado se a Payt pedir:
   ele já está na URL. Repita para cada regra (uma URL por evento).
4. **Confira em Eventos recebidos.** Faça uma venda ou espere a próxima. Na regra, em **Eventos
   recebidos**, cada postback aparece com o que aconteceu: reconhecido, ignorado (outro evento, ou
   comprador que não é lead rastreado), venda já reconhecida em outro callback, ou bloqueado com o
   motivo.
5. **Ative a produção.** A regra nasce **em observação**: nada é enviado à Meta. Quando as primeiras
   vendas aparecerem certas em Eventos recebidos, ative o envio automático da regra. Os parsers
   Payt v1 e Payt automation-v1 já vêm certificados pela migration, então não há passo de
   certificação.

### Reprocessar

Em **Eventos recebidos**, **Reprocessar selecionados** reavalia postbacks já recebidos:

- com a regra **em observação**, o postback é reavaliado e o resultado aparece como "Reavaliado em
  observação" — **nada é enviado à Meta**;
- com a regra **em produção**, o envio só acontece com a sua confirmação explícita, e a venda é
  conferida de novo antes de enviar (comprador, número de origem e anúncio). Venda já reconhecida
  continua contando uma vez só.

Um postback que chegou antes de o comprador virar um lead rastreado pode ser reprocessado depois:
a busca do lead é refeita com o telefone atual.

## Limitações conhecidas

- **Venda de lead sem ID do anúncio** (lead com `ctwa_clid` mas sem o ID do anúncio) ainda não é
  enviada pela Payt nesta versão. Esse caminho só passa a valer com o **Unnichat** (Fase 4b,
  futura). Hoje o lead precisa ter `ctwa_clid` **e** o ID do anúncio.
- Lead que chegou por **outro número** que tem a sua própria regra Payt: a venda é enviada pela regra
  daquele número, não por esta (aparece como "Venda de um lead que chegou por outro número").
- Mais de um lead com o mesmo telefone: ambíguo, nada é enviado.
- Filtro por produto ainda não existe (fase futura): todas as vendas do postback cadastrado entram.
- Postbacks de teste da Payt não têm tratamento especial: normalmente o comprador de teste não é um
  lead rastreado e o postback fica como ignorado.

## Verificação

- Em **Conversões**, a origem Payt aparece em **Nova regra**, com os três eventos (carrinho
  abandonado com selo beta).
- Em **Eventos recebidos** da regra, o postback de teste da Payt aparece (recebido, mesmo que
  ignorado). Se nada aparecer: confira se a URL foi colada inteira, com `?token=`, e se a licença
  está utilizável.
- Com a regra em produção, a venda de um lead CTWA aparece em **Eventos Meta**.
- Opcional, no banco: `SELECT provider, version, status FROM "InboundWebhookParserRelease" WHERE
  provider = 'payt'` deve mostrar `v1` e `automation-v1` como `certified`.

## Rollback

- **Parar de receber:** remova o postback na Payt e desative ou exclua a regra em Conversões. Os
  postbacks seguintes deixam de ser aceitos.
- **Voltar a versão:** antes, faça backup do banco. Não há tabela nem coluna nova a desfazer, e
  valores de enum do PostgreSQL não são removidos. Se você **nunca criou** regra Payt, basta voltar a
  imagem/o código da API e do web para a versão anterior: a versão anterior ignora os parsers Payt
  certificados. Se já criou regras Payt e recebeu postbacks, a versão anterior não conhece o valor
  `payt` gravado nessas regras, nos eventos recebidos e nos diagnósticos, e as telas que os leem
  podem dar erro. Nesse caso, prefira ficar nesta versão com as regras Payt desativadas; se mesmo
  assim a versão anterior der erro em Conversões ou Diagnósticos, volte para esta versão (o banco é
  o mesmo). PENDENTE: volta à versão anterior com regras e postbacks Payt gravados não foi
  exercitada.

Veja também: [Provedores de WhatsApp](whatsapp-providers.md) · [Atualizar](update.md) ·
[Troubleshooting](troubleshooting.md).
