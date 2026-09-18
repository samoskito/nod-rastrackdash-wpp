# Provedores de WhatsApp — contrato, receivers e matriz de webhook

Este documento existe porque "preencher a env do provedor" **não** é a
mesma coisa que "ter uma conexão de WhatsApp funcionando por workspace",
e porque **Meta Ads** e **Meta WhatsApp (Cloud API)** são duas integrações
diferentes que só têm o nome em comum. Leia isto antes de configurar
qualquer provedor.

> Fatos verificados diretamente no código nesta revisão (não é opinião nem
> suposição de IA) — inclusive o próprio texto que a UI do produto mostra
> ao aluno. Onde o comportamento ainda não existe, este documento diz
> explicitamente **"ainda não existe"** — nunca inventa um contrato.

## Os três modelos de conexão (não confunda um pelo outro)

| Modelo | Onde se cria | Escopo | Providers |
|---|---|---|---|
| **Conexão de provedor + receiver** (`WhatsappInstance`) | `/integrations` → painel **"Provedores e receivers"** | **Por workspace, quantas você quiser** | `uazapi_byo`, `nod_api`, `waha`, `zapi` |
| **Conexão de webhook de entrada** (`InboundWebhookConnection`) | `/integrations` → painel **"Webhooks de entrada"** | **Por workspace, quantas você quiser** | `umbler`, `gupshup`, `meta_cloud` (self-service); `uazapi` só automático (ver abaixo) |
| **Meta Ads (conta de anúncios)** | `/integrations` → conexão manual Meta | Por workspace | `meta` — token de usuário do sistema, veja [`meta-manual.md`](meta-manual.md) |

Os dois primeiros modelos entregam **mensagens**. O terceiro entrega
**anúncios, Pixel e destino de conversão** — ele não recebe mensagem
nenhuma. Um workspace normalmente usa o terceiro **mais** um dos dois
primeiros.

## Envs de provedor: o que elas fazem hoje

Preencher `UAZAPI_*`, `WAHA_*`, `ZAPI_*` ou `NOD_API_BROKER_URL` **não é
mais obrigatório** para conectar um número. Hoje elas são o **padrão do
deployment**: o adapter usa as credenciais salvas na conexão do workspace
e só cai na env quando a conexão não tem aquele campo preenchido
(confirmado em `waha-whatsapp.adapter.ts`, `zapi-whatsapp.adapter.ts`,
`uazapi-byo.adapter.ts`).

Na prática:

- **Caminho recomendado (por workspace):** crie a conexão em
  `/integrations` com as credenciais daquele cliente. Cada workspace pode
  ter o seu próprio número/instância.
- **Env do deployment:** útil como valor único de fallback (uma instância
  só para todos) e para o card de status global "Instância Uazapi (BYO)"
  que ainda aparece no fim da página de Integrações.

