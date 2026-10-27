# Formulários Meta (Lead Ads → etapa do CRM)

Fase 6.9 (PR #91 do nod). Recebe os leads dos **formulários instantâneos** da Meta e, quando alguém
registra **Lead qualificado** nesse lead (pela conversão manual na tela do lead ou arrastando o card
no **CRM**), envia a etapa para a Meta pela **Conversions API for CRM**
(`action_source: system_generated`, `user_data.lead_id`). É o mesmo fluxo do antigo Dashboard Leads.

- Um lead do RastrackDash é **uma pessoa por telefone**. Se a pessoa preencheu o formulário e também
  conversou no WhatsApp, os dois caem no **mesmo lead**, com ou sem o nono dígito. A atribuição do
  WhatsApp é mantida.
- Cada envio de formulário fica guardado com o seu ID da Meta. A etapa de CRM usa o envio **mais
  recente** do lead.
- O `event_id` da etapa é `{lead_id}:{evento}`, o mesmo formato do Dashboard Leads. Se o Dashboard
  Leads já enviou aquele lead, a Meta descarta a duplicata.
- A conexão nasce **ativa**: não há passo de liberar nem de testar. A única ação depois de cadastrar
  é **Assinar Página** (a inscrição do seu app Meta na Página, que a própria Meta exige).

## Onde fica

`/integrations` → aba **Anúncios** → card **Meta** → seção **Formulários Meta**. Quem pode gerenciar
integrações (owner ou admin) cadastra, edita (dataset, evento e tokens, em **Editar**), pausa,
retoma, assina a Página e remove conexões. Uma Página só pode estar conectada em **um** workspace da
instalação. Remover a conexão apaga os envios de formulário dela e as etapas ainda não enviadas não
saem mais: para trocar token ou dataset, use **Editar**. Com a
licença bloqueada, a seção continua mostrando as conexões, mas criar, alterar, assinar e remover
respondem 423 (o webhook da Meta também é recusado até a licença voltar).

## Antes de começar

- Atualize a instalação ([`update.md`](update.md)). Esta atualização tem migration
  (`20261027145000_meta_lead_forms`, aditiva): **faça o backup do PostgreSQL antes**.
- Não há variável nova. A API usa as que já existem (detalhes em
  [`environment.md`](environment.md#formulários-meta-lead-ads-e-importação-do-dashboard-leads-fase-69)):

| Variável | Uso |
| --- | --- |
| `META_APP_SECRET` | Confere a assinatura `X-Hub-Signature-256` do webhook e gera o `appsecret_proof` das leituras na Graph API. **Sem ela, nenhum lead de formulário entra.** |
| `META_WEBHOOK_VERIFY_TOKEN` | Token de verificação ao salvar a URL de callback no app Meta. |
| `META_TOKEN_ENCRYPTION_KEY` | Cifra os tokens da conexão (AES-256-GCM). |
| `API_PUBLIC_URL` | Monta a URL do webhook mostrada no painel. |

## Passo a passo

1. **App Meta → Webhooks → objeto Page**: URL de callback `{API_PUBLIC_URL}/webhooks/meta`, token =
   `META_WEBHOOK_VERIFY_TOKEN`, e assine o campo **`leadgen`**.
2. **Token Graph**: token de **System User** do mesmo app, com acesso de administrador à Página e as
   permissões `leads_retrieval`, `pages_manage_metadata` e `pages_show_list`.
3. **Dataset do CRM**: no Gerenciador de Eventos, o dataset da integração "CRM" (não o pixel do site
   nem o de mensagens). O **token do dataset** (gerado dentro do dataset) é opcional: sem ele, o envio
   usa o token Graph.
4. No painel, preencha **Nome**, **ID da Página**, **Dataset do CRM**, **Evento ao qualificar**
   (padrão `LeadQualificado`; `Lead` e `LeadSubmitted` são recusados, porque a Meta já recebe o lead)
   e os tokens. **IDs dos formulários** só são necessários quando a mesma Página atende mais de uma
   conexão: vazio quer dizer todos os formulários não reservados por outra.
5. Clique em **Assinar Página**. Isso faz `POST /{page}/subscribed_apps` com `leadgen`.
6. Confira com a [ferramenta de leads da Meta](https://developers.facebook.com/tools/lead-ads-testing):
   o lead aparece em `/leads` com a origem **Formulário Meta**.

## Como a etapa do CRM é enviada

- Abra o lead e clique em **Registrar conversão manual** → **Lead qualificado**, ou arraste o card
  para a coluna **Lead qualificado** no **CRM**. A confirmação mostra a linha **Formulário Meta
  (CRM)**: se a etapa vai para o dataset ou por que não vai.
- Se o lead também tem conversa de WhatsApp vinda de anúncio, o **Lead qualificado** do WhatsApp vai
  para o pixel de mensagens, como sempre, e a etapa do formulário vai para o dataset do CRM: são dois
  destinos diferentes, um evento em cada.
- Marcar **Registrar só no painel (não enviar à Meta)** na conversão manual também não envia a etapa
  do formulário.
- A etapa de um mesmo envio de formulário é registrada **uma vez só**. Se o lead já estava
  qualificado por uma regra (frase, automação), a confirmação mostra "Lead já convertido" e o botão
  **Enviar só a etapa do formulário**: a etapa vai uma vez para o dataset do CRM (outro destino) e o
  evento do WhatsApp não é repetido.
- No lead, o evento aparece com a origem **Formulário Meta (CRM)**.

## Regras de envio

- A Meta só aceita lead com **até 28 dias**. Acima disso, a etapa fica como "não elegível", com o
  motivo.
- `event_time` é o momento da qualificação. Num reenvio com mais de 6 dias, o envio usa a hora atual.
- Configuração faltando (dataset, conexão pausada, token ilegível) e falha de login da Meta (código
  190 ou 102, nos últimos 7 dias) aparecem em **Eventos Meta** e são reenviadas por **Reenviar
  bloqueados** depois de corrigir em **Editar**. Outras recusas da Meta não são reenviadas
  automaticamente.
- Se a leitura do lead na Graph API falhar (token expirado, por exemplo), o envio fica como
  `fetch_failed` e o webhook responde 503, então a Meta reentrega e o lead é lido de novo. Corrija o
  token em **Editar**; se a Meta desistir de reentregar, o lead não entra (PENDENTE: não há botão
  "Ler de novo").
- Os dados que a pessoa preencheu no formulário (nome, e-mail, telefone e respostas) ficam guardados
  no banco da sua instalação, como os leads do WhatsApp; trate-os como dados pessoais do cliente.
- Uma Página **sem** conexão ativa continua no comportamento anterior do webhook Meta (só log de
  diagnóstico).

## Pendências conhecidas

- PENDENTE: o webhook `leadgen` real, a leitura real na Graph API, o **Assinar Página** real e o
  envio real ao dataset do CRM ainda não foram feitos numa instalação do nod.

## Recuperação

Voltar o código não desfaz a migration: as tabelas `MetaLeadFormConnection` e `MetaLeadSubmission`
ficam no banco e são ignoradas pela versão anterior (não apague). Na versão anterior, a seção some e
o webhook `leadgen` volta a ser só um log de diagnóstico; os leads já criados continuam. Para parar de
receber leads sem voltar o código, clique em **Pausar** na conexão. Só restaure o backup do PostgreSQL
com orientação.
