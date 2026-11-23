# GoHighLevel: entrada do lead e conversões das etapas do Workflow

Porte do SaaS. O GoHighLevel (GHL) entra no RastrackDash por **Workflows** da localização do seu
cliente:

| O que acontece no GoHighLevel | URL que recebe | O que o RastrackDash faz |
|---|---|---|
| **Entrada do lead** (um contato que veio de um anúncio de WhatsApp entra no Workflow) | URL da **conexão** GoHighLevel (uma por localização) | Cria (ou atualiza) o lead com o clique do anúncio, conta em "Conversas reais iniciadas" e segue as regras de sempre (Lead recebido, uma vez por lead e pixel). |
| **Etapa do Workflow** (lead qualificado, compra, Lead recebido) | URL da **regra** "Etapa no GoHighLevel" (uma por regra/evento) | Envia o evento da regra para a Meta, para o lead que veio do anúncio. |
| **Etapa do pipeline** (a oportunidade muda de etapa: "Pipeline Stage Changed") | URL da **regra** "Etapa no GoHighLevel" com **Pipeline + etapa** escolhidos | Envia o evento da regra com o valor da oportunidade (`lead_value`), só para aquela etapa. |

**Só lead pago.** Só conta o contato que chegou por um anúncio, com o clique do anúncio
(`ctwa_clid`) no contato do GHL. Um contato orgânico (sem o clique) **nunca** vira lead e **nunca**
é enviado. A chamada orgânica também não "ocupa o lugar" do contato: se o mesmo contato passar
pela mesma etapa de novo depois de clicar num anúncio, essa chamada conta como a primeira.

## Situação nesta versão: envio liberado

Os dois leitores do GoHighLevel (`gohighlevel` **v1**, a entrada, e **automation-v1**, as etapas)
estão **certificados** a partir da versão que traz a migration
`20261120120000_gohighlevel_parser_certification`. Na prática:

- **conexão e regras novas** nascem enviando para a Meta, como nas outras integrações liberadas;
- **conexão e regras criadas antes da atualização** continuam em observação: abra a conexão em
  **Integrações → Go High Level** e cada regra em **Conversões** e clique em ativar o envio. Nada do
  que chegou antes da ativação é enviado depois;
- as travas continuam: licença ativa, Meta conectada e destino com pixel e página.

Não marque o leitor como certificado à mão no banco: quem certifica é a migration.

## Antes de começar

- Atualize a instalação (veja [`update.md`](update.md)). Esta atualização tem migrations: **faça o
  backup do PostgreSQL antes**. **Não há variável de ambiente nova** para o GoHighLevel.
- A conexão só existe com os webhooks de entrada e as regras de conversão ligados na instalação
  (`INBOUND_WEBHOOKS_ENABLED` e `INBOUND_CONVERSION_RULES_ENABLED`, já ligados no `.env.example`).
- Conecte a Meta Ads (Integrações → aba **Anúncios**) com a conta de anúncio que roda os anúncios
  que levam ao WhatsApp da localização.

## O que você precisa do GoHighLevel

- Acesso à **localização** (subconta) do cliente, com permissão para criar **Workflows**.
- O **ID da localização** (Location ID). Em geral fica em **Settings → Business Profile**; é o
  mesmo `location.id` que o Workflow envia.
- O **número de WhatsApp** atendido nessa localização (o seu/do seu cliente), com DDI e DDD. Nunca
  o telefone do lead.
- Anúncios de clique para o WhatsApp cujo contato chegue ao GHL com a atribuição do anúncio
  (`contact.attributionSource` ou `contact.lastAttributionSource` com `ctwa_clid`).

## 1. Criar a conexão de cada localização

1. Abra **Integrações** → aba **WhatsApp** → card **Go High Level**.
2. Clique em **Gerar webhook** e informe um **nome** (ex.: "Clínica Exemplo"), o **ID da
   localização** e o **número de WhatsApp** da localização.
3. Copie a **URL completa**, com `?token=`. Ela aparece **uma única vez**; se perder, gere outra em
   **Gerar nova URL** na mesma conexão (a antiga para de funcionar).
4. Para outra localização, crie **outra conexão**: uma localização = uma conexão = um número.

## 2. Workflow de entrada do lead (URL da conexão)

1. No GoHighLevel, na localização, crie um **Workflow** com o gatilho de entrada do contato que
   veio do anúncio (por exemplo, contato criado ou primeira mensagem recebida no WhatsApp).
2. Adicione a ação **Webhook** (método **POST**) e cole a **URL da conexão**. Não precisa de
   cabeçalho extra.
3. Publique o Workflow.

