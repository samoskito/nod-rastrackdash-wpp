# ROI Chat: entrada do anúncio e compra como conversões (uma URL por número)

Fase 6.8. O ROI Chat é um provedor de **WhatsApp API Oficial**. Cada número seu no ROI Chat vira
**uma conexão** no RastrackDash, com **a própria URL**. A mesma URL recebe os dois avisos do ROI
Chat:

| Aviso do ROI Chat | O que acontece |
|---|---|
| **Entrada do lead** (conversa que veio de um anúncio; sem `event_name`) | O lead é criado (ou atualizado) com o anúncio de origem, conta em "Conversas reais iniciadas" e segue as regras de sempre (Lead recebido, uma conversão por lead e pixel). |
| **Compra** (`event_name: "Purchase"`, com `valor_venda` e `moeda`) | Vai para a regra **"Compra no ROI Chat"** do número e chega à Meta como `Purchase`, com o valor e a moeda da compra. |
| Outro `event_name` | Recebido e ignorado. |

Os leitores do ROI Chat já vêm **em uso** com a atualização: foram validados com os payloads reais
recebidos no SaaS (o formato real traz os dados do anúncio dentro de `anuncio`). Você **não**
precisa liberar, certificar nem testar nada: a conexão, o número e a regra já nascem enviando.
Continuam valendo as travas de sempre: licença ativa, rota da Meta (conta de anúncio e pixel) do
número e um lead que chegou por anúncio (com `ctwa_clid`).

## Antes de começar

- Atualize a instalação (veja [`update.md`](update.md)). Esta atualização tem migrations: **faça o
  backup do PostgreSQL antes**. Não há variável de ambiente nova para o ROI Chat.
- A conexão só existe com os webhooks de entrada e as regras de conversão ligados na instalação
  (`INBOUND_WEBHOOKS_ENABLED` e `INBOUND_CONVERSION_RULES_ENABLED`, já ligados no `.env.example`).
- Conecte a Meta Ads (Integrações → aba **Anúncios**) com a conta de anúncio que roda os anúncios
  que levam ao WhatsApp: é por ela que a rota do número é encontrada.

## 1. Criar a conexão de cada número

1. Abra **Integrações** → aba **WhatsApp** → card **ROI Chat** (ao lado de WAHA e WhatsApp Cloud API).
2. Clique em **Gerar webhook**, informe um **nome** (ex.: "ROI Chat - Loja") e o **número de
   WhatsApp** atendido pelo ROI Chat, com DDI e DDD (ex.: `+55 11 99999-0001`). É o **seu** número,
   nunca o telefone do lead.
3. Copie a **URL completa**, com `?token=`. Ela aparece **uma única vez**; se perder, gere outra em
   **Gerar nova URL** na mesma conexão (a antiga para de funcionar).
4. Para outro número, crie **outra conexão**: um número = uma conexão = uma URL.

## 2. Configurar o webhook no ROI Chat

1. No ROI Chat, abra a configuração de webhook **do mesmo número** que você cadastrou.
2. Cole a URL completa (com o token). Método **POST**, corpo **JSON**. Não precisa de cabeçalho
   extra.
3. Use **a mesma URL** para a entrada do lead e para a compra.

O RastrackDash lê o corpo do ROI Chat assim (todos os campos são opcionais, menos o telefone do
lead):

- **Entrada:** `nome`, `telefone` e o objeto `anuncio` com `source_id` (ID do anúncio),
  `ctwa_clid` (clique do anúncio), `source_url`, `headline`, `media_type`, `video_url`,
  `thumbnail_url`. Os mesmos campos no primeiro nível (fora de `anuncio`) também são lidos.
- **Compra:** o mesmo corpo com `event_name: "Purchase"` (ou `"compra"`), `valor_venda`
  (`"20.00"`, `"20,00"`, `"1.234,56"` ou número) e `moeda` (`BRL`, `USD`, `EUR` ou `R$`).
- `event_time` (segundos; 13 dígitos = milissegundos) é opcional: sem ele vale a hora do
  recebimento, e um horário no futuro vira a hora do recebimento.
- O `event_id` do ROI Chat é ignorado: o RastrackDash gera o seu.
- Telefone com `+` (ou `00`) é usado como veio; sem prefixo, um número brasileiro ganha o 55.

## 3. Rota da Meta do número

A rota (conta de anúncio e pixel) é **aprendida sozinha** pelo anúncio (`source_id`) da primeira
entrada, quando a conta de anúncio está conectada em Meta Ads. Em **Integrações → ROI Chat →
conexão → Números desta conexão**, o número mostra a prontidão. Se ele disser que falta a rota,
salve a rota ali mesmo (BM, conta e destino com pixel e página). Sem rota, nada é enviado e a tela
diz o que falta.

## 4. Criar a regra "Compra no ROI Chat"

Em **Conversões → Nova regra → Compra no ROI Chat**:

- O evento é sempre **Compra realizada** (`Purchase`).
- **Alcance:** "Todos os números do ROI Chat (todas as conexões)" ou números específicos (de uma
  mesma conexão). A compra que chega na URL de um número **só** vale para esse número.
