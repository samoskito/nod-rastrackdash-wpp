# Formulários Meta (Lead Ads → etapa do CRM)

Recebe os leads dos **formulários instantâneos** da Meta e, quando alguém marca
o lead como **Qualificado** na tela do lead, envia a etapa para a Meta pela
**Conversions API for CRM** (`action_source: system_generated`,
`user_data.lead_id`). É o mesmo fluxo do antigo Dashboard Leads.

- Um lead do RastrackDash é **uma pessoa por telefone**. Se a pessoa preencheu o
  formulário e também conversou no WhatsApp, os dois caem no **mesmo lead**,
  inclusive com ou sem o nono dígito. A atribuição do WhatsApp é mantida.
- Cada envio de formulário fica guardado com o seu ID da Meta. O evento de CRM
  usa o envio **mais recente** do lead.
- O `event_id` é `{lead_id}:{evento}`, o mesmo formato do Dashboard Leads. Se o
  Dashboard Leads já enviou aquele lead, a Meta descarta a duplicata.

## Onde fica

`/integrations` → aba **Anúncios** → card **Meta** → seção **Formulários Meta**.
Quem pode gerenciar integrações (owner ou admin) cadastra, pausa, assina a
página e remove conexões.

## Antes de começar

Não há variável nova. A API usa as que já existem:

| Variável | Uso |
| --- | --- |
| `META_APP_SECRET` | Confere a assinatura `X-Hub-Signature-256` do webhook e gera o `appsecret_proof` das leituras na Graph API. |
| `META_WEBHOOK_VERIFY_TOKEN` | Token de verificação ao salvar a URL de callback no app Meta. |
| `META_TOKEN_ENCRYPTION_KEY` | Cifra os tokens da conexão (AES-256-GCM). |
| `API_PUBLIC_URL` | Monta a URL do webhook mostrada no painel. |

## Passo a passo

1. **App Meta → Webhooks → objeto Page**: URL de callback
   `{API_PUBLIC_URL}/webhooks/meta`, token = `META_WEBHOOK_VERIFY_TOKEN`, e
   assine o campo **`leadgen`**.
2. **Token Graph**: token de **System User** do mesmo app, com acesso de
   administrador à Página e as permissões `leads_retrieval`,
   `pages_manage_metadata` e `pages_show_list`.
3. **Dataset do CRM**: no Gerenciador de Eventos, o dataset da integração
   "CRM" (não o pixel do site nem o de mensagens). O **token do dataset**
   (gerado dentro do dataset) é opcional: sem ele, o envio usa o token Graph.
4. No painel, preencha **Nome**, **ID da Página**, **Dataset CRM**, **Evento ao
   qualificar** (padrão `LeadQualificado`; `Lead` e `LeadSubmitted` são
   recusados, porque a Meta já recebe o lead) e os tokens. **IDs dos
   formulários** só são necessários quando a mesma Página atende mais de uma
   conexão: vazio quer dizer todos os formulários não reservados por outra.
5. Clique em **Assinar Página**. Isso faz `POST /{page}/subscribed_apps` com
   `leadgen`.
6. Teste com a [ferramenta de teste de leads](https://developers.facebook.com/tools/lead-ads-testing).
   O lead aparece em `/leads` com a origem **Formulário Meta**.

## Regras de envio

- A Meta só aceita lead com **até 28 dias**. Acima disso, o evento fica como
  "não elegível", com o motivo.
- `event_time` é o momento da qualificação. Num reenvio com mais de 6 dias, o
  envio usa a hora atual.
- Falha de rede ou configuração faltando (dataset, conexão pausada) pode ser
  reenviada pela auditoria de eventos. Recusa da Meta não é reenviada
  automaticamente.
- Se a leitura do lead na Graph API falhar (token expirado, por exemplo), o
  envio fica como `fetch_failed` e é lido de novo quando a Meta reentregar o
  mesmo lead.
- Uma Página **sem** conexão ativa continua no comportamento anterior do
  webhook Meta (só log de diagnóstico).