O RastrackDash lê do corpo do Workflow: `contact_id`, `phone` (telefone do lead), `full_name`,
`location.id` e `location.name`, `workflow.id`, e a atribuição do contato em
`contact.attributionSource` (primeiro) ou `contact.lastAttributionSource`: `ctwa_clid` (o clique),
`adId`, `adName` e `url`. Uma fonte só vale com o `ctwa_clid`. O corpo puro do GHL e o formato de
item do n8n (`[ { headers, body } ]`) são aceitos.

**Anúncio sem ID:** quando o GHL manda o clique (`ctwa_clid`) mas não o `adId`, o lead é atribuído
pela **página e pixel** autorizados do número, como no Unnichat. Sem página e pixel únicos, o lead
fica registrado e nada é enviado.

## 3. Etapas do Workflow (URL de cada regra)

1. Em **Conversões → Nova regra**, escolha **"Etapa no GoHighLevel"** e o evento: **Lead
   qualificado** (padrão), **Compra** ou **Lead recebido**. A regra vale para todas as localizações
   conectadas. Na compra, você pode informar um valor fixo.
2. Depois de criar, copie a **URL da regra** (também fica em **Gerenciar → Endereço e
   configuração**).
3. No Workflow do GoHighLevel, na etapa que marca o evento, adicione a ação **Webhook (POST)** com
   essa URL. Use a mesma URL em todas as localizações: o número é descoberto pelo `location.id` que
   o Workflow envia, nunca o de outra localização.

Regras de contagem:

- O mesmo contato no mesmo Workflow conta **uma vez só**; outro Workflow é outra conversão. Se o
  corpo trouxer `triggerData.id`, cada gatilho diferente também é outra conversão.
- Lead recebido e lead qualificado contam uma vez por lead e pixel, qualquer que seja o Workflow.
- A hora do evento é a da chegada da chamada (o `date_created` é a criação do contato e nunca é
  usado como hora da conversão).
- Uma regra "Lead recebido" pode substituir o envio da entrada quando essa opção está ligada; por
  isso ela nunca é o padrão.

## Onde conferir

- **Integrações → Go High Level:** conexões, chamadas recebidas e o motivo de cada uma.
- **Conversões → Gerenciar → Eventos recebidos:** as chamadas de cada regra, com o motivo
  (por exemplo, "Localização do GoHighLevel sem conexão ativa nesta conta" ou contato sem clique do
  anúncio).
- **Backoffice → Leitores de webhook:** os leitores `gohighlevel` v1 e automation-v1 aparecem como
  certificados.

## 4. Conversão pela etapa do pipeline (oportunidade)

Use quando a venda ou a qualificação é marcada movendo a **oportunidade** de etapa no pipeline do
GoHighLevel. A regra escolhe um **pipeline** e uma **etapa**; só a mudança para essa etapa conta.
O valor enviado é o da oportunidade (`lead_value`, em reais). O leitor desta regra
(`automation-v2`) já vem **certificado**: a regra nasce enviando, sem etapa de observação.

### 4.1 Criar o token no GoHighLevel (uma vez por localização)

1. No GoHighLevel, na localização, abra **Settings (Configurações) → Private Integrations**.
2. Clique em **Create new Integration** (criar integração), dê um nome (ex.: "RastrackDash") e
   marque **só** o escopo **`opportunities.readonly`** (ler oportunidades). Nenhum escopo de
   escrita é necessário.
3. Copie o **token** gerado. Ele é um segredo: não cole no chat nem em mensagens.

### 4.2 Colar o token na conexão

1. No RastrackDash, abra **Integrações → Go High Level** e a conexão da localização.
2. Abra **Token do GoHighLevel (opcional)**, cole o token e clique em **Salvar token**.
3. O token fica criptografado e **não aparece de novo**; a tela só diz "configurado". Para trocar,
   use **Trocar token**; para tirar, **Remover token**.

Sem o token a regra não consegue listar os pipelines e vale para **todas** as etapas, só com
Lead recebido, Lead qualificado ou Compra (o comportamento da seção 3).

### 4.3 Criar uma regra por etapa

1. Em **Conversões → Nova regra**, escolha **"Etapa no GoHighLevel"**, o **evento** e a conexão da
   localização.
2. Em **Pipeline + etapa (opcional)**, escolha o **Pipeline** e, logo abaixo, a **Etapa**. A
   escolha fica recolhida num resumo "Pipeline · Etapa", com **Trocar** e **×** para remover.
3. Com pipeline e etapa escolhidos vale **qualquer evento** do pixel de mensagem. O campo de valor
   vira **"Valor fixo de reserva (opcional)"**: ele só é usado quando a oportunidade chega sem
   `lead_value`. Sem `lead_value` e sem reserva, um evento com valor (ex.: Compra) é ignorado com o
   motivo na tela.
4. Crie **uma regra para cada etapa** que vira conversão (ex.: "Proposta enviada" → Lead
   qualificado; "Ganho" → Compra).
