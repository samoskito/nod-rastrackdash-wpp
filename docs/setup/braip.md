# Braip: vendas como conversões (URL única)

Fase 6.5. A Braip entra na mesma base da Payt: **uma URL única por workspace**. A Braip avisa cada
venda nessa URL, o sistema descobre por qual número de WhatsApp o comprador chegou e entrega a venda
à regra desse número, que manda o evento para a Meta.

O leitor do postback da Braip já vem **em uso** com a atualização: ele foi validado no SaaS com uma
**venda real** (confirmado pelo Samuel em 27/10/2026). Você **não** precisa liberar, certificar nem testar nada: a
URL e as regras já começam enviando. Continuam valendo as travas de sempre: licença ativa, rota da
Meta (página e pixel) no número do comprador e um lead que chegou por anúncio (com `ctwa_clid`).

## Antes de começar

- Atualize a instalação (veja [`update.md`](update.md)). Esta atualização tem migrations: **faça o
  backup do PostgreSQL antes**. Não há variável de ambiente nova para a Braip.
- Tenha pelo menos um número de WhatsApp conectado (Uazapi, WAHA, Meta Cloud, Umbler, Gupshup,
  Data Crazy ou Unnichat) e com a rota da Meta configurada.
- A URL única só existe com os webhooks de entrada e as regras de conversão ligados na instalação
  (`INBOUND_WEBHOOKS_ENABLED` e `INBOUND_CONVERSION_RULES_ENABLED`, já ligados no `.env.example`).

## 1. Gerar a URL única da Braip

1. Abra **Integrações** → aba **Atendimento e vendas** → card **Braip**.
2. Clique em **Gerar URL única** e depois em **Copiar**. A URL tem a chave (`?token=`) e só aparece
   quando você pede ("Mostrar URL"); cada vez que alguém mostra a URL, o sistema registra quem viu.
3. A mesma URL vale para todos os seus números, regras e produtos. Não existe URL por regra na
   Braip.

## 2. Colar a URL na Braip

1. Na Braip, abra **Ferramentas → Postback → Nova configuração**.
2. Cole a URL única no endereço do postback, escolha **todos os produtos** e o método **POST**.
3. Em **Eventos**, marque **Pagamento Aprovado** e **Aguardando Pagamento** (e o abandono de
   checkout, se aparecer na sua conta).
4. A "Chave única" da Braip não precisa ser copiada para o sistema: a autenticação é o token da URL,
   e essa chave é descartada antes de guardar o postback.

A Braip pode mandar o corpo em JSON ou em formulário (`application/x-www-form-urlencoded`): os dois
são aceitos.

## 3. Criar as regras de venda

Em **Conversões → Nova regra → Venda na Braip** (ou no botão **Criar regra de venda da Braip** do
card), crie **uma regra por evento**, para **todos os números** ou para **números específicos** (de
uma mesma conexão) e, se quiser, só para alguns produtos. A regra já nasce enviando.

| Status na Braip | Evento na regra | Evento na Meta |
|---|---|---|
| Pagamento Aprovado | Compra aprovada | `Purchase` |
| Aguardando Pagamento (boleto ou Pix gerado) | Boleto/Pix gerado | `InitiateCheckout` |
| Abandono de checkout (beta) | Checkout abandonado | `CartAbandoned` |
| Cancelada, Chargeback, Devolvida, Estorno Pendente, Em Análise e outros | — | Nada: recebido e ignorado |

- O **valor** enviado é o da própria venda (`trans_value`, com o order bump incluído). A **moeda** é a
  da venda; sem moeda na venda, vale a da regra e depois a "Moeda das conversões" do workspace.
- **Order bump:** a venda é ligada ao produto **principal**. Uma regra filtrada só pelo produto do
  bump não pega a venda.
- **Filtro de produto:** use o código do produto (`product_key`) ou do plano (`plan_key`). O mais
  seguro é marcar na lista **Produtos detectados**, que aparece depois da primeira venda.
- **Reenvios** da Braip (por exemplo "Código de rastreio adicionado" com o status aprovado, ou a
  mesma venda como produtor e como afiliado) caem na mesma venda: uma compra só na Meta.
