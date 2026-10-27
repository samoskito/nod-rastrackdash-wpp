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
| **Conexão de provedor + receiver** (`WhatsappInstance`) | `/integrations` → aba **WhatsApp** → card do provedor (Uazapi e WAHA; Z-API e NOD API aparecem como "Em breve" — conexões já existentes continuam gerenciáveis) | **Por workspace, quantas você quiser** | `uazapi_byo`, `nod_api`, `waha`, `zapi` |
| **Conexão de webhook de entrada** (`InboundWebhookConnection`) | `/integrations` → aba **Atendimento e vendas** → card Umbler Talk / Gupshup / Data Crazy / Unnichat; aba **WhatsApp** → card **WhatsApp Cloud API** (Meta) e card **ROI Chat** | **Por workspace, quantas você quiser** | `umbler`, `gupshup`, `data_crazy`, `unnichat` (conexão presa ao número; [`unnichat.md`](unnichat.md)), `roichat` (Fase 6.8, conexão presa ao número; a mesma URL recebe entrada e compra; [`roichat.md`](roichat.md)), `meta_cloud` (self-service); `uazapi` só automático (ver abaixo) |
| **Meta Ads (conta de anúncios)** | `/integrations` → aba **Anúncios** → card **Meta Ads** (login social ou token; não recebe conversas) | Por workspace | `meta` — token de usuário do sistema, veja [`meta-manual.md`](meta-manual.md) |

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

> ⚠️ Dentro do card **Uazapi** (aba WhatsApp), o bloco **"Instância Uazapi
> (BYO)"** continua descrevendo só o modo env único ("Esta edição também lê
> uma instância Uazapi configurada por variável de ambiente"). Esse texto se
> refere **àquele bloco** (status global do deployment), não às conexões
> por workspace listadas acima dele no mesmo card. Se o aluno perguntar, é
> isso: dois blocos, dois escopos.

## Aba WhatsApp — Uazapi e WAHA (Z-API e NOD API: Em breve): o que o aluno faz

Em `/integrations`, aba **WhatsApp**, clique no card do provedor (Uazapi ou WAHA; Z-API e NOD API estão como "Em breve" para novas conexões). A janela que abre já vem fixa nesse provedor:

1. **Criar a conexão.** Dê um **Nome** (é esse
   nome que a exclusão vai pedir de volta) e um **Nome exibido**
   opcional. Os campos de credencial mudam por provedor:

   | Provedor | Campos pedidos na UI |
   |---|---|
   | Uazapi (BYO) | URL da API, Token, Instance ID (opcional) |
   | WAHA (GoWS, servidor seu) | Nome, URL da API, API key, **Sessão** (obrigatória); veja [WAHA com motor GoWS](#waha-com-motor-gows-waha-servidor-do-aluno) |
   | Z-API (Em breve no Hub; só conexões já existentes) | URL da API, Token, Instance ID |
   | NOD API (Em breve no Hub; só conexões já existentes) | Instance ID, Instance token |

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
| `POST /webhooks/whatsapp/:id` — **WAHA** (motor GoWS) | Idem (a configuração automática manda o token no cabeçalho `X-Wpptrack-Webhook-Token`) | `session` do envelope precisa ser **exatamente** a Sessão salva na conexão | **Pronto** — parser `waha` v2 (GoWS) enquanto a release certificada existir; veja [WAHA com motor GoWS](#waha-com-motor-gows-waha-servidor-do-aluno). Liberada no Hub, com regras de frase da equipe em Conversões |
| `POST /webhooks/whatsapp/:id` — **Z-API** | Idem | `body.instanceId` precisa ser **exatamente** o Instance ID salvo | **Em breve** — o parser ainda não lê o payload real da Z-API; não use para receber leads |
| `POST /webhooks/whatsapp/:id` — **NOD API** | Idem | — | **Ainda não existe** — a rota responde `501` ("Receiver inbound para nod_api ainda nao esta disponivel"). Em breve no Hub: só para conexões já existentes |
| `POST /webhooks/inbound/:id?token=` — **Umbler / Gupshup / Data Crazy / Unnichat / ROI Chat** | `?token=` comparado ao `secretHash` da conexão (rotacionável) | — | **Pronto** |
| `POST /webhooks/inbound/:id` — **Meta WhatsApp (Cloud API)** | `x-hub-signature-256` via `META_APP_SECRET`; **sem** `META_APP_SECRET`, só é aceito enquanto a conexão está em **observação** | — | **Pronto (CTWA)** — veja a seção Meta Cloud |
| `GET /webhooks/inbound/:id` — handshake Meta Cloud | `hub.verify_token` comparado ao **Verify token** daquela conexão | `hub.mode=subscribe` | **Pronto** |
| `POST /webhooks/uazapi` e `POST /webhooks/uazapi/instances/:id` (legado) | Env global `UAZAPI_WEBHOOK_AUTH_TOKEN` / hash por instância | Exigem uma linha `WhatsappInstance` com `provider = "uazapi"` (valor legado) — **o painel novo grava `uazapi_byo`**, então essas rotas não enxergam as conexões criadas pela UI | **Legado — use o receiver por conexão acima** |
| `GET`/`POST /webhooks/meta` | `META_WEBHOOK_VERIFY_TOKEN` / `META_APP_SECRET` | Roteamento por `page_id` até o `MetaConversionDestination` | **Pronto** — é webhook de **Meta Ads**, não de mensagens |
| Zap Responder | — | — | **Não implementado** — não há contrato para este provedor |

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
| Data Crazy | Sim | Não — mensagens inbound só viram lead quando têm CTWA |
| Meta WhatsApp (Cloud API) | Sim | **Não** — veja abaixo |
| WAHA (GoWS) | Sim (evento `message`) | **Sim** — lidas pelo evento `message.any` e avaliadas contra as regras de frase da equipe, como na Uazapi (sem etiquetas) |
| Z-API | Em breve | Em breve (sem leads de anúncio nem regras de frase por enquanto) |

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
- **Regras de frase da equipe.** Pelo mesmo motivo (a Meta não entrega
  pelo webhook da Cloud API as mensagens enviadas pela equipe), as regras
  de frase da equipe não funcionam numa conexão Meta Cloud. O que fazer:
  - **Número com coexistência** (app WhatsApp Business junto com a Cloud
    API): conecte esse número pela **Uazapi** do aluno (URL + token da
    sua própria instância). Ela entrega o anúncio (CTWA) e as mensagens
    da equipe.
  - **Sem coexistência:** a conversão por frase depende de integrar a
    plataforma que a equipe usa para responder (CRM/atendimento), por
    exemplo chamando a URL única de conversão. Fale com o suporte.
- **Gatilhos vindos de CRM** — **Kommo existe** e é conectado em
  `/integrations` → aba **CRM** → card **Kommo** (somente o dono da conta);
  ele não depende da conexão Meta Cloud. **Kinbox e outros CRM / call center**:
  **futuro**, não existe no código.
- Mensagem recebida **sem** `referral.ctwa_clid` é ignorada
  (`ignored_no_ctwa`) — não vira lead.

### Passo a passo

Toda a conexão Meta Cloud é sua: usa o **seu** app Meta (o mesmo de
`META_APP_ID` e `META_APP_SECRET` na API) e o **seu** número oficial. Não
existe QR code e o "Conectar Meta" de anúncios não serve para isso.

São **três passos diferentes na Meta**, e os três são obrigatórios. É comum
fazer só o primeiro (ou os dois primeiros) e a Meta nunca entregar nada:

| Passo | Onde | O que faz |
|---|---|---|
| 1. Confirmar a URL (handshake) | App Meta → WhatsApp → Configuração → Webhooks | A Meta testa a URL de callback com o verify token. Só prova que a URL responde. |
| 2. Assinar o campo `messages` | Mesma tela de Webhooks do app | Diz ao **app** que ele quer receber o evento `messages` do objeto WhatsApp Business Account. |
| 3. Inscrever o app na WABA | Pelo painel (bloco **Inscrição do app na sua WABA**) ou manualmente | Liga a **sua conta do WhatsApp Business (WABA)** a este app (`POST /{WABA ID}/subscribed_apps`). Sem isso a WABA não manda os eventos para o app. |

1. Em `/integrations`, aba **WhatsApp**, abra o card **WhatsApp Cloud API**,
   clique em **Adicionar conexão** (já aberto quando não há nenhuma), dê
   um nome à conexão e clique em **Gerar webhook**.
2. A tela mostra, **uma única vez**, dois valores em linhas separadas:
   **URL de callback** e **Verify token (token de verificação)**. Copie
   os dois agora — eles não voltam a aparecer. (Diferente de
   Umbler/Gupshup, a URL do Meta Cloud **não** leva `?token=`: o token
   viaja separado, no handshake.)
3. **Passo 1 — confirmar a URL.** No **app Meta** (WhatsApp → Configuração
   → Webhooks), em **Configurar webhooks**, cole a **URL de callback** e o
   **Verify token** e clique em verificar e salvar. A Meta chama
   `GET /webhooks/inbound/:id?hub.mode=subscribe&hub.verify_token=...` e o
   produto devolve o `hub.challenge` quando o token confere.
4. **Passo 2 — assinar o campo `messages`.** Na mesma tela, em **Campos do
   webhook**, assine **`messages`** do objeto WhatsApp Business Account.
5. **Passo 3 — inscrever o app na WABA.** Na conexão, use o bloco
   **Inscrição do app na sua WABA** (veja a próxima seção) ou faça a
   inscrição manual.
6. Cadastre o **canal/número** na própria conexão (botão **Cadastrar
   canal/número**), usando o número que aparece como
   `display_phone_number` na Meta. Isso libera as regras de conversão
   antes do primeiro lead — veja a seção seguinte.
7. Configure a **rota Meta** do canal (Pixel/dataset e evento de
   destino). Um canal sem rota Meta válida não pode ser ativado para
   envio automático.

### Inscrição do app na sua WABA pelo painel

Em `/integrations` → aba **WhatsApp** → card **WhatsApp Cloud API** → abra a
conexão. O bloco **Inscrição do app na sua WABA** consulta e faz o passo 3
sem sair do painel. Só o **dono** ou um **admin** do workspace vê os botões
funcionando; com a licença bloqueada, consultar e inscrever ficam
indisponíveis (a API responde `423`).

**Requisitos**

- `META_APP_ID` e `META_APP_SECRET` do **seu** app configurados na API. Sem
  eles o painel avisa que a instalação precisa das duas variáveis e não
  tenta nada.
- O **WABA ID** — o "ID da conta do WhatsApp Business". Fica em
  developers.facebook.com → seu app → **WhatsApp → Configuração da API**,
  logo acima do número, ou no Gerenciador do WhatsApp. **Não** é o ID do
  número (phone number ID); se você colar o ID do número, o painel avisa.
- Um **token do mesmo app configurado na instalação** (`META_APP_ID`), com a
  permissão `whatsapp_business_management` e gerado por alguém com acesso
  de **admin à WABA**. Serve qualquer um destes:
  - o **token temporário** de WhatsApp → Configuração da API, no painel do
    app (o mais simples; vale cerca de 24 h);
  - um token gerado no **Graph API Explorer** para o mesmo app;
  - um token de **system user** do Gerenciador de Negócios.

**Como funciona**

1. Preencha o WABA ID e cole o token. O token é usado **só nessa
   requisição** e descartado: não é salvo no banco nem no navegador, não
   volta na resposta, não vai para logs nem para a auditoria. Por isso é
   preciso colá-lo de novo a cada ação.
2. **Consultar** mostra os apps inscritos na WABA, destacando **Este app**,
   e os números dessa WABA. Se algum número que já chegou por webhook nesta
   conexão não pertencer a essa WABA, o painel avisa.
3. **Inscrever este app** pede confirmação, inscreve o app da instalação
   (sem trocar a URL de callback) e **reconsulta** a Meta para mostrar o
   estado real. Outros apps inscritos (CRM, BSP etc.) continuam lá: o
   painel nunca remove nenhum app.

Antes de tocar na WABA, a API confere o token na Meta (`debug_token`, com o
app token montado só no servidor) e para com uma mensagem clara quando o
token é inválido ou expirou, foi gerado para **outro app** (a assinatura
dos webhooks é conferida com o segredo do app da instalação), não tem
`whatsapp_business_management` ou foi restrito a outras WABAs. Erros da
Meta de permissão, ID errado, limite de chamadas ou rede também aparecem
em português. Consultas e inscrições ficam na auditoria do workspace com o
WABA ID, o resultado e quem fez — sem o token.

**Inscrição manual (se o painel falhar)**

1. Abra o **Graph API Explorer** e escolha o app configurado na instalação.
2. Gere um token de usuário com `whatsapp_business_management` e selecione
   a sua WABA.
3. Faça `POST <WABA ID>/subscribed_apps`, sem parâmetros. A resposta
   esperada é `success: true`.
4. Confira com `GET <WABA ID>/subscribed_apps`: o app da instalação precisa
   aparecer na lista. Não apague outros apps.

> As **regras de frase da equipe** continuam fora do Meta Cloud: a Meta não
> entrega as mensagens que o seu time envia, e a inscrição na WABA não muda
> isso. Ela só libera o recebimento das mensagens dos clientes (CTWA).

### Rota com qualquer conta do BM e ativação do Meta Cloud

Você pode salvar **uma única rota** com o BM, **qualquer conta desse BM**
e um destino escolhido. Não precisa criar uma rota por conta: um BM com três
contas e um único destino usa a mesma rota. A conta explícita continua
suportada; o destino também pode ficar opcional para resolução por anúncio.

Antes de salvar ou ativar, o BM e sua credencial precisam estar ativos no
workspace, com ao menos uma conta ativa desse BM autorizada a usar um destino
configurado. O destino padrão do BM, sozinho, **não autoriza todas as contas**:
confira os destinos permitidos de cada conta em **Tokens, BMs e destinos**.
O vínculo explícito antigo de destino da própria conta continua aceito.

Cada CTWA resolve a conta pelo anúncio sincronizado e verifica novamente BM,
credencial, workspace, conta e autorização do destino. Se uma conta não tiver
acesso, o anúncio estiver ausente ou houver vários destinos sem atribuição
única ao anúncio, esse evento permanece bloqueado. Escolher um Pixel/Página
na rota não elimina essa ambiguidade. Salvar uma rota restringe o roteamento:
a reavaliação não acrescenta rotas automaticamente fora dessa escolha.

**Rota pronta** descreve a rota e os payloads preservados; não significa que
a conexão já envia. Ative o canal e só depois promova a conexão, que exige
parser elegível, produção habilitada e nenhuma recuperação pendente. Confira
também a licença e as permissões da instalação. Antes da produção Meta Cloud,
configure o App Secret do **seu próprio app** somente no servidor conforme a
seção abaixo; não use segredo PalmUP nem envie valores por chat.

A integração nativa **meta_cloud/v1** já validada pelo produto permite a
ativação humana em instalações novas e antigas, inclusive quando o estado
persistido é `observation_only`. Não exige primeira CTWA nem certificação
privada por instalação. Essa elegibilidade não altera o estado guardado e
não libera outras versões/implementações ou `retired`. A assinatura manual
do campo `messages` no app Meta continua necessária.

### CTWA preservados antes da ativação

Ativar o canal e salvar rotas reavalia eventos abertos; isso apenas atualiza
o roteamento. **Não envia automaticamente CTWA recebidos antes da ativação**
da conexão/canal. A recuperação periódica recoloca na fila itens de produção
que já existiam e ficaram pendentes; não transforma observações antigas em
novos itens.

O worker de replay existente aceita a rota com conta/destino opcionais e
materializa um evento histórico somente com parser certificado, payload
cifrado ainda disponível, janela histórica válida, ativos autorizados e
identidade correspondente ao parser. Mantém a deduplicação e não reenfileira
uma conversão já enviada. Isso foi verificado com fixtures locais, sem envio
Meta real. O payload bruto tem retenção de sete dias; sem payload disponível
esse caminho não pode reprocessar o evento.

O template mantém replay **desligado por padrão**. O operador pode habilitar
explicitamente `INBOUND_WEBHOOK_REPLAY_ENABLED` na API. O **owner membro do
workspace corrente** acessa **Recuperar CTWAs anteriores** no canal em
Integrações: prévia sem envio, nome exato da conexão, confirmação de **Enviar
um de teste** (conversão real), consulta/polling e, após entrega confirmada
no mesmo contexto, nova prévia e confirmação de **Recuperar os demais (ate
500)**. Materialização/fila não significam envio; UNKNOWN não permite retry.
O contexto é revalidado na autorização, no worker e antes do dispatch.

Leia o [guia do aluno e operador](meta-cloud-recovery.md) para flags, App
Secret próprio, retenção, resultados, atualização e recuperação. Não edite
o banco nem apague tentativas para contornar um bloqueio. A validação é
local com fixtures; nenhum envio Meta real foi feito nesta entrega.

### `META_APP_SECRET` — opcional para observar, necessário para produção

`META_APP_SECRET` (o **App Secret** do app Meta — *não* é o token
permanente do Graph usado em [`meta-manual.md`](meta-manual.md)) faz a API
validar o header `x-hub-signature-256` de cada POST.

| `META_APP_SECRET` | Conexão com o **envio desligado** | Conexão em **produção** (envio automático) |
|---|---|---|
| Preenchido | POST aceito só com assinatura válida | POST aceito só com assinatura válida |
| Vazio | POST aceito (a API registra o aviso `meta_cloud_signature_unverified`) | **POST recusado com `404`** |

Ou seja: **preencha `META_APP_SECRET` do próprio app e reinicie a API
antes de criar a conexão `meta_cloud`**. Produção direta (Fase 6.1c): com o
segredo, a conexão já nasce enviando; sem ele, nasce com o envio desligado
(para não recusar as entregas da Meta) e a ativação e a autorização de
recuperação ficam bloqueadas até o segredo existir. Uma
conexão em produção continua recusando POSTs sem assinatura válida. Nunca
use o segredo PalmUP nem envie o valor por chat.

## Data Crazy — conexão de webhook de entrada (CTWA)

Use Data Crazy como uma conexão inbound por workspace; ele não exige
credencial ou variável de ambiente própria neste template.

1. Em `/integrations` → aba **Atendimento e vendas** → card **Data Crazy**,
   dê um nome e clique em **Gerar webhook**.
2. Copie a **URL de callback** completa, incluindo `?token=`. Ela aparece
   uma única vez; se perder, use **Gerar nova URL**, que invalida a URL
   anterior.
3. No Data Crazy, crie uma automação HTTP para **mensagem recebida** e
   cole essa URL. O contrato é
   `{API_PUBLIC_URL}/webhooks/inbound/{ID_DA_CONEXAO}?token=...`.
4. Aguarde o primeiro webhook: o canal é descoberto automaticamente a
   partir da instância do Data Crazy. **Não há cadastro manual de canal
   provisório nem número de telefone provisório** para esse provedor.
5. Só mensagens inbound com atribuição **CTWA** se tornam leads
   operacionais. Mensagens sem CTWA ficam registradas como
   `ignored_no_ctwa`; gatilhos por palavra-chave, tag ou automação do
   provedor não fazem parte do parser Data Crazy v1.
6. O parser **Data Crazy v1** já vem certificado pela migration
   `20261016090300_validated_parser_certification` (contrato validado com
   CTWAs reais no SaaS). Produção direta (Fase 6.1c): a conexão nasce em
   produção, o canal já envia quando aparece e cada regra nasce enviando.
   Configure a rota Meta do canal: sem rota, nada é enviado e a prontidão
   do número diz o que falta.

## Umbler Talk e Gupshup — conexão de webhook de entrada

1. Em `/integrations` → aba **Atendimento e vendas** → card **Umbler Talk**
   ou **Gupshup**, dê um nome e clique em **Gerar webhook**.
2. Copie a **URL de callback** (aqui ela já vem com o `?token=`) e cole
   no campo de webhook do painel da Umbler/Gupshup. Ela aparece **uma
   única vez**; se perder, use **Gerar nova URL** (isso invalida a
   anterior).
3. **Cadastre o canal/número agora, antes do primeiro lead.** Use
   **Cadastrar canal/número** e informe o número conectado. Você **não
   precisa** esperar o primeiro webhook chegar: o produto cria um canal
   provisório e, quando a primeira mensagem real chegar para o mesmo
   número, ela é mesclada nesse mesmo canal (nada duplica).
4. Vá em `/conversions` (menu **Conversões**) e crie a regra em
   **Nova regra**, escolhendo "Todos os números" ou apenas os números que
   devem converter.
5. Os parsers **Umbler v1** e **Gupshup v1** (mensagens) já vêm
   certificados pela migration `20261016090300_validated_parser_certification`
   (os mesmos contratos em produção no SaaS). Produção direta (Fase 6.1c):
   a conexão nasce em produção, cada número já envia e cada regra nasce
   enviando; a rota Meta de cada número continua obrigatória para enviar. A certificação também permite autorizar o
   **replay controlado** de uma conexão Umbler, Gupshup ou Data Crazy
   com o envio desligado (antes ele pedia o parser certificado).

Umbler Talk entrega também as mensagens do atendente, então regras de
frase com autor "equipe" funcionam. Gupshup entrega apenas o que o
número recebe.

**Automação da Umbler por URL do evento (Fase 5.3).** A automação por
tag (`lead_qualificado`, `compra_aprovada`) pode chamar **uma URL por
evento, válida para todos os números** em vez da URL de cada regra. O
número vem do campo opcional `channel.phone` do corpo (recomendado) ou,
sem ele, do único número com que o contato conversou nos últimos 30
dias; contato que falou com mais de um número fica sem atribuição.
Detalhes e modelo do corpo em [`url-unica.md`](url-unica.md).

## Uazapi, NOD API, WAHA e Z-API — por onde os gatilhos aparecem

As conexões desses provedores **não** aparecem sozinhas nos cards de
webhook de entrada (Umbler, Gupshup, Data Crazy e WhatsApp Cloud API): para Uazapi e WAHA, o produto cria a origem de gatilhos
automaticamente (`UazapiConversionBridgeService`) a partir da conexão
WhatsApp — uma conexão vira uma origem e um canal, de forma idempotente.

Consequências práticas, confirmadas no código:

- A ponte roda quando chega, pelo receiver da conexão, uma **mensagem
  enviada pelo próprio número conectado** (mensagem do atendente) ou uma
  **mudança de etiqueta** em uma conversa. Depois de registrar o receiver
  no painel da Uazapi, responda uma conversa pelo número conectado (ou
  aplique uma etiqueta): a origem então aparece em
  `/conversions` e você cria a **Nova regra** ali. Só uma
  mensagem recebida do cliente não basta para criar a origem.
- A ponte só funciona com as flags `INBOUND_*` ligadas (veja abaixo) —
  com elas desligadas, a avaliação de regras nem começa.
- Criar uma conexão inbound `uazapi` **na mão** é recusado de propósito:
  *"Conexoes UAZAPI sao criadas automaticamente a partir da instancia
  WhatsApp"*.
- **WAHA (GoWS)** tem a mesma ponte: o número aparece em `/conversions`
  assim que a conexão está ativa (ao abrir Conversões, ao clicar em
  **Testar** com a sessão `WORKING` ou na primeira mensagem do seu time).
  Ele entra nas regras de **frase** (e de catálogo) da equipe; etiquetas não
  existem na WAHA, então ela não oferece gatilho de etiqueta.
- **Z-API** está como **Em breve**: ainda não recebe lead de anúncio
  (CTWA) nem participa das regras de frase da equipe. Entra quando houver
  demanda. Para esse número, use a Uazapi ou a WAHA.
- **NOD API** ainda não tem receiver inbound (a rota responde `501`).

> ℹ️ No Hub, Z-API e NOD API aparecem como **Em breve**: não é possível
> criar conexões novas; as já existentes continuam gerenciáveis. A Z-API
> ainda não tem parser compatível com o payload real, então não receba
> leads por ela por enquanto. A WAHA (GoWS) já cria conexões novas.

## Gatilhos de conversão exigem as envs `INBOUND_*`

Vale para as origens que usam gatilhos (Uazapi, NOD API, WAHA, Z-API,
Umbler, Gupshup e Meta Cloud). O padrão de todas elas é **desligado**, então
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
- **Em breve no Hub:** não é possível criar conexões novas; as já existentes continuam gerenciáveis.

### WAHA com motor GoWS (`waha`, servidor do aluno)

A WAHA é **sua**: você hospeda o servidor
([WAHA](https://waha.devlike.pro/)), cria a sessão e lê o QR **no painel da
sua WAHA**. O RastrackDash não tem servidor WAHA, não cria sessão e não
mostra QR. Por enquanto só o motor **GOWS** é lido; outro motor (NOWEB,
WEBJS) só se algum aluno pedir.

**1. No painel da sua WAHA**

- Suba o servidor com o motor GOWS e anote a **URL do servidor** (a que a
  API do RastrackDash alcança) e a **API key** (`WAHA_API_KEY` do seu
  servidor).
- Crie a **sessão** (o nome é livre, ex.: `cliente-loja`) e leia o QR com
  o celular do número. A sessão precisa ficar em **WORKING**.

**2. No RastrackDash** (`/integrations` → aba **WhatsApp** → WAHA)

| Campo | O que informar |
| --- | --- |
| Nome / Nome exibido | Livre (a exclusão pede o nome de volta) |
| URL da API | URL do seu servidor WAHA, sem `/api` no fim (ex.: `https://waha.seudominio.com`) |
| API key | A API key do seu servidor WAHA (fica criptografada; nunca volta para a tela) |
| Sessão | **Obrigatória.** O nome exato da sessão criada no painel |

Depois de salvar, **Testar conexão** consulta `GET /api/sessions/{sessão}` na
sua WAHA e mostra o status: `WORKING` = conectada; `SCAN_QR_CODE` = leia o QR
no painel da WAHA; `STARTING` = subindo; `STOPPED` = sessão parada;
`FAILED` = erro na sessão. Uma sessão com outro motor aparece como erro
(“use GOWS”).

**3. Webhook da sessão** — dois caminhos:

- **Automático** (`POST /integrations/whatsapp-connections/:id/configure-webhook`):
  o app gera um token novo, lê a configuração da sessão e grava, pela API da
  sua WAHA (`PUT /api/sessions/{sessão}`), um webhook para
  `{API_PUBLIC_URL}/webhooks/whatsapp/{ID_DA_CONEXAO}` com os eventos
  `message`, `message.any` e `session.status` e o token no cabeçalho
  `X-Wpptrack-Webhook-Token`. O resto da configuração da sessão (proxy,
  metadados, outros webhooks) é preservado. **Salvar reinicia a sessão na
  WAHA**: ela volta em alguns segundos, sem novo QR, e mensagens podem atrasar
  nesse intervalo — por isso o botão **Configurar webhook** pede confirmação
  antes. O app espera até 30 s por esse salvamento; se o prazo estourar ou a
  WAHA responder erro 5xx, ele relê a sessão e só considera configurado se o
  webhook com o token novo estiver lá. Se a WAHA recusar (sessão inexistente,
  API key errada, servidor fora do ar, outro motor), **nada muda** no app e o
  token anterior continua valendo. Se a configuração da sessão vier com
  **senhas mascaradas** (`***` na senha do proxy, no `hmac.key` ou nos
  cabeçalhos de outro webhook), o app **não grava nada** — gravar de volta
  trocaria o segredo real pelos asteriscos — e pede a configuração manual.
  A tela mostra os eventos assinados ou o motivo da recusa e oferece a
  configuração manual.
- **Manual**: o botão **Configuração manual** pede confirmação (gerar um novo
  token faz o webhook atual deixar de valer) e mostra uma única vez a URL, o
  token, o cabeçalho e os eventos. No painel da WAHA, em *Webhooks* da sessão:
  1. cole a **URL** (sem token);
  2. adicione o cabeçalho **`X-Wpptrack-Webhook-Token`** com o **token**
     (opção recomendada);
  3. marque os eventos `message`, `message.any` e `session.status`.

  Alternativa, só se a sua WAHA não aceitar cabeçalho: a URL com `?token=`.
  Ela funciona, mas o token pode aparecer nos logs da WAHA e do proxy.
  Gerar de novo invalida o token anterior. HMAC da WAHA fica fora por enquanto.

**4. O que acontece com cada mensagem** (parser `waha` v2)

| Chegou | Resultado |
| --- | --- |
| Clique em anúncio com `ctwa_clid` (`externalAdReply.ctwaClid`), inclusive quando a 1ª mensagem é foto, vídeo, áudio, temporária ou de visualização única | Lead de anúncio + `LeadSubmitted` à Meta, como nos outros provedores |
| Anúncio só com `sourceID`, sem `ctwa_clid` (anúncios no **Status** do WhatsApp: a Meta não manda o clid; cerca de 22% dos cliques) | **Cria lead de anúncio**, como o Rastrackapp: o lead guarda o ID do anúncio (campanha e conjunto vêm do anúncio sincronizado) e a `sourceURL`. **Nenhum evento vai à Meta**: o `LeadSubmitted` e as regras exigem `ctwa_clid`, e o `ctwaPayload` nunca é usado no lugar dele (a Meta o rejeita, erro 2804087). Se depois chegar um clique com clid do mesmo contato, o mesmo lead recebe o clid e o `LeadSubmitted` |
| Mensagem orgânica | Registrada; não cria lead (igual à Uazapi) |
| Mensagem do seu time (`message.any`, `fromMe`) | Registrada como `ignored_outbound` (nunca cria lead) e **avaliada contra as regras de frase da equipe**, no mesmo caminho da Uazapi: a frase casa por "contém", sem diferenciar maiúsculas; o lead é achado pelo telefone do contato (`RecipientAlt`, `to` ou `Chat`; 12 ou 13 dígitos, com ou sem o nono dígito). Contato só com LID: o app consulta a sua WAHA para achar o telefone; sem resposta, nada roda. Mensagem sem texto (foto sem legenda, áudio, figurinha) não roda regra. Veja [Regras de frase da equipe na WAHA](#regras-de-frase-da-equipe-na-waha) |
| Cópia `message.any` de mensagem recebida | Descartada (a recebida já veio por `message`; nada conta duas vezes) |
| Grupo, Status (`status@broadcast`), lista de transmissão, canal | Descartados |
| Clique em anúncio com contato só por LID (sem `SenderAlt`) | O app consulta a sua WAHA (`GET /api/{sessão}/lids/{lid}`, prazo de 3 s): com o telefone, segue como clique com clid (lead + `LeadSubmitted`). Sem resposta útil, fica registrado como `ctwa_contact_phone_unresolved` com o ID do anúncio (a métrica não se perde), sem lead |
| Mensagem orgânica só com LID | Registrada como `contact_phone_unresolved`; não consulta a WAHA. O LID **nunca** vira telefone |
| `session.status` | Atualiza o status da conexão (o mesmo do **Testar**), só se for mais novo que o último status registrado (retentativas fora de ordem não voltam o status) |

O telefone do contato vem do JID de telefone ou de `SenderAlt` (recebida) /
`RecipientAlt` (enviada pelo time), sem o sufixo de aparelho `:NN`; o
número da própria loja nunca vira contato. O lead continua identificado pelo
telefone: o mesmo contato chegando por `@lid` ou por telefone cai no mesmo
lead. Sem `payload.fromMe` booleano, vale o `Info.IsFromMe` do GoWS (um texto
como `"false"` nunca é aceito); sem hora na mensagem, vale a hora do envelope
da WAHA. JIDs `@hosted`/`@hosted.lid` não são lidos (o Rastrackapp também
não os trata). O log do webhook guarda só um resumo estrutural (sem texto, nome, LID,
telefone, clid ou miniatura).

**5. Versão do parser.** O receptor usa o parser `waha` v2 enquanto a release
`waha`/`v2` estiver **certificada** (a migration
`20261022130100_waha_parser_release` já a cria certificada). Sem essa
release, ou com ela em observação/retirada, o receptor volta ao v1, que não
lê anúncios do GoWS.

**6. Regras de frase da equipe na WAHA**

<a id="regras-de-frase-da-equipe-na-waha"></a>
Quando alguém do seu time digita, pelo número da WAHA, a frase de uma regra
(ex.: "pagamento confirmado"), a conversão vai à Meta como na Uazapi:
mesma ponte, mesma decisão (congelada por mensagem), mesma execução e mesmo
envio. Só vale para contato que chegou por anúncio (lead com `ctwa_clid`);
sem lead de anúncio, nada é enviado, igual à Uazapi.

- **Criar ou editar a regra:** em `/conversions`, **Nova regra** → **Frase na
  conversa**. Em **Alcance**, "Todos os números" já inclui os números da WAHA;
  em "Números específicos", marque o número da WAHA. Regras antigas também
  funcionam: uma regra "Todos os números" passa a valer para a WAHA sem
  edição. Uma regra presa a uma conexão Uazapi antiga não vale para a WAHA;
  nesse caso, crie (ou edite) a regra de frase com a origem WAHA.
- **Envio automático:** salvar uma regra em envio automático ativa os números
  dela, inclusive os da WAHA; um número da WAHA conectado depois é ativado
  sozinho em até alguns minutos. Se algum número ficar pendente, use
  **Ativar envio neste número** na própria regra. Conexão pausada continua
  pausada até você retomá-la em Integrações.
- **Mensagens antigas bloqueadas:** conversas que chegaram antes de o número
  enviar ficam bloqueadas (`connection_not_production`). Depois de ativar,
  use **Reprocessar bloqueadas** na regra: só reenvia o que está dentro da
  janela de 7 dias da Meta, uma vez só.
- **Sem duplicar:** a mesma mensagem nunca gera duas conversões (a cópia
  `message` da mensagem do time é descartada, a reentrega do webhook é
  reconhecida e, com regra específica no número, a regra "Todos os números"
  não roda ali).
- **Trocou o número da Uazapi para a WAHA?** Exclua a conexão Uazapi antiga
  em Integrações. Se ela ficar ativa, a regra "Todos os números" usa o número
  que continua recebendo mensagens (a WAHA), mas a conexão antiga só confunde
  a lista de números.
- **Etiquetas** não existem na WAHA: a origem "Etiqueta no WhatsApp" continua
  só na Uazapi.

**Ainda não suportado:** grupos, Status, etiquetas, HMAC e outros motores
além do GOWS. Env de fallback (`WAHA_BASE_URL`, `WAHA_API_KEY`,
`WAHA_SESSION`) vale só para o **Testar**; a configuração automática do
webhook usa somente o que está salvo na conexão.
- **No Hub:** a WAHA está liberada para novas conexões (entrada de lead de anúncio) e, em Conversões, entra nas **regras de frase** da equipe.

### Z-API (`zapi`)

- Você roda ou assina sua própria instância [Z-API](https://www.z-api.io/).
- Credenciais na UI: URL da API, Instance ID e Token. Env de fallback:
  `ZAPI_BASE_URL`, `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`.
- **Em breve:** o parser ainda não lê o payload real da Z-API, então ela
  não entrega lead de anúncio (CTWA) nem regras de frase da equipe. Será
  priorizada quando houver demanda.
- **Em breve no Hub:** não é possível criar conexões novas; as já existentes continuam gerenciáveis.

### Data Crazy (`data_crazy`)

- É uma conexão de webhook de entrada por workspace, criada em
  `/integrations`; não há adapter de instância, número comercial no payload
  ou variável de ambiente própria.
- Cole a URL gerada, com `?token=`, em uma automação HTTP de **mensagem
  recebida** do Data Crazy. O canal só aparece depois do primeiro webhook;
  não tente cadastrar um canal provisório.
- O parser Data Crazy v1 converte somente inbound com CTWA em lead. Depois
  de observar uma entrega CTWA real, certifique o parser no backoffice antes
  de ativar produção.
- Palavra-chave, tag e outros gatilhos de automação do Data Crazy não fazem
  parte deste parser v1.

### Zap Responder

**Ainda não implementado neste código.** Não há contrato para este
provedor; não invente variáveis de ambiente para ele.

## Onde cada credencial vem

| Provedor | Onde o aluno encontra a credencial |
|---|---|
| Uazapi BYO | Painel da própria instância Uazapi |
| NOD API | Instance ID/token do add-on PalmUP; o broker usa a `LICENSE_KEY` já configurada |
| WAHA | Painel da sua WAHA (motor GOWS): URL do servidor, API key e nome da sessão |
| Z-API | Painel da conta Z-API do aluno |
| Umbler / Gupshup | Painel de cada serviço — lá você cola a URL de callback (com `?token=`) gerada aqui |
| Data Crazy | Automação HTTP de mensagem recebida — lá você cola a URL de callback (com `?token=`) gerada aqui |
| Meta WhatsApp (Cloud API) | App Meta → WhatsApp → Configurar webhooks; o `META_APP_SECRET` é o App Secret do mesmo app |
| Meta Ads | Gerenciador de Negócios (Meta Business Suite) — veja [`meta-manual.md`](meta-manual.md) |

## Referências

- [`environment.md`](environment.md) — tabela completa de variáveis.
- [`meta-manual.md`](meta-manual.md) — Meta **Ads** (usuário do sistema).
- [`troubleshooting.md`](troubleshooting.md) — sintomas de webhook não
  autorizado, handshake recusado e "Nova regra" que não aparece.
