# Migração do Dashboard Leads

Fase 6.9 (PR #92 do nod). Roteiro **opcional**, só para quem usava o Dashboard Leads (Next.js +
Supabase) e quer trazer os clientes para o RastrackDash: configuração, importação do histórico e
virada dos webhooks. As fontes cobertas são o **formulário Meta** (Lead Ads) e o **WhatsApp CTWA**. A
landing page (fonte `web`) não é importada. Quem nunca usou o Dashboard Leads não precisa fazer nada.

## 1. Configurar cada cliente

No Dashboard Leads, as empresas eram abas de um mesmo login. Aqui cada empresa é um workspace, e um
mesmo login pode ter várias. Quando o login tem mais de uma, o quadro **Workspace** do menu lateral
vira o seletor **Selecionar empresa**, e cada tela mostra só a empresa escolhida, sem misturar números.

A importação (passo 2) pode criar essas empresas sozinha com `--create-workspaces`: uma por projeto
**ativo** do Dashboard Leads, todas do mesmo login de cliente. Não é preciso criar uma por uma no
backoffice.

Os tokens são cadastrados pela interface, em cada empresa, que os guarda cifrados. **Nunca copie o
`.env.local` do Dashboard Leads para o repositório.**

| No Dashboard Leads | No RastrackDash |
| --- | --- |
| `projects.meta_page_id`, `form_ids`, `crm_dataset_id`, `qualified_event_name`, token `token_ref` e `capi_token_ref` | `/integrations` → Anúncios → Meta → **Formulários Meta** ([guia](meta-lead-forms.md)) |
| `wa_phone_number_id` e o número da WABA | `/integrations` → WhatsApp → **WhatsApp Cloud API** ([guia](whatsapp-providers.md)) |
| `wa_dataset_id` + página, com o token `wa_capi_token_ref` | Destino de conversão Meta (pixel/dataset + página) e token CAPI ([guia](meta-manual.md)) |
| `meta_ad_account_id` | Contas para relatórios (o Dashboard Leads não tinha relatórios) |

O token gerado **dentro do dataset** funciona sem `appsecret_proof`, como no Dashboard Leads.

## 2. Importar o histórico

Sem conexão de formulário para a Página, o lead entra, mas os dados do formulário e a etapa de CRM já
enviada não entram. Depois de criar a conexão, rode a importação de novo: ela completa o que faltou sem
duplicar.

Rode o comando numa cópia do repositório com dependências instaladas e com acesso ao PostgreSQL da
instalação (a mesma `DATABASE_URL` da API, definida só no terminal; nunca em chat). PENDENTE: o
passo a passo para rodar dentro do container da API no Dokploy ainda não foi conferido.

```bash
pnpm --filter @wpptrack/api build
SUPABASE_URL=https://<projeto>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<chave de serviço> \
pnpm --filter @wpptrack/api dashboard-leads:import -- \
  --create-workspaces \
  --owner-email <login de cliente> \
  --actor-email <login de plataforma>
```

- **Simula por padrão.** O relatório mostra as empresas que seriam criadas (`workspacesCreated`) ou
  reaproveitadas (`workspacesReused`) e, por projeto, quantos leads entram, quantas pessoas são
  criadas ou unidas a um lead existente, quantos envios de formulário, quantos eventos já enviados e o
  que fica de fora. Confira as contagens com o Supabase e rode de novo com `--apply`.
- **Licença:** com a licença bloqueada, `--apply` é recusado (como as escritas do painel, que
  respondem 423). A simulação continua funcionando.
- `--owner-email` é o login de **cliente** já ativado que vai ver as empresas. Um login de plataforma
  não pode ser responsável de cliente (mesma regra da tela do backoffice). `--actor-email` é o login
  de **plataforma** (Platform Owner) registrado na auditoria.
- Cada empresa nova recebe o nome e o `slug` do projeto no Dashboard Leads. Numa nova execução, a
  empresa com o mesmo `slug` desse dono é reaproveitada. Se o `slug` já pertence a outro dono, o
  comando para e pede um `--map`.
- Projetos inativos ficam de fora (`skippedInactiveProjects`).
- `--map slug=<workspaceId>` manda um projeto para um workspace que já existe e tem prioridade sobre a
  criação. Sem `--create-workspaces`, todo projeto precisa de um `--map`; os que não têm aparecem em
  `unmappedProjects`.
- `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` vão **só na linha do comando**: não coloque no `.env`,
  no Dokploy nem em arquivo do repositório, e não cole a chave em chat (veja
  [`environment.md`](environment.md#formulários-meta-lead-ads-e-importação-do-dashboard-leads-fase-69)).
- O comando pode rodar quantas vezes for preciso: pessoas por telefone (com as variantes do nono
  dígito), envios de formulário pelo ID da Meta e eventos pela chave de dedupe.

O que acontece com cada lead:

- **Status:** `novo`→`new`, `contatado`→`active`, `qualificado`→`qualified`, `descartado`→`lost`. O
  status só avança: um lead já qualificado no RastrackDash não volta.
- **Já enviado à Meta** (`sent_to_meta`): vira um evento **Importado**, com a mesma chave que o
  RastrackDash usaria, e **nada é reenviado**:
  - formulário com conexão: a etapa de CRM (`{lead_id}:{evento enviado}`); se o evento da conexão é o
    mesmo que o Dashboard Leads enviou, registrar Lead qualificado de novo não reenvia a etapa. O card
    desse lead não muda de coluna no **CRM** (a etapa do formulário é de outro dataset);
  - WhatsApp: uma conversão manual importada (`QualifiedLead` ou `LeadSubmitted`, com o mesmo
    identificador de evento que uma regra ou um registro manual desse lead usaria). Ela conta na trava
    de "uma conversão por lead" para **todos** os pixels do workspace (o Dashboard Leads não diz para
    qual pixel enviou): nem a automação nem um novo registro manual mandam o evento de novo, e o lead
    aparece na coluna certa do **CRM**. Um evento do WhatsApp com outro nome não é importado
    e o relatório conta (`eventsNotImported`).
- **Qualificado mas não enviado** (`qualifiedNotSent`): não gera evento. Para enviar, registre **Lead
  qualificado** na tela do lead (conversão manual) ou arraste o card no **CRM**.
- **Observações** (`notes`): o RastrackDash não tem esse campo. O relatório conta quantas ficaram de
  fora (`notesNotImported`).

## 3. Virada

1. No app Meta, aponte o webhook do objeto **Page** (`leadgen`) e o do **WhatsApp** para a API do
   RastrackDash. Com um mesmo app Meta só existe uma URL de callback, então a virada é imediata. Para
   formulários, o `event_id` de CRM tem o mesmo formato do Dashboard Leads, e a Meta descarta um envio
   duplicado.
2. Por cliente, envie um lead pela [ferramenta de leads da Meta](https://developers.facebook.com/tools/lead-ads-testing)
   e confira que ele aparece em `/leads` com a origem **Formulário Meta**. O painel não tem botão de
   evento de teste (`test_event_code`) para a etapa de CRM; confira a etapa no Gerenciador de Eventos
   com um lead real qualificado.
3. Rode a importação de novo, com `--apply`, logo depois da virada, para pegar o que entrou no
   Dashboard Leads no meio-tempo.
4. Deixe o Dashboard Leads só para consulta por cerca de duas semanas e depois desligue o projeto na
   Vercel.

## Pendências conhecidas

- PENDENTE: a importação só rodou numa instalação de teste (nunca num aluno real) e antes da
  adaptação das chaves ao RastrackDash atual; com as chaves novas, só os testes automatizados.
