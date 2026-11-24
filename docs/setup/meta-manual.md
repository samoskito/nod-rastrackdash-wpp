# Meta Ads manual — usuário do sistema (edição aluno)

Este guia é sobre a conexão de **Meta Ads**: anúncios, Pixel, conta de
anúncios e destino de conversão, pelo **token permanente** do usuário do
sistema. Não há o OAuth antigo (app Meta próprio) como alternativa. A outra
forma suportada é o botão **Conectar Meta (PalmUP)**, que dispensa criar app
Meta próprio — veja [`environment.md`](environment.md#palmup_meta_broker_url--login-social-meta-pela-palmup).
Antes de abrir
a Meta, defina `META_CONNECTION_MODES=manual` no ambiente da API e faça
redeploy. Se as capabilities não carregarem, a tela deve permanecer
fechada; não tente contornar isso com OAuth.

## ⚠️ Não confunda: são duas integrações Meta diferentes

| | **Meta Ads** (este guia) | **Meta WhatsApp (Cloud API)** |
|---|---|---|
| O que entrega | Anúncios, Pixel, Página, conta de anúncios, destino de conversão | **Mensagens** recebidas pelo seu número oficial, com atribuição de CTWA |
| Onde se configura | `/integrations` → aba **Anúncios** → card **Meta Ads** | `/integrations` → aba **WhatsApp** → card **WhatsApp Cloud API** |
| Credencial | Token de **usuário do sistema** do Gerenciador de Negócios | **Verify token** gerado pelo produto + (opcional) `META_APP_SECRET` |
| Webhook | `GET`/`POST /webhooks/meta`, com `META_WEBHOOK_VERIFY_TOKEN` | `GET`/`POST /webhooks/inbound/:id` |

Fazer um **não** dispensa o outro: o Meta Ads é quem recebe a conversão
enviada; o Meta WhatsApp (Cloud API) é quem traz a mensagem CTWA que
origina essa conversão. O passo a passo do webhook de mensagens está em
[`whatsapp-providers.md`](whatsapp-providers.md#meta-whatsapp-cloud-api--atribuição-de-ctwa-não-gatilho-de-atendente)
— inclusive o aviso de que ele **não** serve para gatilhos por
palavra-chave/tag do atendente.

O handshake do webhook de **Meta Ads** usa `META_WEBHOOK_VERIFY_TOKEN` e o roteamento dos eventos é por `page_id` até o workspace certo — contrato confirmado em [`whatsapp-providers.md`](whatsapp-providers.md#matriz-de-ingestão-inbound-o-que-realmente-chega-hoje), junto com o dos demais provedores.

## Pré-requisitos

- Conta do Gerenciador de Negócios (BM) do **cliente final** ou da agência, com acesso ao App, Pixel, Página do Facebook e conta de anúncios corretos
- Permissão para criar usuário do sistema e gerar token; App ID configurado na API quando o seu fluxo o exigir
- Instância RastrackDash no ar, licença utilizável, administrador já validado em `/backoffice/clients` e workspace selecionado

## Passos

1. No Meta Business Suite, abra **Configurações do negócio** → **Usuários** → **Usuários do sistema** e crie (ou reutilize) um usuário do sistema limitado ao BM correto.
2. Atribua ao usuário somente os ativos necessários: BM, conta de anúncios, Pixel e Página do Facebook que serão usados pelo workspace. Confirme que a conta de anúncios está ativa.
3. Gere um token de usuário do sistema com as permissões exigidas pela operação, incluindo `ads_read` e `business_management`; use as permissões adicionais apenas quando a UI/fluxo Meta pedir. Prefira token permanente de usuário do sistema quando sua política Meta permitir, em vez de token pessoal.
4. No RastrackDash, abra **Integrações** no workspace correto e escolha a conexão manual. Informe o App ID e cole o token somente no formulário da instância; ele fica no backend, nunca em `NEXT_PUBLIC_*`, `.env` público, Git ou chat.
5. Teste/salve a conexão e faça a descoberta dos ativos. Se a validação falhar, corrija permissões, BM ou token na Meta antes de seguir.
6. Selecione explicitamente o BM, a conta de anúncios para relatórios, o Pixel e a Página que receberão a conversão. Salve o destino e valide a seleção no workspace.

Para a **rota de mensagens Meta Cloud**, a opção **qualquer conta do BM**
permite uma única rota para várias contas. Cada conta ainda precisa ter
autorização própria para o destino; o destino padrão do BM não concede esse
acesso. Conta/destino opcionais são resolvidos pelo anúncio, sem ignorar
atribuições ambíguas. Veja [ativação e limites de recuperação de CTWA](whatsapp-providers.md#rota-com-qualquer-conta-do-bm-e-ativação-do-meta-cloud).

## Conta de anúncios compartilhada por um cliente (parceiro)

A lista de contas do BM traz as contas **próprias** e as que clientes
**compartilharam com o seu BM como parceiro**. Se a conta do cliente não
aparece ou a sincronização dela falha por permissão: no Gerenciador de Negócios
da **agência**, atribua a essa conta a pessoa (ou o usuário do sistema) dona do
token. Compartilhar com o BM não basta sem essa atribuição.

## Aviso "Leads bloqueados por falta de rota Meta"

Em **Integrações → Meta Ads**, o painel avisa quando uma conta de anúncios que
recebeu leads (ou teve eventos bloqueados) nos últimos 7 dias está sem rota:
conta desativada, sem BM, BM pausada ou sem destino configurado. O aviso mostra
campanha, quantidade de leads, conta e motivo. Corrija ativando a conta e
vinculando um destino; se houver eventos bloqueados, use depois **Reenviar
bloqueados** em **Eventos Meta**. Uma conta desativada bloqueia os envios dela
mesmo com o roteamento por BM desligado.

Quando a tela mostra o botão **Desativar** de uma conta de relatórios e a
desativação passaria a bloquear leads, aparece uma confirmação com a
simulação. A ação continua permitida. O aviso e a simulação são só leitura:
não alteram nada e não leem tokens.

## Verificação

- `/integrations` (aba **Anúncios** → card **Meta Ads**) mostra a conexão manual Meta como conectada, os ativos descobertos e o destino (BM/Pixel/Página/conta) selecionado
- `GET /onboarding/status` → `metaConnected: true` (com workspace ativo)
- Relatórios/leads deixam de falhar por “meta not configured”

## Trocar token sem refazer a estrutura

Depois que a estrutura existe em **Integrações → Tokens, BMs e destinos**, o token é sempre trocado **no mesmo card**:

1. No card do BM, clique no ícone de **chave** (**Trocar token**).
2. Cole o token permanente e clique em **Validar troca**.

BM, conta de anúncios, pixel, página e destinos continuam os mesmos. Para trocar token, **não** use **+ Nova conexao** e **não** apague a estrutura (lixeira) — isso só faz você refazer a configuração toda.

**Acabou de atualizar a instância?** Faça o **Trocar token** uma vez, colando o **mesmo** token que você já usa. Nesta versão, todo envio de conversão (inclusive LeadSubmitted e Kommo) passou a usar esta estrutura; sem essa regravação, o LeadSubmitted fica **Bloqueado** mesmo com o card aparecendo como **Ativa**. É uma mudança do produto, não um erro seu. Detalhes em [`update.md`](update.md#conversões-meta-depois-desta-atualização-trocar-token).

## Segurança

- Rotacione o token se vazar, pelo **Trocar token** do mesmo card
- Não commite `.env` nem captures de tela com token
- Prefira um usuário do sistema limitado ao Gerenciador de Negócios do cliente, e não um token pessoal de longa duração sem necessidade
- Não envie App ID/token por chat e nunca use `***` como valor de token; `***` só redige valores em logs compartilhados
- `META_APP_SECRET` é o **App Secret** do app Meta, não este token permanente do Graph. Ele serve para validar a assinatura `x-hub-signature-256` dos webhooks — inclusive os do Meta WhatsApp (Cloud API). Um não substitui o outro