- A data da venda sem fuso é lida na hora de Brasília e nunca fica depois do recebimento.

## 4. Ver o que chegou

- **Integrações → Braip:** contadores e "Último recebimento" da URL, eventos com regra ativa,
  produtos detectados e **Vendas sem atribuição** (vendas que não viraram conversão, com o motivo:
  "Comprador não é lead do WhatsApp", "Produto sem regra", "Nenhuma regra ativa para este evento"...).
  Em cada venda, **Ver dados recebidos** mostra o que foi lido (evento, valor, moeda, produto,
  pedido, data e só os 4 últimos dígitos do telefone) ao lado do postback guardado, com chaves e
  tokens ocultos. Depois de criar ou ajustar a regra, use **Tentar de novo**.
- **Conversões:** a lista "Vendas sem atribuição (Braip)" aparece quando houver alguma. Em
  **Gerenciar → Eventos recebidos** de uma regra, cada venda diz se foi enviada e por quê.
- **Backoffice → Webhooks WhatsApp → Recebimentos das URLs únicas** (administradores da instalação): tudo o
  que chegou pelas URLs únicas de todos os workspaces, inclusive o que foi ignorado, inválido ou
  recusado (token errado, URL removida, corpo ilegível), com filtros por cliente, plataforma,
  status, evento e período. Sem token válido só os metadados ficam guardados, nunca o conteúdo; de
  uma chamada da Braip recusada pelo corpo também, para a chave da conta nunca ser guardada.
- **Backoffice → Webhooks WhatsApp → Leitores de webhook:** diagnóstico só de leitura; o leitor da Braip
  (`braip / automation-v1`) aparece **Em uso**.

Os postbacks ficam guardados com criptografia por 7 dias; o resumo de cada recebimento sem regra
fica por 60 dias.

## Licença bloqueada

Com a licença bloqueada, toda escrita responde `423`: o postback da Braip, gerar ou girar a URL,
criar ou editar regras e **Tentar de novo**. A leitura continua: telas, **Ver dados recebidos** e os
Recebimentos do Backoffice.

## Verificação

1. No log da API, as migrations `20261027140000_braip_provider` e
   `20261027140100_braip_parser_release` aparecem aplicadas sem erro.
2. Em **Backoffice → Webhooks WhatsApp → Leitores de webhook**, `Braip automation-v1` aparece **Em uso**.
3. O card **Braip** aparece em **Integrações → Atendimento e vendas**; **Gerar URL única** mostra a
   URL.
4. Depois da primeira venda aprovada de um lead que chegou por anúncio, a venda aparece na regra
   (Eventos recebidos) e o `Purchase` chega ao Gerenciador de Eventos da Meta. Uma venda de quem não é
   lead aparece em **Vendas sem atribuição** com o motivo.

## Problemas comuns

- **Nada chega:** confira se a URL colada na Braip é a URL completa (com `?token=`) e o método POST.
  Em **Recebimentos das URLs únicas**, um "Token da URL não confere" indica URL antiga (por exemplo,
  depois de **Gerar nova**); cole a URL nova na Braip.
- **"Comprador não é lead do WhatsApp":** o telefone da compra não bate com nenhum lead que chegou
  por anúncio. A venda não é enviada (regra fixa: sem anúncio de origem, nada vai para a Meta).
- **"Produto sem regra":** a regra tem filtro de produto e a venda é de outro produto.

## Pendências conhecidas

- PENDENTE: confirmar se `trans_value` já vem sem os juros do parcelamento e sem o frete (produto físico), e o
  fuso horário das datas.
- PENDENTE: o nome exato do aviso de abandono de checkout na Braip e se ele traz a transação; sem a
  transação, o aviso fica como inválido (nunca é adivinhado).
- PENDENTE: renovações de assinatura (cada cobrança aprovada vira uma compra) ainda não foram vistas
  num postback real.

## Recuperação

Voltar o código não desfaz as migrations: o valor `braip` dos enums e o leitor da Braip ficam no banco
e são ignorados pela versão anterior (não apague). Na versão anterior, o card e as regras da Braip
somem e a URL única da Braip deixa de responder; os recebimentos já guardados ficam no banco. Só
restaure o backup do PostgreSQL com orientação.