5. Depois de criar, copie a **URL da regra** (também em **Gerenciar → Endereço e configuração**).

### 4.4 Montar o Workflow no GoHighLevel

1. Crie um **Workflow** com o gatilho **Pipeline Stage Changed** (mudança de etapa do pipeline).
   Pode filtrar o gatilho pelo mesmo pipeline e etapa da regra.
2. Adicione a ação **Webhook**, método **POST**, e cole a **URL da regra**. Não precisa de
   cabeçalho extra.
3. Publique o Workflow. Um Workflow por etapa/regra deixa o funil mais fácil de conferir.

### 4.5 Como conta

- Só lead pago: a oportunidade precisa de um contato com o clique do anúncio (`ctwa_clid`). Sem o
  clique, a chamada é **ignorada sem deixar marca**: se o mesmo contato voltar pela mesma etapa
  depois de clicar num anúncio, essa chamada conta como a primeira.
- A mesma oportunidade na mesma etapa do mesmo pipeline conta **uma vez**; outra etapa é outra
  conversão. Lead recebido e Lead qualificado continuam uma vez por lead e pixel.
- Chamada de outro pipeline ou de outra etapa aparece em **Eventos recebidos** como ignorada
  ("outra etapa"), nunca como erro.
- Etapa renomeada no GoHighLevel continua valendo: o RastrackDash confere o nome atual pela API
  (com o token) e guarda o nome novo quando você salva a regra.
- Regra **sem** pipeline e etapa continua no leitor da seção 3 (`automation-v1`), sem mudança.
- Na URL única do evento, quando existe regra por etapa: a chamada que traz etapa vai só para a regra
  daquela etapa (a regra sem etapa não pega as outras etapas, para não enviar a mesma compra a cada
  mudança). Etapa sem regra, ou chamada sem etapa quando só há regras por etapa, aparece como **sem
  atribuição** ("Etapa do pipeline do GoHighLevel sem regra"). Duas regras para a mesma etapa ficam
  retidas até você unificar.
- Para valer em todas as etapas, crie uma regra sem etapa; a regra por etapa não aceita apagar a etapa.

## Limites

- O token do GoHighLevel só lê pipelines e etapas (`opportunities.readonly`); ele nunca é usado para
  escrever no GHL.
- Uma conexão por localização. A localização precisa ter a conexão criada aqui; sem ela, a chamada
  fica "sem atribuição".
- Só contatos vindos de anúncio de WhatsApp (com `ctwa_clid`). Formulários e outras origens do GHL
  não entram.
- O formato foi portado do SaaS e coberto por testes com dados fictícios. Na primeira venda ou etapa
  real, confira em **Conversões → Gerenciar → Eventos recebidos** se o evento saiu para a Meta.

## Para a IA do repositório

- Provedor `gohighlevel`; leitores `gohighlevel/v1` (entrada) e `gohighlevel/automation-v1`
  (etapas), sementes em `apps/api/prisma/migrations/20261117120100_gohighlevel_parser_releases`
  como `observation_only` e certificadas por `20261120120000_gohighlevel_parser_certification`
  (só `UPDATE` das duas releases). Não edite migrations existentes.
- Canal: `providerChannelId = location.id`, `connectedPhone` = WhatsApp da localização.
- Origem da regra `automation_gohighlevel`; roteamento pelo `location.id`
  (`routeGoHighLevelEvent`).
- Só lead pago: a chamada orgânica é bloqueada (`ctwa_missing`) e libera a chave de dedupe
  (`gohighlevel-organic:<id>`), igual ao Webhook / n8n. Teste:
  `apps/api/test/fase6-gohighlevel/gohighlevel-organic-then-paid.test.ts`.
- Etapa do pipeline (porte do SaaS #277): leitor `gohighlevel/automation-v2`
  (`providers/gohighlevel/gohighlevel-automation-v2.parser.ts`), semeado **já certificado** por
  `20261123120000_gohighlevel_pipeline_stage` (aditiva: colunas `ghlPipelineId`,
  `ghlPipelineName`, `ghlStageId`, `ghlStageName` na regra e `ghlToken*` AES-GCM na conexão). Só a
  regra criada com `ghlStage` nasce no v2; sem filtro fica no automation-v1. Sem `ctwa_clid` o v2
  devolve `contact_not_paid_lead` ignorado, sem execução. Pipelines/etapas:
  `GET /integrations/inbound-webhooks/:connectionId/gohighlevel-pipelines`; token:
  `PUT /integrations/inbound-webhooks/:connectionId/gohighlevel-token` (só gestor de integrações;
  o token nunca volta). Nenhuma variável de ambiente nova. Testes:
  `apps/api/test/fase6-gohighlevel/gohighlevel-automation-v2.parser.test.ts`,
  `gohighlevel-pipelines.test.ts` e `gohighlevel-automation-observation.test.ts`.
