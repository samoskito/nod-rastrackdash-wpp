# Migração do Dashboard Leads

Roteiro para trazer os clientes do Dashboard Leads (Next.js + Supabase) para o
RastrackDash: configuração, importação do histórico e virada dos webhooks. As
fontes cobertas são o **formulário Meta** (Lead Ads) e o **WhatsApp CTWA**. A
landing page (fonte `web`) não é importada.

## 1. Configurar cada cliente

Um workspace por projeto do Dashboard Leads. Os tokens são cadastrados pela
interface, que os guarda cifrados. **Nunca copie o `.env.local` do Dashboard
Leads para o repositório.**

| No Dashboard Leads | No RastrackDash |
| --- | --- |
| `projects.meta_page_id`, `form_ids`, `crm_dataset_id`, `qualified_event_name`, token `token_ref` e `capi_token_ref` | `/integrations` → Anúncios → Meta → **Formulários Meta** ([guia](meta-lead-forms.md)) |
| `wa_phone_number_id` e o número da WABA | `/integrations` → WhatsApp → **WhatsApp Cloud API** ([guia](whatsapp-providers.md)) |
| `wa_dataset_id` + página, com o token `wa_capi_token_ref` | Destino de conversão Meta (pixel/dataset + página) e token CAPI ([guia](meta-manual.md)) |
| `meta_ad_account_id` | Contas para relatórios (o Dashboard Leads não tinha relatórios) |

O token gerado **dentro do dataset** funciona sem `appsecret_proof`, como no
Dashboard Leads.

## 2. Importar o histórico

Rode **depois** de criar as conexões de formulário. Sem conexão para a Página,
o lead entra, mas o envio de formulário e o evento já enviado não entram.

```bash
pnpm --filter @wpptrack/api build
SUPABASE_URL=https://<projeto>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<chave de serviço> \
pnpm --filter @wpptrack/api dashboard-leads:import -- \
  --map locaville=<workspaceId> --map venerata=<workspaceId>
```

- **Dry-run por padrão.** O relatório mostra, por projeto, quantos leads entram,
  quantas pessoas são criadas ou unidas a um lead existente, quantos envios de
  formulário, quantos eventos já enviados e o que fica de fora. Confira as
  contagens com o Supabase e rode de novo com `--apply`.
- O `slug` é o de `projects.slug` no Dashboard Leads. Projetos sem `--map`
  aparecem em `unmappedProjects` e não são importados.
- Passe as credenciais do Supabase **só na linha de comando**.
- O script pode rodar quantas vezes for preciso: pessoas por telefone (com as
  variantes do nono dígito), envios de formulário pelo ID da Meta e eventos pela
  chave de dedupe.

O que acontece com cada lead:

- **Status:** `novo`→`new`, `contatado`→`active`, `qualificado`→`qualified`,
  `descartado`→`lost`. O status só avança: um lead já qualificado no
  RastrackDash não volta.
- **Já enviado à Meta** (`sent_to_meta`): vira um evento **Importado**, com a
  mesma chave que o botão Qualificado usaria. Clicar de novo responde "já
  registrado" e **nada é reenviado**.
- **Qualificado mas não enviado** (`qualifiedNotSent`): não gera evento. Para
  enviar, mude o status e marque Qualificado de novo na tela do lead.
- **Observações** (`notes`): o RastrackDash não tem esse campo. O relatório
  conta quantas ficaram de fora (`notesNotImported`).

## 3. Virada

1. Envie um evento de teste por cliente (`test_event_code`) e confira em
   **Testar eventos** no Gerenciador de Eventos.
2. No app Meta, aponte o webhook do objeto **Page** (`leadgen`) e o do
   **WhatsApp** para a API do RastrackDash. Com um mesmo app Meta só existe uma
   URL de callback, então a virada é imediata. Para formulários, o `event_id` de
   CRM tem o mesmo formato do Dashboard Leads, e a Meta descarta um envio
   duplicado.
3. Rode o import de novo, com `--apply`, logo depois da virada, para pegar o que
   entrou no Dashboard Leads no meio-tempo.
4. Deixe o Dashboard Leads só para consulta por cerca de duas semanas e depois
   desligue o projeto na Vercel.
