# Yampi: vendas como conversões (URL única)

Fase 6.7 (porte do SaaS #186, #187 e #188). A Yampi entra na mesma base da Payt e da Braip: **uma URL
única por workspace**. A Yampi avisa cada pedido nessa URL (webhook da loja), o sistema descobre por
qual número de WhatsApp o comprador chegou e entrega a venda à regra desse número, que manda o evento
para a Meta **com os itens reais do pedido** (inclusive o order bump).

A Yampi está **liberada para todos os workspaces** da sua instalação (no SaaS ela é uma integração
privada; aqui não existe chave nem liberação por cliente). O leitor do webhook da Yampi já vem **em
uso** com a atualização: ele foi validado no SaaS com payloads reais da Yampi, recebidos e lidos
corretamente. Você **não** precisa liberar nem certificar nada: a URL e as regras já começam
enviando. Continuam valendo as travas de sempre: licença ativa, rota da Meta (página e pixel) no
número do comprador e um lead que chegou por anúncio (com `ctwa_clid`).

## Antes de começar

- Atualize a instalação (veja [`update.md`](update.md)). Esta atualização tem migrations: **faça o
  backup do PostgreSQL antes**. Não há variável de ambiente nova para a Yampi.
- Tenha pelo menos um número de WhatsApp conectado (Uazapi, WAHA, Meta Cloud, Umbler, Gupshup,
  Data Crazy ou Unnichat) e com a rota da Meta configurada.
- A URL única só existe com os webhooks de entrada e as regras de conversão ligados na instalação
  (`INBOUND_WEBHOOKS_ENABLED` e `INBOUND_CONVERSION_RULES_ENABLED`, já ligados no `.env.example`).

## 1. Gerar a URL única da Yampi

1. Abra **Integrações** → aba **Atendimento e vendas** → card **Yampi**.
2. Clique em **Gerar URL única** e depois em **Copiar**. A URL tem a chave (`?token=`) e só aparece
   quando você pede ("Mostrar URL"); cada vez que alguém mostra a URL, o sistema registra quem viu.
3. A mesma URL vale para todos os seus números, regras e produtos. Não existe URL por regra na Yampi.

## 2. Cadastrar o webhook na Yampi

1. No painel da sua loja na Yampi, crie um **webhook** com a URL única no campo da URL.
   PENDENTE: confirmar o caminho exato do menu de webhooks no painel da Yampi (a documentação
   oficial descreve a criação pela API, abaixo).
2. Marque os eventos:
   - **Pedido pago** (`order.paid`);
   - **Pedido criado** (`order.created`), para o boleto/Pix gerado;
   - **Mudança de status do pedido** (`order.status.updated`);
   - **Carrinho abandonado** (`cart.reminder`).
3. A Yampi devolve uma chave secreta (`secret_key`) e manda o cabeçalho `X-Yampi-Hmac-SHA256`: **não
   é preciso copiar** a chave para o sistema. A autenticação é o token da URL; o cabeçalho nunca é
   lido nem guardado.

Pela API da Yampi (alternativa ao painel, documentação oficial "Criar um webhook"): `POST
https://api.dooki.com.br/v2/{alias da loja}/webhooks` com os cabeçalhos `User-Token` e
`User-Secret-Key` da sua conta Yampi e o corpo `{ "name": "RastrackDash", "url": "<URL única>",
"events": ["order.paid", "order.created", "order.status.updated", "cart.reminder"] }`. Os tokens
da Yampi ficam só com você: nunca cole em chat nem em arquivo commitado.

A Yampi espera a resposta em até 5 segundos e desativa o webhook depois de 30 falhas seguidas; se
isso acontecer, confira a URL e reative o webhook na Yampi.

## 3. Criar as regras de venda

Em **Conversões → Nova regra → Venda na Yampi** (ou no botão **Criar regra de venda da Yampi** do
card), crie **uma regra por evento**, para **todos os números** ou para **números específicos** (de
uma mesma conexão) e, se quiser, só para alguns produtos. A regra já nasce enviando.

| Aviso da Yampi | Evento na regra | Evento na Meta |
|---|---|---|
| `order.paid` (pedido pago) | Pedido pago | `Purchase` |
| `order.status.updated` com status pago | Pedido pago (**a mesma venda** do `order.paid`) | `Purchase` (um só) |
| `order.created` aguardando pagamento (boleto ou Pix gerado) | Pedido aguardando pagamento (boleto/Pix) | `InitiateCheckout` |
| `cart.reminder` (beta) | Carrinho abandonado | `CartAbandoned` |
| Cancelado, reembolsado, enviado, entregue, pagamento recusado (`transaction.payment.refused`) e outros | — | Nada: recebido e ignorado |

- **Nunca duas compras:** `order.paid` e a mudança de status para pago do mesmo pedido são a mesma
  venda (identidade = id do pedido + evento). Quem chegar primeiro vira a compra; o outro é só um
  recebimento repetido. Um pedido criado já pago (cartão aprovado na hora) é ignorado: o
  `order.paid` dele é a compra.
- **Valor:** só os produtos (`value_products`), **sem frete e sem os juros do parcelamento**. No
  carrinho abandonado, o subtotal (`totalizers.subtotal`). A Yampi não manda moeda: é sempre real
  (BRL). Sem `value_products` o pedido fica como inválido (nada é adivinhado).
- **Itens do pedido na Meta:** a Compra e o Iniciar checkout levam, em `contents`, uma linha por item
  do pedido (com o order bump), com o código do SKU (ou o id do SKU/produto), a quantidade e o preço;
  `num_items` é a soma das quantidades, `content_name` é o produto principal (maior preço ×
  quantidade) e `order_id` é o id do pedido na Yampi. Até 50 itens; nunca vão dados do comprador. O
  `event_id` e a deduplicação não mudam. O carrinho abandonado continua com o item genérico.
- **Produto principal:** o produto mostrado na venda é o item de maior valor (preço × quantidade),
  mesmo que o order bump (por exemplo "Frete Expresso") venha primeiro na lista.
- **Filtro de produto:** use o ID do produto, o ID do SKU ou o código do SKU (Produtos → abra o
  produto → SKUs). Todos os itens do pedido entram no filtro. O mais seguro é marcar na lista
  **Produtos detectados**, que aparece depois da primeira venda.
- **Telefone:** `area_code` + `number`, senão `full_number` com ou sem o 55 (o payload real veio sem o
  55). O link de WhatsApp do pedido nunca é usado.
- **Datas:** as datas da Yampi com fuso `America/Sao_Paulo` (e o `time` do aviso, sem fuso) são lidas
  na hora de Brasília e nunca ficam depois do recebimento.

## 4. Ver o que chegou

- **Integrações → Yampi:** contadores e "Último recebimento" da URL, eventos com regra ativa,
  produtos detectados e **Vendas sem atribuição** (vendas que não viraram conversão, com o motivo:
  "Comprador não é lead do WhatsApp", "Produto sem regra", "Nenhuma regra ativa para este evento"...).
  Em cada venda, **Ver dados recebidos** mostra o que foi lido (evento, valor, moeda, produto, pedido,
  data e só os 4 últimos dígitos do telefone) ao lado do webhook guardado, com chaves e tokens
  ocultos: `login_url` fica oculto por inteiro e os tokens de login dentro dos links do pedido
  (`token`, `customerToken`, `store_token` em `reorder_url`/`simulate_url`) aparecem como `[oculto]`.
  Depois de criar ou ajustar a regra, use **Tentar de novo**.
- **Conversões:** a lista "Vendas sem atribuição (Yampi)" aparece quando houver alguma. Em
  **Gerenciar → Eventos recebidos** de uma regra, cada venda diz se foi enviada e por quê.
- **Backoffice → Webhooks WhatsApp → Recebimentos das URLs únicas** (administradores da instalação):
  tudo o que chegou pelas URLs únicas, com filtro pela plataforma **Yampi**.
- **Backoffice → Webhooks WhatsApp → Leitores de webhook:** diagnóstico só de leitura; o leitor da
  Yampi (`yampi / automation-v1`) aparece **Em uso**.

Os webhooks ficam guardados com criptografia por 7 dias; o resumo de cada recebimento sem regra fica
por 60 dias.

## Compra manual com o pedido da Yampi

Em **Leads → Registrar conversão manual → Compra**, o número do pedido de uma venda da Yampi é o
**id do pedido** (o mesmo que aparece como "Pedido" em **Ver dados recebidos**). Uma compra manual
com esse pedido e a venda da Yampi do mesmo pedido nunca viram duas compras na Meta, em qualquer
ordem. PENDENTE: confirmar se o painel da Yampi mostra esse id (o número exibido ao lojista,
`number`, é outro); na dúvida, copie o pedido de **Ver dados recebidos**.

## Licença bloqueada

Com a licença bloqueada, toda escrita responde `423`: o webhook da Yampi, gerar ou girar a URL,
criar ou editar regras e **Tentar de novo**. A leitura continua: telas, **Ver dados recebidos** e os
Recebimentos do Backoffice.

## Verificação (conferência depois da instalação)

Isto é só a conferência de que a instalação está funcionando; o leitor já foi validado.

1. No log da API, as migrations `20261027160000_yampi_provider` e
   `20261027160100_yampi_parser_release` aparecem aplicadas sem erro.
2. Em **Backoffice → Webhooks WhatsApp → Leitores de webhook**, `Yampi automation-v1` aparece **Em
   uso**.
3. O card **Yampi** aparece em **Integrações → Atendimento e vendas** para qualquer workspace;
   **Gerar URL única** mostra a URL.
4. **Compra aprovada:** com uma regra "Venda na Yampi" de Pedido pago, um pedido pago de um lead que
   chegou por anúncio aparece em **Eventos recebidos** da regra e o `Purchase` chega ao Gerenciador
   de Eventos da Meta com o valor dos produtos (sem frete e sem juros).
5. **Itens no Gerenciador de Eventos:** num pedido com order bump, abra o evento `Purchase` no
   Gerenciador de Eventos (detalhes do evento / parâmetros): `contents` traz uma linha por item (o
   bump incluído), `num_items` a soma das quantidades e `order_id` o id do pedido na Yampi.
6. **Boleto/Pix:** com uma regra de Pedido aguardando pagamento, um pedido com boleto ou Pix gerado
   vira `InitiateCheckout`; quando ele for pago, o `order.paid` vira o `Purchase` (sem duplicar).
7. **Carrinho abandonado:** com uma regra de Carrinho abandonado, o `cart.reminder` vira
   `CartAbandoned` com o subtotal; lembretes repetidos do mesmo carrinho são um abandono só.
8. **Cupom:** num pedido com cupom, **Ver dados recebidos** mostra `value_products` e
   `value_discount`; o valor enviado é o `value_products`. Se a soma dos itens for diferente do valor
   por mais de R$ 0,05, o valor e os itens são mantidos e o log da API mostra
   `sale_capi_items_value_mismatch` (sem dados pessoais).
9. Uma venda de quem não é lead aparece em **Vendas sem atribuição** com o motivo; um cancelamento
   aparece em Recebimentos como ignorado.

## Problemas comuns

- **Nada chega:** confira se a URL cadastrada na Yampi é a URL completa (com `?token=`) e se o
  webhook está ativo na Yampi (30 falhas seguidas desativam). Em **Recebimentos das URLs únicas**, um
  "Token da URL não confere" indica URL antiga (por exemplo, depois de **Gerar nova**); cadastre a URL
  nova na Yampi.
- **"Comprador não é lead do WhatsApp":** o telefone do pedido não bate com nenhum lead que chegou
  por anúncio. A venda não é enviada (regra fixa: sem anúncio de origem, nada vai para a Meta).
- **"Produto sem regra":** a regra tem filtro de produto e nenhum item do pedido é desse produto/SKU.
- **Boleto/Pix não aparece:** confira se o evento `order.created` está marcado no webhook.

## Pendências conhecidas

- PENDENTE: o nome exato do status de um `order.created` com boleto/Pix na Yampi. O leitor aceita
  `waiting_payment`, `pending`, `pending_payment` e `awaiting_payment`; outro nome fica como
  ignorado (nunca é adivinhado).
- PENDENTE: confirmar se `value_products` já vem com o desconto do cupom (`value_discount`).
- PENDENTE: a Yampi não documenta um marcador para o envio de teste do webhook; um teste com dados
  de um lead real é tratado como venda.
- PENDENTE: o caminho do menu de webhooks no painel da Yampi.
- PENDENTE: o logo oficial da Yampi com permissão de uso (o card usa um logotipo neutro provisório).
- PENDENTE: itens reais do carrinho abandonado na Meta (hoje o `CartAbandoned` vai com o item
  genérico).

## Recuperação

Voltar o código não desfaz as migrations: o valor `yampi` dos enums e o leitor da Yampi ficam no
banco e são ignorados pela versão anterior (não apague). Na versão anterior, o card e as regras da
Yampi somem e a URL única da Yampi deixa de responder (a Yampi recebe 404 e pode desativar o webhook
depois de 30 falhas); os recebimentos já guardados ficam no banco. Só restaure o backup do
PostgreSQL com orientação.