> ⚠️ O card **"Instância Uazapi (BYO)"** no rodapé de `/integrations`
> continua descrevendo só o modo env único ("Esta edição conecta uma única
> instância Uazapi configurada por variável de ambiente"). Esse texto se
> refere **àquele card**, não ao painel "Provedores e receivers" logo
> acima, que é por workspace. Se o aluno perguntar, é isso: dois painéis,
> dois escopos.

## Painel "Provedores e receivers" — o que o aluno faz

Em `/integrations`, no painel **Provedores e receivers**:

1. **Criar a conexão.** Escolha o **Provedor**, dê um **Nome** (é esse
   nome que a exclusão vai pedir de volta) e um **Nome exibido**
   opcional. Os campos de credencial mudam por provedor:

   | Provedor | Campos pedidos na UI |
   |---|---|
   | Uazapi (BYO) | URL da API, Token, Instance ID (opcional) |
   | WAHA | URL da API, API key, Sessão |
   | Z-API | URL da API, Token, Instance ID |
   | NOD API | Instance ID, Instance token |

   As credenciais vão **criptografadas** para o banco da API e nunca
   voltam para a tela. Digite direto no formulário — nunca em chat.

2. **Testar.** O botão **Testar** chama o provedor com as credenciais
   salvas e grava o status (`connected` / `needs_reconnect` /
   `disconnected` / `error`).

3. **Gerar receiver.** O botão **Gerar receiver** devolve, **uma única
   vez**, a URL completa do receiver daquela conexão:

   ```text
   {API_PUBLIC_URL}/webhooks/whatsapp/{ID_DA_CONEXAO}?token=...
   ```

   Cole essa URL completa no campo de webhook do painel do provedor
   (Uazapi, WAHA, Z-API). Só o hash do token fica salvo no servidor — se
   perder a URL, gere outra (isso invalida a anterior).
   `API_PUBLIC_URL` precisa estar configurada, senão a geração falha.

4. **Editar.** Recarrega os metadados e permite trocar nome e
   credenciais. Deixar o campo de segredo em branco mantém o atual.

5. **Excluir.** Pede que você **digite o nome exato da conexão** para
   confirmar. A conexão é desativada (status `suspended`) e some da
   lista; o histórico no banco é preservado.

## Matriz de ingestão inbound (o que realmente chega hoje)

| Rota | Autenticação confirmada | Vínculo obrigatório do payload | Status |
|---|---|---|---|
| `POST /webhooks/whatsapp/:id` — **Uazapi (BYO)** | Token do receiver (header `x-wpptrack-webhook-token`, Bearer ou `?token=`) comparado ao hash salvo | — | **Pronto** |
| `POST /webhooks/whatsapp/:id` — **WAHA** | Idem | `payload.session` precisa ser **exatamente** a Sessão salva na conexão | **Pronto** |
| `POST /webhooks/whatsapp/:id` — **Z-API** | Idem | `body.instanceId` precisa ser **exatamente** o Instance ID salvo | **Pronto** |
| `POST /webhooks/whatsapp/:id` — **NOD API** | Idem | — | **Ainda não existe** — a rota responde `501` ("Receiver inbound para nod_api ainda nao esta disponivel") |
| `POST /webhooks/inbound/:id?token=` — **Umbler / Gupshup** | `?token=` comparado ao `secretHash` da conexão (rotacionável) | — | **Pronto** |
| `POST /webhooks/inbound/:id` — **Meta WhatsApp (Cloud API)** | `x-hub-signature-256` via `META_APP_SECRET`; **sem** `META_APP_SECRET`, só é aceito enquanto a conexão está em **observação** | — | **Pronto (CTWA)** — veja a seção Meta Cloud |
| `GET /webhooks/inbound/:id` — handshake Meta Cloud | `hub.verify_token` comparado ao **Verify token** daquela conexão | `hub.mode=subscribe` | **Pronto** |
| `POST /webhooks/uazapi` e `POST /webhooks/uazapi/instances/:id` (legado) | Env global `UAZAPI_WEBHOOK_AUTH_TOKEN` / hash por instância | Exigem uma linha `WhatsappInstance` com `provider = "uazapi"` (valor legado) — **o painel novo grava `uazapi_byo`**, então essas rotas não enxergam as conexões criadas pela UI | **Legado — use o receiver por conexão acima** |
| `GET`/`POST /webhooks/meta` | `META_WEBHOOK_VERIFY_TOKEN` / `META_APP_SECRET` | Roteamento por `page_id` até o `MetaConversionDestination` | **Pronto** — é webhook de **Meta Ads**, não de mensagens |
| Data Crazy, Zap Responder | — | — | **Não implementados** — nenhum adapter, parser ou valor de enum |

## Regra de produto que vale para todos: só CTWA vira lead

Todos os parsers inbound seguem a mesma regra: **só uma mensagem de
entrada vinda de um anúncio Click-to-WhatsApp (CTWA) pago cria lead**.
Mensagem sem CTWA é registrada e classificada como `ignored_no_ctwa` —
isso não é erro, é o contrato.

O que muda de provedor para provedor é **quais mensagens chegam**:

| Origem | Mensagem do cliente (inbound) | Mensagem do atendente (`fromMe`) |
|---|---|---|
| Uazapi (BYO) | Sim | **Sim** — avalia regras de frase/tag do atendente |
| Umbler Talk | Sim | **Sim** — o payload traz `OrganizationMember`/`Bot` |
| Gupshup | Sim | Não — envelope Cloud API só traz mensagens recebidas |
| Meta WhatsApp (Cloud API) | Sim | **Não** — veja abaixo |
| WAHA / Z-API | Sim | Não (mensagens `fromMe` são classificadas `ignored_outbound`) |

Isso decide qual gatilho faz sentido em cada origem — é o erro de
configuração mais comum hoje.

## Meta WhatsApp (Cloud API) — atribuição de CTWA, **não** gatilho de atendente

> **Isto não é a conexão de Meta Ads.** Não é o token do Gerenciador de
> Negócios de [`meta-manual.md`](meta-manual.md), não é o App ID de
> anúncios e não substitui nenhum dos dois. É o webhook do **app do
> WhatsApp Cloud API**, que entrega as mensagens que o seu número oficial
> recebe.

### Para que serve (pronto hoje)

- Conectar o número oficial da Meta **direto**, sem intermediário
  (é o mesmo papel que Kinbox/DataCrazy fazem quando "conectam a Meta").
- Receber a atribuição de **CTWA**: `referral.ctwa_clid` e
  `referral.source_id` (o ID do anúncio), além de `source_url`,
  `headline`, `body` e mídias do anúncio.
- Alimentar leads e conversões a partir desses CTWA.

### Para que **não** serve (não é limitação de configuração)

- **Gatilho por palavra-chave ou tag do atendente.** O webhook do Cloud
  API entrega apenas `messages` recebidas pelo número; ele **não entrega
  as mensagens que o seu time envia**, nem tags de CRM. Uma regra de
  origem "Mensagem no WhatsApp" com autor **equipe** nunca vai casar numa
  conexão `meta_cloud`. Quem precisa disso hoje usa **Uazapi (BYO)** ou
  **Umbler Talk**.
- **Gatilhos vindos de CRM / call center** (Kommo, Kinbox e similares):
  **futuro**, não existe no código.
- Mensagem recebida **sem** `referral.ctwa_clid` é ignorada
  (`ignored_no_ctwa`) — não vira lead.

### Passo a passo

1. Em `/integrations`, painel **Webhooks de entrada**, clique em
   **Adicionar conexão** e escolha a plataforma **Meta WhatsApp (Cloud
   API)**. Dê um nome à conexão e clique em **Gerar webhook**.
2. A tela mostra, **uma única vez**, dois valores em linhas separadas:
   **URL de callback** e **Verify token (token de verificação)**. Copie
   os dois agora — eles não voltam a aparecer. (Diferente de
   Umbler/Gupshup, a URL do Meta Cloud **não** leva `?token=`: o token
   viaja separado, no handshake.)
3. No **app Meta** (WhatsApp → Configuração → Webhooks), em **Configurar
   webhooks**, cole a **URL de callback** e o **Verify token** e clique
   em verificar e salvar. A Meta chama
   `GET /webhooks/inbound/:id?hub.mode=subscribe&hub.verify_token=...` e o
   produto devolve o `hub.challenge` quando o token confere.
4. Assine o campo **`messages`** do objeto WhatsApp Business Account.
   Sem essa assinatura a Meta valida o webhook e nunca envia nada.
5. Cadastre o **canal/número** na própria conexão (botão **Cadastrar
   canal/número**), usando o número que aparece como
   `display_phone_number` na Meta. Isso libera as regras de conversão
   antes do primeiro lead — veja a próxima seção.
6. Configure a **rota Meta** do canal (Pixel/dataset e evento de
   destino). Um canal sem rota Meta válida não pode ser ativado para
   envio automático.

### `META_APP_SECRET` — opcional para observar, necessário para produção

`META_APP_SECRET` (o **App Secret** do app Meta — *não* é o token
permanente do Graph usado em [`meta-manual.md`](meta-manual.md)) faz a API
validar o header `x-hub-signature-256` de cada POST.

| `META_APP_SECRET` | Conexão em **observação** | Conexão em **produção** (envio automático) |
|---|---|---|
| Preenchido | POST aceito só com assinatura válida | POST aceito só com assinatura válida |
| Vazio | POST aceito (a API registra o aviso `meta_cloud_signature_unverified`) | **POST recusado com `404`** |

Ou seja: dá para homologar sem ele, mas **antes de clicar em "Ativar
envios automáticos" numa conexão `meta_cloud`, preencha
`META_APP_SECRET` e faça redeploy da API** — senão as entregas param
silenciosamente do ponto de vista da Meta.

## Umbler Talk e Gupshup — conexão de webhook de entrada

1. Em `/integrations` → **Webhooks de entrada** → **Adicionar conexão**,
   escolha **Umbler Talk** ou **Gupshup**, dê um nome e clique em
   **Gerar webhook**.
2. Copie a **URL de callback** (aqui ela já vem com o `?token=`) e cole
   no campo de webhook do painel da Umbler/Gupshup. Ela aparece **uma
   única vez**; se perder, use **Gerar nova URL** (isso invalida a
   anterior).
3. **Cadastre o canal/número agora, antes do primeiro lead.** Use
   **Cadastrar canal/número** e informe o número conectado. Você **não
   precisa** esperar o primeiro webhook chegar: o produto cria um canal
   provisório e, quando a primeira mensagem real chegar para o mesmo
   número, ela é mesclada nesse mesmo canal (nada duplica).
4. Vá em `/settings#whatsapp-triggers` → **Gatilhos de conversão** e crie
   a regra em **Nova regra**, limitando-a aos canais que devem converter.

Umbler Talk entrega também as mensagens do atendente, então regras de
frase com autor "equipe" funcionam. Gupshup entrega apenas o que o
número recebe.

## Uazapi, NOD API, WAHA e Z-API — por onde os gatilhos aparecem

As conexões desse painel **não** aparecem sozinhas na lista de
"Webhooks de entrada": para Uazapi, o produto cria a origem de gatilhos
automaticamente (`UazapiConversionBridgeService`) a partir da conexão
WhatsApp — uma conexão vira uma origem e um canal, de forma idempotente.

Consequências práticas, confirmadas no código:

- A ponte roda quando chega, pelo receiver da conexão, uma **mensagem
  enviada pelo próprio número conectado** (mensagem do atendente) ou uma
  **mudança de etiqueta** em uma conversa. Depois de registrar o receiver
  no painel da Uazapi, responda uma conversa pelo número conectado (ou
  aplique uma etiqueta): a origem então aparece em
  `/settings#whatsapp-triggers` e você cria a **Nova regra** ali. Só uma
  mensagem recebida do cliente não basta para criar a origem.
- A ponte só funciona com as flags `INBOUND_*` ligadas (veja abaixo) —
  com elas desligadas, a avaliação de regras nem começa.
- Criar uma conexão inbound `uazapi` **na mão** é recusado de propósito:
  *"Conexoes UAZAPI sao criadas automaticamente a partir da instancia
  WhatsApp"*.
- **WAHA e Z-API** têm receiver e parser prontos (leads e conversões de
  CTWA funcionam), mas **ainda não têm** ponte automática para a central
  de Gatilhos. Trate isso como lacuna conhecida do produto, não como um
  passo que você esqueceu de clicar.
- **NOD API** ainda não tem receiver inbound (a rota responde `501`).

> ⚠️ Os cartões de status do painel "Provedores e receivers" ainda trazem
> o texto antigo *"Ingestion pendente: receiver e parser WAHA/Z-API ainda
> nao existem"*. Esse texto está desatualizado em relação ao backend
> (os receivers existem e estão ligados). Vale o que está na matriz acima.

## Gatilhos de conversão exigem as envs `INBOUND_*`

Vale para **qualquer origem** (Uazapi, NOD API, WAHA, Z-API, Umbler,
Gupshup, Meta Cloud). O padrão de todas elas é **desligado**, então
leads podem chegar normalmente e **Nova regra** simplesmente não
aparecer:

```text
INBOUND_WEBHOOKS_ENABLED=true
INBOUND_WEBHOOK_ENCRYPTION_KEY=<Base64 de 32 bytes>
INBOUND_CONVERSION_RULES_ENABLED=true
INBOUND_WEBHOOK_PRODUCTION_ENABLED=true
```

Depois, **redeploy da API**. Detalhe de cada variável em
[`environment.md`](environment.md#gatilhos-de-conversão--obrigatórias-no-caminho-do-aluno).

## Por provedor

### Uazapi BYO (`uazapi_byo`)

- Você roda sua própria instância Uazapi (fora deste template).
- Credenciais: painel da sua instância — URL da API, Token e, se você usar,
  o Instance ID. Nunca um token de frota administrativo;
  `UAZAPI_ADMIN_TOKEN` não existe neste template e não deve ser
  reintroduzido.
- Env de fallback: `UAZAPI_BASE_URL`, `UAZAPI_TOKEN`.
- Receiver inbound: **pronto** (`/webhooks/whatsapp/:id`).
- Único provedor com catálogo de labels (`listLabels`) para gatilhos por tag.
- Avalia mensagem de atendente (`fromMe`) contra regras de frase.

### NOD API (`nod_api`)

- Broker gerenciado pela PalmUP, add-on licenciado — você não hospeda
  essa parte.
- Credenciais na UI: Instance ID e Instance token. Env de fallback:
  `NOD_API_BROKER_URL` (já preenchida no `.env.example`); o broker
  autentica com a `LICENSE_KEY` + fingerprint da instância.
- Status/health: pronto. **Receiver inbound: ainda não existe** (`501`).

### WAHA (`waha`, self-host)

- Você roda sua própria instância [WAHA](https://github.com/devlikeape/waha).
- Credenciais na UI: URL da API, API key e **Sessão** (padrão `default`).
  Env de fallback: `WAHA_BASE_URL`, `WAHA_API_KEY`, `WAHA_SESSION`.
- Receiver inbound: **pronto**, mas o `payload.session` de cada entrega
  precisa bater exatamente com a Sessão salva — se não bater, `401`.
  Se você mudou a sessão, use **Gerar receiver** de novo (isso também
  regrava a sessão a partir da configuração salva).
- Ainda **sem** ponte automática para a central de Gatilhos.

### Z-API (`zapi`)

- Você roda ou assina sua própria instância [Z-API](https://www.z-api.io/).
- Credenciais na UI: URL da API, Instance ID e Token. Env de fallback:
  `ZAPI_BASE_URL`, `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`.
- Receiver inbound: **pronto**, com o mesmo vínculo estrito —
  `body.instanceId` precisa bater com o Instance ID salvo.
- Ainda **sem** ponte automática para a central de Gatilhos.

### Data Crazy e Zap Responder

**Não implementados neste código.** Não existe adapter, parser, nem valor
de enum para nenhum dos dois. Não oriente o aluno a preencher variáveis
de ambiente para esses nomes: não existe nada no backend para consumi-las.
Se quiser conectar a Meta "direto", como esses serviços fazem, o caminho
pronto é **Meta WhatsApp (Cloud API)** acima.

## Onde cada credencial vem

| Provedor | Onde o aluno encontra a credencial |
|---|---|
| Uazapi BYO | Painel da própria instância Uazapi |
| NOD API | Instance ID/token do add-on PalmUP; o broker usa a `LICENSE_KEY` já configurada |
| WAHA | Painel/configuração da própria instância WAHA self-hosted |
| Z-API | Painel da conta Z-API do aluno |
| Umbler / Gupshup | Painel de cada serviço — lá você cola a URL de callback (com `?token=`) gerada aqui |
| Meta WhatsApp (Cloud API) | App Meta → WhatsApp → Configurar webhooks; o `META_APP_SECRET` é o App Secret do mesmo app |
| Meta Ads | Gerenciador de Negócios (Meta Business Suite) — veja [`meta-manual.md`](meta-manual.md) |

## Referências

- [`environment.md`](environment.md) — tabela completa de variáveis.
- [`meta-manual.md`](meta-manual.md) — Meta **Ads** (usuário do sistema).
- [`troubleshooting.md`](troubleshooting.md) — sintomas de webhook não
  autorizado, handshake recusado e "Nova regra" que não aparece.