- **Valor:** o de cada compra (`valor_venda`). O **valor de reserva** é opcional e só vale para uma
  compra que chegar sem `valor_venda`. Se `valor_venda` ou `moeda` vierem ilegíveis (ex.: `"abc"`,
  `MXN`), a compra é recusada e nada vai para a Meta (nunca é enviada com outro valor).
- A regra já nasce enviando. Não há URL nova para colar: a compra chega pela URL do número.

**Recompra e repetição:** a mesma pessoa pode comprar mais de uma vez. A **mesma compra** (mesmo
lead, mesmo número, mesmo valor e mesma moeda) repetida em menos de **12 horas** conta uma vez só
("Mesma compra (mesmo valor e moeda) repetida em menos de 12h"). Outro valor, outra moeda, outro
número ou mais de 12 horas depois é uma compra nova.

- Uma compra repetida em menos de 12 horas conta como a primeira, mesmo que a primeira não tenha
  sido enviada (por exemplo, chegou antes de existir a regra ou a rota). Depois de ajustar, use
  **Reprocessar** em **Gerenciar → Eventos recebidos** da regra.
- Uma compra manual do mesmo lead lançada nas últimas 24 horas para o mesmo pixel continua
  bloqueando a compra automática (regra de sempre da conversão manual), mesmo com outro valor.

Uma compra que chega sem regra "Compra no ROI Chat" para o número fica guardada na conexão como
"Compra do ROI Chat sem regra" e nunca vira entrada nem é enviada.

## 5. Mesmo lead em outro número (WAHA, Uazapi, Meta Cloud...)

Se o mesmo lead também fala com um número WAHA (ou outro número seu), o RastrackDash manda **um**
`LeadSubmitted`/`QualifiedLead` por lead e por pixel: a entrada do ROI Chat e a frase do número
WAHA não geram dois eventos no mesmo pixel ("Lead já convertido por outro número"). A compra não
entra nessa trava: a compra do ROI Chat segue a regra de 12 horas acima.

## Licença bloqueada

Com a licença bloqueada, toda escrita responde `423`: criar a conexão ROI Chat, gerar nova URL,
criar ou editar a regra e a própria URL do número (entrada e compra). A leitura continua: as telas,
as conexões e os eventos recebidos.

## Conferir depois de instalar

1. No log da API, as migrations `20261027170000_roichat_provider` e
   `20261027170100_roichat_parser_releases` aparecem aplicadas sem erro.
2. Em **Backoffice → Webhooks WhatsApp → Leitores de webhook**, `ROI Chat v1` e
   `ROI Chat automation-v1` aparecem **Em uso**.
3. O card **ROI Chat** aparece em **Integrações → WhatsApp**; ao criar a conexão, a URL aparece e a
   conexão fica **Enviando conversões**.
4. Uma entrada real de anúncio (com `ctwa_clid` e `source_id`) cria o lead em **Leads**, com o
   anúncio de origem, e o `LeadSubmitted` chega ao Gerenciador de Eventos (se não houver regra de
   Lead recebido que assuma esse envio).
5. Com a regra "Compra no ROI Chat" criada, uma compra desse lead aparece em **Conversões → regra →
   Gerenciar → Eventos recebidos** e o `Purchase` chega ao Gerenciador de Eventos com o valor e a
   moeda da compra.
6. A mesma compra reenviada em menos de 12 horas aparece como repetida e não gera um segundo
   `Purchase`.

## Problemas comuns

- **Nada chega:** confira se a URL colada no ROI Chat é a completa (com `?token=`) e do número certo.
  URL antiga (depois de **Gerar nova URL**) responde 404.
- **Entrada como "sem anúncio":** a conversa não trouxe `ctwa_clid` (dentro de `anuncio` ou no
  primeiro nível). Sem o clique do anúncio, nada vai para a Meta.
- **Compra sem `Purchase`:** confira se existe a regra "Compra no ROI Chat" para o número e se o lead
  da compra entrou por anúncio nesse número (mesmo telefone).
- **"Falta a rota Meta":** conecte a conta de anúncio em Meta Ads ou salve a rota do número.

## Pendências conhecidas

- PENDENTE: o logo oficial do ROI Chat e a permissão de uso; hoje o card usa um logotipo de texto.
- O ROI Chat não manda número de pedido: por isso a repetição é decidida pela regra de 12 horas
  (mesmo lead, número, valor e moeda). Duas compras idênticas no mesmo instante podem ser recebidas
  as duas, mas só uma é enviada à Meta.

## Recuperação

Voltar o código não desfaz as migrations: o valor `roichat` dos enums e os dois leitores do ROI Chat
ficam no banco e são ignorados pela versão anterior (não apague). Na versão anterior, o card e a
regra do ROI Chat somem e as URLs dos números deixam de ser lidas; as conexões e os recebimentos já
guardados ficam no banco. Só restaure o backup do PostgreSQL com orientação.
