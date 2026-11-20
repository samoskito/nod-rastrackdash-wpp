# GoHighLevel: entrada do lead e conversões das etapas do Workflow

Porte do SaaS. O GoHighLevel (GHL) entra no RastrackDash por **Workflows** da localização do seu
cliente:

| O que acontece no GoHighLevel | URL que recebe | O que o RastrackDash faz |
|---|---|---|
| **Entrada do lead** (um contato que veio de um anúncio de WhatsApp entra no Workflow) | URL da **conexão** GoHighLevel (uma por localização) | Cria (ou atualiza) o lead com o clique do anúncio, conta em "Conversas reais iniciadas" e segue as regras de sempre (Lead recebido, uma vez por lead e pixel). |
| **Etapa do Workflow** (lead qualificado, compra, Lead recebido) | URL da **regra** "Etapa no GoHighLevel" (uma por regra/evento) | Envia o evento da regra para a Meta, para o lead que veio do anúncio. |

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

## Limites

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
