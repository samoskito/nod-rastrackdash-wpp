# Variáveis de ambiente

Referência completa das variáveis do `.env` da API (`apps/api`) e do web (`apps/web`), agrupadas por assunto. "Secreto" significa: nunca versione, nunca cole em chat, nunca exponha no frontend.

## Gerar segredos com segurança (`JWT_*`, `*_ENCRYPTION_KEY`, tokens de webhook)

Sempre que este documento disser "gere um valor" para um segredo
(`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `EXTERNAL_CONNECTOR_ENCRYPTION_KEY`,
`META_TOKEN_ENCRYPTION_KEY`, `UAZAPI_WEBHOOK_AUTH_TOKEN`, etc.), use um
gerador criptograficamente seguro — nunca invente o valor de cabeça nem
use algo previsível.

**macOS/Linux:**

```bash
openssl rand -hex 32
```

**Windows (PowerShell):** use `System.Security.Cryptography.RandomNumberGenerator`
— **nunca `Get-Random`**, que não é criptograficamente seguro e não deve
gerar segredos de produção:

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[System.BitConverter]::ToString($bytes).Replace('-', '').ToLower()
```

Esse comando usa só a API de instância (`.GetBytes(byte[])`), compatível
tanto com o Windows PowerShell 5.1 (built-in) quanto com o PowerShell 7+ —
evite o método estático `RandomNumberGenerator.GetBytes(int)`, que só
existe em runtimes .NET mais novos.

Qualquer um dos dois comandos acima (bash ou PowerShell) produz uma string hex de 64
caracteres (256 bits), equivalente a `openssl rand -hex 32`. Gere um valor
**novo e diferente para cada variável e para cada ambiente** (nunca reuse
o mesmo segredo entre dev e produção, nem entre duas variáveis diferentes).

Convenção de colunas:

- **Obrigatória**: sem ela o recurso correspondente não funciona (algumas são obrigatórias só se você usar aquele provedor específico — indicado na coluna).
- **Onde obter**: de onde vem o valor.
- **Onde inserir**: `.env` local, env do serviço no Dokploy/Vercel, ou UI do produto.
- **Secreto**: se é um valor sensível.

## Core / aplicação

| Variável | Obrigatória | Onde obter | Onde inserir | Secreto |
|---|---|---|---|---|
| `NODE_ENV` | Sim | Fixo (`development`/`production`) | `.env` / env do serviço | Não |
| `WEB_ORIGIN` | Sim | URL pública do seu frontend (CORS) | `.env` da API / env do serviço | Não |
| `NEXT_PUBLIC_API_URL` | Sim | URL pública da sua API | `.env` do web / env do projeto Vercel | Não (é exposta ao navegador de propósito) |
| `API_PUBLIC_URL` | Sim | URL pública da sua API | `.env` da API / env do serviço | Não |
| `API_PORT` | Sim (tem padrão `3333`) | Porta que você expõe para a API. **No Dokploy, defina `API_PORT=3000`** — o `Dockerfile` faz `EXPOSE 3000`, e essa variável precisa bater exatamente com a porta interna do container configurada no serviço (veja [`dokploy.md`](dokploy.md#6-variáveis-de-ambiente-da-api)); sem isso a API sobe na porta padrão `3333` e o Dokploy não a alcança | `.env` da API / env do serviço | Não |
| `INBOUND_WEBHOOKS_ENABLED` e demais `INBOUND_*` | **Sim, para Gatilhos de conversão** (padrão é `false`/desligado) — veja a seção dedicada [Gatilhos de conversão](#gatilhos-de-conversão--obrigatórias-no-caminho-do-aluno) abaixo | Flags de feature do produto | `.env` da API | `INBOUND_WEBHOOK_ENCRYPTION_KEY` **sim**, as demais não |
| `GIT_SHA` | **Não — não crie.** O commit instalado é lido automaticamente da pasta `.git` durante o build; como env de runtime, `GIT_SHA` é ignorada. Só existe como build arg de fallback para builds **sem** `.git` — veja [Versão instalada](update.md#versão-instalada) | — | — | Não |
| `WPPTRACK_*_MS`, `WPPTRACK_EXTERNAL_SYNC_*`, `WPPTRACK_EXTERNAL_MYSQL_*` | Não (têm padrão) | Tuning de performance/timeout — mantenha o padrão salvo se tiver um motivo específico para ajustar | `.env` da API | Não |

## Gatilhos de conversão — obrigatórias no caminho do aluno

⚠️ **O padrão de todas as `INBOUND_*` é desligado (`false`/vazio).** Isso
significa que, mesmo com UAZAPI, NOD API, WAHA, Z-API ou outro provedor já
recebendo leads/webhooks, a tela **Conversões → Nova regra** não
aparece — não é bug, é a feature desligada. Gatilhos de conversão valem para
**qualquer origem** que use esse módulo (UAZAPI, NOD API, WAHA, Z-API, Umbler,
Gupshup e demais integrações futuras). Se o aluno precisa criar regras de
conversão, estas variáveis são **obrigatórias**, não opcionais:

| Variável | Obrigatória | Onde obter | Onde inserir | Secreto |
|---|---|---|---|---|
| `INBOUND_WEBHOOKS_ENABLED` | **Sim** — defina `true` | Fixo | `.env` da API / env do serviço | Não |
| `INBOUND_WEBHOOK_ENCRYPTION_KEY` | **Sim** | Você gera (comando abaixo) — Base64 de 32 bytes, string de 44 caracteres terminando em `=` | `.env` da API / env do serviço | **Sim** |
| `INBOUND_CONVERSION_RULES_ENABLED` | **Sim** — defina `true` | Fixo | `.env` da API / env do serviço | Não |
| `INBOUND_WEBHOOK_PRODUCTION_ENABLED` | **Sim em produção** (Dokploy/deploy do aluno) | Fixo | `.env` da API / env do serviço | Não |
| `INBOUND_CONVERSION_PRODUCTION_ENABLED` | Não — deixe **sem valor** (produção direta, Fase 6.1c): sem valor, o envio das regras acompanha `INBOUND_CONVERSION_RULES_ENABLED`. `false` explícito desliga o envio de todas as regras (interruptor do servidor). Se a sua API tem `false` copiado do `.env.example` antigo, troque para `true` ou apague a variável | Fixo | `.env` da API | Não |
| `INBOUND_WEBHOOK_REPLAY_ENABLED` | Não — mantenha `false` a menos que precise reprocessar webhooks | Fixo | `.env` da API | Não |
| `LEAD_SUBMITTED_RULE_OVERRIDE_ENABLED` | Não — deixe **sem valor** (padrão **ligado**, Fase 6.2a, produção direta). Ligada: uma regra de conversão "Lead recebido" ativa e enviando (frase, catálogo ou automação) passa a enviar o Lead recebido dos números que ela cobre quando for acionada, e a entrada da conversa só registra a origem (nunca os dois; uma vez por lead e pixel). Sem regra assim, nada muda: o Lead recebido sai na entrada, como antes. `false` (ou `0`, `off`, `no`) explícito desliga: o Lead recebido volta a sair sempre na entrada. Só a API lê; mudar exige reiniciar a API | Fixo | `.env` da API / env do serviço (Dokploy: variáveis do serviço da API) | Não |

Gere a chave de criptografia (Base64 de 32 bytes) com Node — mesmo comando em
qualquer sistema operacional com Node instalado:

```bash
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))"
```

Alternativa com `openssl`, gerando já no formato Base64 esperado (não use
`openssl rand -hex 32` aqui — esse gera hexadecimal, formato errado para esta
variável):

```bash
openssl rand -base64 32
```

Cole o valor gerado **direto no painel de env do serviço** (Dokploy) ou no
`.env` local — nunca em chat nem em arquivo commitado.

**Checklist mínimo do aluno** para liberar Gatilhos de conversão:

1. `INBOUND_WEBHOOKS_ENABLED=true`
2. `INBOUND_WEBHOOK_ENCRYPTION_KEY=<chave gerada acima>`
3. `INBOUND_CONVERSION_RULES_ENABLED=true`
4. `INBOUND_WEBHOOK_PRODUCTION_ENABLED=true` (obrigatório em produção/Dokploy)
5. `API_PUBLIC_URL=https://<domínio da sua API>` (já obrigatória — ver seção Core acima)
6. Redeploy da API
7. Confirmar em `/conversions` (depois de já existir uma conexão WhatsApp/origem) que **Nova regra** está disponível

## Banco de dados / autenticação

| Variável | Obrigatória | Onde obter | Onde inserir | Secreto |
|---|---|---|---|---|
| `DATABASE_URL` | Sim | Você monta a partir do host/porta/usuário/senha/banco do seu Postgres (local: `docker-compose.yml`; Dokploy: tela de conexão do serviço de banco). Formato: `postgresql://usuario:senha@host:5432/banco` — **se a senha tiver caractere especial (`@ : / % # ?` etc.), URL-encode antes de montar a string** (`node -e "console.log(encodeURIComponent('sua_senha'))"`), senão a conexão quebra | `.env` local / env do serviço | **Sim** |
| `REDIS_URL` | Sim | Idem, a partir do serviço Redis | `.env` local / env do serviço | **Sim** (contém host/porta; trate como sensível se tiver senha) |
| `EXTERNAL_CONNECTOR_ENCRYPTION_KEY` | Sim | Você gera (`openssl rand -hex 32` ou similar) | `.env` local / env do serviço | **Sim** |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Sim | Você gera; use valores diferentes em dev e produção | `.env` local / env do serviço | **Sim** |
| `AUTH_PUBLIC_REGISTRATION_ENABLED` | Não (padrão `false`) | Decisão sua | `.env` da API | Não |
| `AUTH_GOOGLE_ENABLED` | Não | Decisão sua (login com Google) | `.env` da API | Não |
| `AUTH_COOKIE_DOMAIN` | Sim quando web e API usam subdomínios irmãos | Domínio raiz comum, com ponto inicial | `.env` da API / env do serviço | Não |
| `AUTH_EXPOSE_DEV_TOKENS` | Não — **deixe `false` em produção** | Só para debug local | `.env` local | Não |
| `WPPTRACK_PLATFORM_ADMIN_EMAILS` | Não use — **variável legada, sem efeito no código atual** | — | — | Não |
| `SETUP_PLATFORM_ADMIN_EMAIL` | Sim, junto com a senha, para o bootstrap do primeiro `platform_owner` | E-mail do primeiro `platform_owner` | Env do serviço da API (ex.: Dokploy) — nunca commitado nem colado em chat | Não — mas é específico do aluno |
| `SETUP_PLATFORM_ADMIN_PASSWORD` | Sim, junto com o e-mail, para o bootstrap do primeiro `platform_owner` | Senha forte que você mesmo escolhe (8+ caracteres) | Env do serviço da API (ex.: Dokploy) | **Sim** — remova essa variável (ou limpe o valor) depois do primeiro login bem-sucedido |
| `SETUP_PLATFORM_ADMIN_CONFIRM_EXISTING` | Não (padrão `false`) | Use exatamente `true` somente para promover intencionalmente uma conta já existente com aquele e-mail | Env do serviço da API | Não |

### Bootstrap do primeiro administrador por env — caminho oficial

`SETUP_PLATFORM_ADMIN_EMAIL` + `SETUP_PLATFORM_ADMIN_PASSWORD` são o caminho
oficial e único para criar o primeiro `platform_owner`, tanto no Dokploy/produção
quanto localmente — não dependem de console/terminal no container, de
cadastro público temporário nem de nenhuma allowlist de e-mail.

Como funciona (implementado em `PlatformAdminEnvBootstrapService`, executado
a cada boot da API, antes dela aceitar conexões):

- **Defina as duas variáveis juntas** no serviço da API (painel de env do
  Dokploy) e faça **redeploy** (local: basta reiniciar
  `pnpm --filter @wpptrack/api dev`). Se só uma das duas estiver preenchida,
  o bootstrap não faz nada — a API sobe normalmente, sem criar/alterar
  contas.
- **É idempotente e só existe um `platform_owner` por instância:** se a
  conta daquele e-mail já for `platform_owner`, o boot seguinte não faz
  nada (log `platform_admin_env_bootstrap_skipped_existing_owner`). Se já
  existir um `platform_owner` **com outro e-mail**, o bootstrap também não
  faz nada com essas variáveis — nesse ponto, gerencie papéis pela sessão
  autenticada (backoffice), não reutilize essas variáveis para trocar quem
  é o dono da plataforma.
- Se o e-mail já pertencer a uma conta comum (sem papel de plataforma), ela
  só é promovida a `platform_owner` quando `SETUP_PLATFORM_ADMIN_CONFIRM_EXISTING=true`
  também estiver definida — sem isso, o bootstrap é pulado de propósito
  (log `platform_admin_env_bootstrap_existing_user_requires_confirmation`),
  para não promover uma conta por engano.
- A senha informada só é gravada quando a conta é **criada** ou quando a
  conta promovida ainda **não tinha senha** — uma senha já existente nunca é
  sobrescrita.
- O bootstrap cria/promove só a conta e o papel `platform_owner`; **não cria
  workspace nenhum**. Depois de logar com essa conta, crie o primeiro
  workspace/cliente em `/backoffice/clients`.
- Depois de confirmar o primeiro login, **remova `SETUP_PLATFORM_ADMIN_PASSWORD`**
  do painel (ou limpe o valor) e faça redeploy — sem a senha preenchida, o
  bootstrap para de rodar completamente a cada boot (ele nem chega a
  consultar o banco), então é seguro removê-la. Manter só
  `SETUP_PLATFORM_ADMIN_EMAIL` preenchida depois disso não tem efeito
  nenhum, mas não há motivo para deixar a senha em texto plano no painel
  depois de usá-la.

⚠️ **`WPPTRACK_PLATFORM_ADMIN_EMAILS` não tem efeito no código atual** — o
mecanismo de allowlist por e-mail no login foi removido; preencher essa
variável não concede papel nenhum. Não a use como caminho para dar acesso de
plataforma.

⚠️ **Habilitar `AUTH_PUBLIC_REGISTRATION_ENABLED=true` temporariamente para se
cadastrar como administrador de plataforma também não funciona mais** — o
cadastro público cria uma conta comum, sem nenhum papel de plataforma; essa
variável continua existindo só como toggle de cadastro público de usuários
comuns, sem relação com o bootstrap do `platform_owner`.

Para criar contas **de workspace** (não de plataforma) — por exemplo, um
usuário/cliente comum com seu próprio workspace — use
`pnpm --filter @wpptrack/api create-user -- --email ... --password ... --role owner`
(veja [`local.md`](local.md#5-primeiro-administrador)). Esse script
explicitamente se recusa a criar ou alterar qualquer conta que já tenha um
papel de plataforma — ele não é (e não deve ser usado como) caminho para o
primeiro `platform_owner`.

### Login com Google (opcional)

| Variável | Obrigatória | Onde obter | Onde inserir | Secreto |
|---|---|---|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_OAUTH_STATE_SECRET` | Só se `AUTH_GOOGLE_ENABLED=true` | Console do Google Cloud (OAuth) | `.env` da API / env do serviço | `GOOGLE_CLIENT_SECRET` e `GOOGLE_OAUTH_STATE_SECRET` **sim**; `GOOGLE_CLIENT_ID`/`GOOGLE_REDIRECT_URI` não |

## Licença (PalmUP)

| Variável | Obrigatória | Onde obter | Onde inserir | Secreto |
|---|---|---|---|---|
| `LICENSE_SERVER_URL` | Sim | Fornecido pela PalmUP (já vem preenchido no `.env.example`) | `.env` / env do serviço | Não |
| `LICENSE_KEY` | Sim para ativar a licença | E-mail/WhatsApp recebido após a compra na PalmUP | `.env` local ou env do serviço — **nunca** commitado | **Sim** |
| `LICENSE_ACCOUNT_IDENTITY` | Sim para ativar a licença | O e-mail da **sua conta de aluno**, exatamente igual ao usado na compra | `.env` local ou env do serviço | Não (mas deve corresponder à conta vinculada — um valor errado retorna `403` na ativação) |

O template é **fail-closed**: com `LICENSE_SERVER_URL` preenchido (o padrão do
`.env.example`), enquanto não houver uma ativação válida a leitura continua
liberada, mas toda operação de escrita responde `423` — inclusive criar
workspace/cliente. O cliente de licença só fica inerte (sem travar nada) quando
`LICENSE_SERVER_URL` está **vazio** — cenário de desenvolvimento local do
template, não de uso do produto.

**A ativação é automática no boot.** Com `LICENSE_KEY` e
`LICENSE_ACCOUNT_IDENTITY` preenchidas, a API faz **uma** tentativa de
ativação antes de começar a aceitar conexões
(`LicenseAutoActivationService`) e registra `license_auto_activation_succeeded`
ou `license_auto_activation_failed` no log. Não há retry dentro do mesmo
processo — um novo boot tenta de novo (a ativação remota é idempotente
para a mesma chave/identidade/fingerprint). `POST /license-client/activate`
continua existindo como **fallback manual**, liberado mesmo com a
instância bloqueada.

**Não existe tela de administração de licenças neste produto.** O aluno
tem apenas `/backoffice/license`, que mostra o estado da própria
instância. Recuperar ou reemitir uma chave é operação interna da PalmUP:
oriente o aluno a procurar o suporte com o **e-mail da compra**, nunca a
"procurar a licença em alguma tela de admin" — esse caminho não existe.

## E-mail (SMTP BYO)

| Variável | Obrigatória | Onde obter | Onde inserir | Secreto |
|---|---|---|---|---|
| `EMAIL_PROVIDER` | Só se for enviar e-mail | Decisão sua (ex.: `smtp`) | `.env` da API | Não |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | Só se for enviar e-mail | Seu provedor SMTP (Brevo, SES, etc.) | `.env` local / env do serviço | Não (host/porta) |
| `SMTP_USER`, `SMTP_PASSWORD` | Só se for enviar e-mail | Seu provedor SMTP | `.env` local / env do serviço | **Sim** |
| `EMAIL_FROM_NAME`, `EMAIL_FROM_ADDRESS`, `EMAIL_REPLY_TO` | Recomendado | Sua escolha | `.env` da API | Não |

SMTP é **totalmente opcional** — não é pré-requisito para criar workspace/cliente. Sem `EMAIL_PROVIDER=smtp` (ou com qualquer uma das variáveis acima ausente), a API continua criando o workspace normalmente em `POST /backoffice/workspaces`; ela só não consegue enfileirar o e-mail de ativação do responsável e a resposta traz `deliveryStatus: "manual_link_required"`. Nesse caso, gere o link de ativação manual no botão correspondente em `/backoffice/clients` e envie você mesmo (WhatsApp, e-mail avulso etc.) para o responsável do workspace — o link tem expiração própria, então gere um novo se o anterior expirar. Exemplo de valores para testar localmente, sem segredo real (não são credenciais de um provedor de verdade):

```bash
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.exemplo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=usuario@exemplo.com
SMTP_PASSWORD=preencha-com-a-senha-real-do-seu-provedor
EMAIL_FROM_NAME=RastrackDash
EMAIL_FROM_ADDRESS=no-reply@exemplo.com
```

## Meta (Ads e WhatsApp Cloud API)

| Variável | Obrigatória | Onde obter | Onde inserir | Secreto |
|---|---|---|---|---|
| `META_APP_ID` | Só se for usar integração Meta via App próprio | Meta for Developers | `.env` da API | Não |
| `META_APP_SECRET` | **Sim para produção do Meta WhatsApp (Cloud API)** — veja abaixo | Meta for Developers → App Secret do **mesmo app** do webhook | `.env` local / env do serviço | **Sim** |
| `META_CONNECTION_MODES` | Sim para o MVP do aluno | Defina exatamente `manual` | `.env` da API / env do serviço | Não |
| `META_GRAPH_API_VERSION` | Não (tem padrão) | Documentação Graph API | `.env` da API | Não |
| `META_TOKEN_ENCRYPTION_KEY` | Sim, antes de conectar qualquer token Meta | Você gera | `.env` local / env do serviço | **Sim** |
| `KOMMO_CRM_ENCRYPTION_KEY` | Sim, antes de criar uma conexão Kommo | Base64 canônico de 32 bytes, gerado pelo aluno | env efetiva do container da API | **Sim** |
| `PIPEDRIVE_CRM_ENCRYPTION_KEY` | Sim, antes de criar uma conexão Pipedrive | Base64 canônico de 32 bytes, gerado pelo aluno (`openssl rand -base64 32`); **diferente** da chave do Kommo | env efetiva do container da API | **Sim** |
| `META_WEBHOOK_VERIFY_TOKEN` | Só para o webhook de **Meta Ads** (`/webhooks/meta`), que também recebe os **Formulários Meta** (Lead Ads, Fase 6.9) | Você define | `.env` local / env do serviço | **Sim** |
| `WPPTRACK_META_AUTO_SYNC_*` | Não (têm padrão) | Tuning do sync automático | `.env` da API | Não |
| `META_VIDEO_THUMBNAILS_ENABLED` | Não (padrão desligado) | Só `true` liga a busca extra de miniaturas de vídeo (`/{video}/thumbnails`). Deixe desligado ao usar o login social PalmUP: o limite de chamadas do app Meta é compartilhado | `.env` da API | Não |
| `WPPTRACK_META_USAGE_PAUSE_PERCENT` | Não (padrão `75`) | Uso do app Meta (%) a partir do qual a sincronização de relatórios em segundo plano cede a vez e é retomada sozinha depois. O limite vale **por app**: o app da PalmUP (botão **Conectar Meta (PalmUP)**) e o seu app próprio são contados separados — veja [Limite de uso da Meta](#limite-de-uso-da-meta-fase-64-opcional) | `.env` da API / env do serviço da API | Não |
| `WPPTRACK_META_SYNC_DEDUPE_WINDOW_MINUTES` | Não (padrão `15`) | Janela (minutos) em que pedidos iguais de sincronização da mesma conta e período viram um só | `.env` da API / env do serviço da API | Não |
| `WPPTRACK_META_SYNC_MAX_DEFERRALS` | Não (padrão `12`) | Quantas vezes uma sincronização adia por limite da Meta antes de desistir (o próximo ciclo automático cobre o período) | `.env` da API / env do serviço da API | Não |
| `WPPTRACK_META_AUTO_SYNC_INCREMENTAL_DAYS` | Não (padrão `3`, **ligado**; `0` desliga) | Sync automático incremental: uma leitura completa por dia e, nas outras rodadas, só os últimos N dias. Se os dias guardados não fecharem com o total da Meta, lê a janela inteira. Precisa do Redis (sem ele toda rodada é completa) | `.env` da API / env do serviço da API | Não |
| `META_INSIGHTS_LEVEL_MODE` | Não (padrão `legacy`) | `legacy` (como antes), `shadow` (lê também por anúncio e só registra no log se os totais batem: `META_INSIGHTS_AD_LEVEL_PARITY ... mismatched=0`) ou `ad_level` (lê só no nível de anúncio e soma campanhas/conjuntos localmente: menos chamadas). Use `shadow` antes de `ad_level` | `.env` da API / env do serviço da API | Não |
| `META_INSIGHTS_PAGE_LIMIT` | Não (padrão `500`) | Linhas por página dos Insights; volta sozinho para 100 se a Meta pedir menos dados. `100` = comportamento anterior | `.env` da API / env do serviço da API | Não |
| `META_INSIGHTS_ASYNC_ENABLED` | Não (padrão **desligado**) | `true` usa o relatório assíncrono da Meta em períodos longos (com volta automática ao modo normal). Ajustes: `META_INSIGHTS_ASYNC_MIN_DAYS` (padrão `31`), `META_INSIGHTS_ASYNC_POLL_MS` (padrão `3000`), `META_INSIGHTS_ASYNC_MAX_POLLS` (padrão `40`) | `.env` da API / env do serviço da API | Não |
| `META_CAPI_BATCH_ENABLED` | Não (padrão **desligado**) | `true` junta eventos de conversão simultâneos do mesmo pixel em um envio à Meta (status por evento; se a Meta recusar o lote por um evento inválido, reenvia um a um; se recusar por token inválido ou limite, todos ficam com a mesma recusa, sem reenvio). Só entram no lote os envios simples: Kommo, Pipedrive, as regras de entrada e o caminho CTWA página/pixel (que têm prazo e garantia de envio único) nunca entram. Ajustes: `META_CAPI_BATCH_WINDOW_MS` (padrão `250`), `META_CAPI_BATCH_MAX_EVENTS` (padrão `1000`) | `.env` da API / env do serviço da API | Não |
| `WPPTRACK_CONVERSION_WORKER_CONCURRENCY` | Não (padrão `1`, máximo `50`) | Quantos eventos de conversão a API processa ao mesmo tempo. O envio em lote da CAPI só junta eventos com valor maior que 1 (sugestão do SaaS: 4 a 10) | `.env` da API / env do serviço da API | Não |
| `META_CAPI_SEND_FIRST_NAME` | Não (padrão **desligado**) | Só `true` (ou `1`, `on`, `yes`) envia o primeiro nome do lead (`fn`) na Conversions API, normalizado e com hash SHA-256. Fica desligado porque o nome do perfil do WhatsApp nem sempre é o nome real (apelidos, frases). Nomes vazios, genéricos, só emoji ou com cara de telefone nunca são enviados | `.env` da API | Não |
| `WPPTRACK_REPORT_TIMEZONE` | Não (tem padrão `America/Sao_Paulo`) | Seu fuso horário de relatório | `.env` da API | Não |
| `PTAX_SYNC_ENABLED` | Não (padrão **desligado**) | Só ligue (`true`) se anuncia ou vende em USD/EUR: busca a cotação PTAX do Banco Central para os relatórios por moeda — veja [Cotação PTAX](#cotação-ptax-relatórios-por-moeda-opcional) | `.env` da API | Não |
| `PALMUP_META_BROKER_URL` | Só para o botão **Conectar Meta (PalmUP)** — sem ela, fica só o token permanente | Fornecido pela PalmUP (já vem preenchido no `.env.example`: `https://wpptrack-api.rastrack.app`) | `.env` da API / env do serviço da API. O web **não** precisa dela | **Não** — é uma URL pública, não é App Secret |

### `PALMUP_META_BROKER_URL` — login social Meta pela PalmUP

Com esta variável preenchida, o **owner** do workspace vê o botão
**Conectar Meta (PalmUP)** em **Integrações → Tokens, BMs e destinos** e entra
com o Facebook pelo **app Meta da PalmUP**. Você **não** precisa criar um app
Meta próprio nem preencher `META_APP_ID`/`META_APP_SECRET` para isso.

- É só a **origem HTTPS pública** da API da PalmUP, sem caminho no final
  (`https://wpptrack-api.rastrack.app`). Não é segredo, não é token e **não**
  é App Secret.
- O App Secret do app Meta da PalmUP **nunca** vai para a sua VPS, para o
  Dokploy, para a Vercel nem para `META_APP_SECRET`. Se alguém pedir esse
  segredo para "ativar o login social", está errado — pare e fale com o
  suporte PalmUP.
- O token que a Meta devolve é resgatado pela **sua API** e guardado
  criptografado com `META_TOKEN_ENCRYPTION_KEY`, como o token colado à mão. Ele
  nunca aparece no navegador.
- Vazia ou ausente: ao clicar no botão, a API responde "Login social PalmUP nao
  configurado", o botão fica apagado e o caminho do token permanente continua
  igual. Depois de alterar, faça redeploy da API.

### Kommo CRM (opcional)

Se você habilitar a integração Kommo (conectada em `/integrations` → aba
**CRM** → card **Kommo**; até a versão anterior ficava em Configurações), gere uma chave Base64 de **32 bytes** e
preencha `KOMMO_CRM_ENCRYPTION_KEY` somente no ambiente efetivo da API. A API
rejeita formatos inválidos e nunca devolve tokens Kommo pelas rotas de gestão
ou auditoria. Não use uma chave no frontend nem a versione no `.env`.

Exemplo de geração local (cole o resultado diretamente no seu gerenciador de
variáveis, não no chat):

```bash
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))"
```

Leads com `ctwa_clid` e **sem ID do anúncio** agora também são enviados pelo
Kommo, pela página + pixel verificados do workspace, quando o lead entrou por um
número autorizado na conexão Kommo que herda o destino do workspace (igual ao
SaaS). Esse caminho usa o envio CTWA do produto, que exige
`INBOUND_WEBHOOKS_ENABLED=true` e `INBOUND_WEBHOOK_PRODUCTION_ENABLED=true`.
Leads com ID do anúncio seguem pela rota do número, como antes. Sem `ctwa_clid`
nada é enviado.

### Pipedrive CRM (opcional)

Para conectar o Pipedrive (`/integrations` → aba **CRM** → card **Pipedrive**),
gere uma chave **nova** de 32 bytes — nunca reutilize a do Kommo — e preencha
`PIPEDRIVE_CRM_ENCRYPTION_KEY` somente no ambiente efetivo da API:

```bash
openssl rand -base64 32
```

Sem a variável a API sobe normalmente e só o Pipedrive fica indisponível. Se ela
estiver definida com formato inválido ou com o mesmo valor da
`KOMMO_CRM_ENCRYPTION_KEY`, a API **não sobe** (erro explícito no log). Não há
flag de liberação: o envio é decidido por regra e exige licença válida. Passo a
passo completo (token de API, webhook v2 de negócio alterado, regras de etapa)
em [`pipedrive.md`](pipedrive.md).

Defina `META_CONNECTION_MODES=manual` **antes** de configurar Meta e redeploy a API depois de alterar a env. No MVP do aluno não há o OAuth antigo (app Meta próprio) como caminho alternativo. A credencial Meta entra por workspace na UI de **Integrações**, nunca em variável pública: pelo botão **Conectar Meta (PalmUP)** (exige `PALMUP_META_BROKER_URL`, veja acima) ou colando o token do usuário do sistema — veja [`meta-manual.md`](meta-manual.md).

### Formulários Meta (Lead Ads) e importação do Dashboard Leads (Fase 6.9)

Nenhuma variável nova no `.env` da API ou da web. Os **Formulários Meta** ([guia](meta-lead-forms.md)) usam variáveis que já existem:

| Variável | Para que serve nos Formulários Meta | Obrigatória | Sem valor |
|---|---|---|---|
| `META_APP_SECRET` | Confere a assinatura `X-Hub-Signature-256` do webhook `leadgen` em `/webhooks/meta` e gera o `appsecret_proof` da leitura do lead na Graph API | **Sim** para receber leads de formulário | Toda entrega do webhook da Meta é recusada (401) e nenhum lead de formulário entra |
| `META_WEBHOOK_VERIFY_TOKEN` | Token de verificação ao salvar a URL de callback (objeto Page, campo `leadgen`) no app Meta | **Sim** para salvar o webhook no app Meta | A Meta não aceita a URL de callback |
| `META_TOKEN_ENCRYPTION_KEY` | Cifra o token Graph e o token do dataset de cada conexão | **Sim** (já é obrigatória para a Meta) | Não dá para salvar a conexão |
| `API_PUBLIC_URL` | Monta a URL do webhook mostrada no painel (`{API_PUBLIC_URL}/webhooks/meta`) | Já obrigatória | O painel mostra `<API_PUBLIC_URL>/webhooks/meta` no lugar da URL |
| `META_GRAPH_API_VERSION` | Versão da Graph API da leitura do lead e do envio ao dataset do CRM | Não (padrão `v21.0` no código; o `.env.example` traz `v25.0`) | Usa o padrão |

O comando **opcional** de importação do Dashboard Leads ([guia](dashboard-leads-import.md)) lê duas variáveis **só na linha de comando** de quem roda a importação. Elas **não** vão no `.env`, no Dokploy, na Vercel nem em arquivo do repositório, e a API não as usa:

| Variável | Para que serve | Obrigatória | Valor | Onde definir | Sem valor |
|---|---|---|---|---|---|
| `SUPABASE_URL` | Endereço do projeto Supabase do Dashboard Leads, lido pela importação | Só para rodar `dashboard-leads:import` | `https://<projeto>.supabase.co` | Na mesma linha do comando, no terminal de quem importa | O comando para com "Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente." e não grava nada |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave de serviço do Supabase (segredo) para ler projetos e leads pela REST | Só para rodar `dashboard-leads:import` | A chave do painel do Supabase | Na mesma linha do comando; nunca em chat, `.env` ou arquivo versionado | Igual à linha acima |

### `META_APP_SECRET` e o webhook do Meta WhatsApp (Cloud API)

O webhook de mensagens do Meta WhatsApp (Cloud API) **não** usa
`META_WEBHOOK_VERIFY_TOKEN`: o Verify token é gerado pelo produto, por
conexão, e mostrado uma única vez ao criar a conexão em `/integrations`.
`META_APP_SECRET` serve para validar o header `x-hub-signature-256` de
cada POST:

| `META_APP_SECRET` | Conexão em **observação** | Conexão em **produção** |
|---|---|---|
| Preenchido | Aceita só com assinatura válida | Aceita só com assinatura válida |
| Vazio | Aceita e registra o aviso `meta_cloud_signature_unverified` | **Recusa com `404`** |

Ou seja: opcional para homologar, **obrigatório antes de ativar o envio
automático** numa conexão `meta_cloud`. É o App Secret do app Meta, não o
token permanente do Graph de [`meta-manual.md`](meta-manual.md).
Use o segredo do **próprio app que entrega mensagens**, nunca o da PalmUP.
A API verifica sua presença antes da ativação e da autorização de recuperação.

### Recuperação histórica Meta Cloud por owner

`INBOUND_WEBHOOK_REPLAY_ENABLED` continua `false` por padrão. O operador pode
configurar `true` somente na API para disponibilizar prévia e confirmação
por owner; também exige `INBOUND_WEBHOOKS_ENABLED`, a chave atual
`INBOUND_WEBHOOK_ENCRYPTION_KEY`, `META_APP_SECRET` próprio, licença e rotas
autorizadas. Reinicie a API após ajustar suas variáveis; preserve o `.env`
e a chave existente. A flag não envia histórico nem promove a conexão.
`INBOUND_WEBHOOK_PRODUCTION_ENABLED` é necessária para novos envios e não
substitui a habilitação explícita de replay. Consulte o
[fluxo completo e estados de entrega](meta-cloud-recovery.md).

### Cotação PTAX (relatórios por moeda, opcional)

`PTAX_SYNC_ENABLED` fica **desligada por padrão** (variável ausente, vazia ou
`false`). Os relatórios mostram o gasto de cada conta de anúncio na moeda dela
e nunca somam moedas diferentes; a cotação só serve para converter a receita
de uma venda feita em outra moeda.

- **Desligada:** a API não faz nenhuma chamada externa. Uma venda em outra
  moeda aparece na moeda original, fora da receita da conta, e o ROAS dessa
  parte fica "sem cotação". Quem tem tudo em real não precisa ligar.
- **Ligada** (`PTAX_SYNC_ENABLED=true`, só na API): a cada 6 horas (a primeira
  1 a 2 minutos depois de a API subir) a API busca a PTAX de USD e EUR no Banco
  Central e guarda na tabela `ExchangeRate`; dias que faltam são buscados na
  hora em que um relatório precisa, em segundo plano (o relatório espera no
  máximo cerca de 1,5 s). A receita atribuída a um anúncio é
  convertida para a moeda da conta pela cotação do dia da venda (horário de
  Brasília); sem boletim nesse dia (fim de semana, feriado), vale a do último
  dia útil anterior. Venda sem conta de anúncio atribuída fica na moeda
  original.
- **Rede:** ligada, a API precisa de saída HTTPS para `olinda.bcb.gov.br`
  (API pública do Banco Central, sem chave nem cadastro). Se o Banco Central
  estiver fora ou bloqueado, vale a cotação guardada de até 10 dias antes da
  venda ou "sem cotação":
  nenhum relatório quebra e nada é enviado à Meta por causa disso.
- Não confunda com `WPPTRACK_PTAX_SYNC_ENABLED` (nome usado no SaaS): aqui ela
  não tem efeito. Reinicie a API depois de mudar a variável.

### Limite de uso da Meta (Fase 6.4, opcional)

Todas as variáveis desta parte são **opcionais**: sem valor, vale o padrão da
tabela acima. Nenhuma é segredo e nenhuma é pedida pelo `pnpm setup` nem pelo
checklist de `/onboarding/status`. Preencha só no env do serviço da **API**
(Dokploy, VPS ou `.env` local); o web não usa nenhuma delas. Reinicie a API
depois de mudar.

- **Ligado por padrão (sem configurar nada):**
  - disjuntor só dos relatórios: se a Meta disser que o token ou a permissão
    da conta de anúncios não vale mais (erros 190/102 ou 10/200), a
    sincronização **daquela conta** pausa e Relatórios mostra "Reconecte a
    conta Meta". Com 190/102 confirmado por uma leitura barata de `/me`,
    pausam também as outras contas do mesmo token. O envio de conversões
    (CAPI) continua normal. Reconectar, revalidar ou "Testar" a conexão em
    Integrações libera de novo;
  - pausa por uso: com o uso do app Meta acima de
    `WPPTRACK_META_USAGE_PAUSE_PERCENT` (ou com erro de limite da Meta), a
    sincronização em segundo plano espera e retoma sozinha. O login e o
    botão **Conectar Meta (PalmUP)** nunca são bloqueados por isso;
  - pedidos repetidos de sincronização dentro da janela viram um só;
  - miniaturas dos criativos guardadas no banco (tabela
    `MetaCreativeThumbnail`): cada criativo novo é buscado uma vez (até 150
    por sincronização, ~30 s no máximo, pausa de 15 min após erro de limite);
  - sync automático incremental (`WPPTRACK_META_AUTO_SYNC_INCREMENTAL_DAYS=3`)
    e páginas de 500 linhas nos Insights.
- **Desligado por padrão:** `META_INSIGHTS_LEVEL_MODE` (fica `legacy`),
  `META_INSIGHTS_ASYNC_ENABLED` e `META_CAPI_BATCH_ENABLED`.
- **Limite por app:** o app Meta usado pode ser o da PalmUP (botão
  **Conectar Meta (PalmUP)**, compartilhado entre as instalações) ou o seu
  app próprio (token do usuário do sistema). A pausa por uso do app é contada
  separada para cada um, então o uso alto do app da PalmUP não pausa a
  sincronização das contas conectadas pelo seu app, e vice-versa. O limite
  por conta de anúncios vale para qualquer app. A API reconhece o app da
  PalmUP pelo nome que o botão dá à credencial ("Login social PalmUP"); não
  use esse nome num token do seu app.
- `META_VIDEO_THUMBNAILS_ENABLED` continua igual: desligada, nenhuma chamada
  extra a `/{video}/thumbnails`; a miniatura do vídeo vem do próprio criativo.
- Ajustes finos das miniaturas (raramente necessários):
  `META_CREATIVE_THUMBNAIL_MAX_PER_SYNC` (150),
  `META_CREATIVE_THUMBNAIL_STAGE_BUDGET_MS` (30000),
  `META_CREATIVE_THUMBNAIL_RATE_LIMIT_PAUSE_MS` (900000),
  `META_CREATIVE_THUMBNAIL_DOWNLOAD_TIMEOUT_MS` (3000),
  `META_CREATIVE_THUMBNAIL_DOWNLOAD_CONCURRENCY` (4) e
  `META_CREATIVE_THUMBNAIL_MAX_BYTES` (102400).
- Para voltar ao comportamento anterior de leitura:
  `WPPTRACK_META_AUTO_SYNC_INCREMENTAL_DAYS=0`,
  `META_INSIGHTS_PAGE_LIMIT=100`, `META_INSIGHTS_LEVEL_MODE=legacy` e
  `META_CAPI_BATCH_ENABLED=false`.

## URLs, cookie e primeiro administrador

Use estes valores de formato (exemplos sem segredos):

```text
WEB_ORIGIN=https://app.example.com
NEXT_PUBLIC_API_URL=https://api.example.com
AUTH_COOKIE_DOMAIN=.example.com
META_CONNECTION_MODES=manual
SETUP_PLATFORM_ADMIN_EMAIL=student-admin@example.com
```

Quando frontend e API forem subdomínios irmãos, `AUTH_COOKIE_DOMAIN` deve ser somente o domínio raiz comum, com ponto inicial. Exemplo concreto:

```text
Frontend: https://wpp.nodinfra.com.br
API: https://aula.nodinfra.com.br
AUTH_COOKIE_DOMAIN=.nodinfra.com.br
```

Não use `https://`, barra final nem o hostname completo da API em `AUTH_COOKIE_DOMAIN`. Nunca use `***` como valor: ele serve apenas para redigir algo em logs. Insira `SETUP_PLATFORM_ADMIN_EMAIL` e `SETUP_PLATFORM_ADMIN_PASSWORD` diretamente no Dokploy/provedor antes do redeploy que vai criar o primeiro administrador (veja a seção acima) — o e-mail é específico da sua instância e nem ele nem a senha devem ser commitados ou enviados em chat. Toda alteração de env da API exige redeploy da API; `NEXT_PUBLIC_API_URL` também exige novo build/deploy do web.

## Provedores de WhatsApp

⚠️ **Estas variáveis deixaram de ser o caminho principal.** As conexões de
WhatsApp são criadas **por workspace** na própria UI (`/integrations` →
aba **WhatsApp** → card do provedor), com as credenciais digitadas ali e
guardadas criptografadas. As envs abaixo continuam sendo lidas como
**padrão do deployment**: o adapter usa a credencial salva na conexão e só
cai na env quando aquele campo não foi preenchido na conexão. Elas também
alimentam o bloco de status global "Instância Uazapi (BYO)" dentro do card
**Uazapi** (aba **WhatsApp**) de `/integrations`.

Umbler Talk, Gupshup, Data Crazy e Meta WhatsApp (Cloud API) **não têm
variável de ambiente específica do provedor** — são conexões de webhook de entrada criadas em
`/integrations`. O contrato completo, a matriz do que já recebe mensagem
e o que ainda não, está em
[`whatsapp-providers.md`](whatsapp-providers.md) — leia antes de configurar.

| Variável | Obrigatória | Onde obter | Onde inserir | Secreto |
|---|---|---|---|---|
| `UAZAPI_BASE_URL`, `UAZAPI_TOKEN` | Não — padrão do deployment para `uazapi_byo` | Sua própria instância Uazapi | `.env` local / env do serviço | `UAZAPI_TOKEN` **sim** |
| `UAZAPI_WEBHOOK_AUTH_TOKEN` | Não — só para o endpoint global legado `POST /webhooks/uazapi` | Você define | `.env` local / env do serviço | **Sim** |
| `WAHA_BASE_URL`, `WAHA_API_KEY` | Não — padrão do deployment para `waha` | Sua própria instância [WAHA](https://github.com/devlikeape/waha) self-hosted | `.env` local / env do serviço | `WAHA_API_KEY` **sim** |
| `WAHA_SESSION` | Não (padrão `default`) | Nome da sessão na sua instância WAHA | `.env` da API | Não |
| `ZAPI_BASE_URL`, `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN` | Não — padrão do deployment para `zapi` | Painel [Z-API](https://www.z-api.io/) | `.env` local / env do serviço | `ZAPI_TOKEN` **sim** |
| `API_PUBLIC_URL` | **Sim, para gerar receiver** | URL pública da sua API (já obrigatória na seção Core) | `.env` da API / env do serviço | Não |
| `DISCONNECT_ALERTS_ENABLED`, `DISCONNECT_ALERT_STREAK`, `DISCONNECT_ALERT_INTERVAL_MS` | Não (opcional) | Decisão sua | `.env` da API | Não |
| `OPS_ALERT_WEBHOOK_URL` | Só se `DISCONNECT_ALERTS_ENABLED=true` | Webhook do seu Slack/Discord/etc. | `.env` local / env do serviço | **Sim** (trate a URL como sensível — permite postar no seu canal) |
| `OPS_ALERT_UAZAPI_BASE_URL`, `OPS_ALERT_UAZAPI_TOKEN` | Não (opcional) — só para a mensagem dos Alertas WhatsApp sair por WhatsApp. Sem elas o aviso de desconexão aparece só em Integrações | URL do servidor e token de uma instância Uazapi sua que envia o aviso | `.env` da API / env do serviço | `OPS_ALERT_UAZAPI_TOKEN` **sim** |
| `OPS_ALERT_SCAN_INTERVAL_MS` | Não (padrão 15 minutos; mínimo 60000) | Decisão sua | `.env` da API | Não |
| `WPPTRACK_WEB_PROVIDER_STATUS_TIMEOUT_MS` | Não (padrão 2000) | Decisão sua: tempo máximo, em milissegundos, de cada leitura de status ou de atividade das conexões em Integrações | env do serviço da **WEB** | Não |

**Alerta de desconexão por conexão (Fase 6.1c):** a API confere cada conexão
Uazapi BYO e WAHA ativa pela API de status do próprio provedor (a mesma URL do
servidor + token salvos na conexão). O aviso "WhatsApp desconectado" aparece em
Integrações só depois de **2 leituras seguidas** de desconectado; estados
passageiros (subindo, hibernada, offline) e erros de leitura nunca alertam, e
uma leitura conectada tira o aviso. A mensagem por WhatsApp sai uma vez (com o
intervalo de repetição de Configurações > Alertas WhatsApp) quando os alertas
estão ligados no workspace, há telefone cadastrado e a licença está utilizável.

**Atividade do número (Fase 6.3b):** cada conexão Uazapi BYO e WAHA mostra em
Integrações os leads de anúncio (CTWA) de 24 horas, 7 dias e total, o último
lead e o último webhook, com o atalho para os leads desse número. É só
leitura, não tem variável nova e continua aberta com a licença bloqueada. Se a
leitura passar de `WPPTRACK_WEB_PROVIDER_STATUS_TIMEOUT_MS`, a tela mostra
"Atividade indisponível" (nunca zeros inventados).

O receiver de cada conexão é gerado na UI (botão **Gerar receiver**) na
forma `{API_PUBLIC_URL}/webhooks/whatsapp/{ID_DA_CONEXAO}?token=...`. Sem
`API_PUBLIC_URL` válida a geração falha com erro explícito.

⚠️ **`UAZAPI_WEBHOOK_AUTH_TOKEN` é o segredo do endpoint global legado**
(`POST /webhooks/uazapi`, um único valor para toda a instância). Esse
endpoint e a rota `POST /webhooks/uazapi/instances/:instanceId` só
enxergam registros com `provider = "uazapi"` (valor legado) — o painel
atual grava `uazapi_byo`, então **as conexões criadas pela UI não passam
por essas rotas**. Não preencha este token esperando que ele ligue uma
conexão nova: use o receiver por conexão. Matriz completa em
[`whatsapp-providers.md`](whatsapp-providers.md#matriz-de-ingestão-inbound-o-que-realmente-chega-hoje).

Nunca defina `UAZAPI_ADMIN_TOKEN` — essa variável não existe neste template e não deve ser reintroduzida (token de frota interno da PalmUP).

**Data Crazy não precisa de variável de ambiente própria.** Crie a conexão
inbound em `/integrations`, gere a URL com `?token=` e cole-a na automação
HTTP de mensagem recebida do Data Crazy. Ele usa a stack inbound já
existente, incluindo `INBOUND_WEBHOOKS_ENABLED` e, para produção,
`INBOUND_WEBHOOK_PRODUCTION_ENABLED`; veja
[`whatsapp-providers.md`](whatsapp-providers.md#data-crazy--conexão-de-webhook-de-entrada-ctwa).

**Zap Responder** continua sem contrato implementado; não invente
variáveis de ambiente para ele.

## NOD API broker

| Variável | Obrigatória | Onde obter | Onde inserir | Secreto |
|---|---|---|---|---|
| `NOD_API_BROKER_URL` | Só se usar o provedor `nod_api` (add-on licenciado) | Fornecido pela PalmUP (já vem preenchido no `.env.example`) | `.env` / env do serviço | Não |

O provedor `nod_api` autentica usando `LICENSE_KEY` + fingerprint da instância — não existe token administrativo separado para configurar aqui. O status/health do `nod_api` funciona, mas o **receiver inbound ainda não existe** (a rota responde `501`).

## Branding (whitelabel)

| Variável | Obrigatória | Onde obter | Onde inserir | Secreto |
|---|---|---|---|---|
| `BRAND_NAME` | Não (opcional) | Nome da sua agência | `.env` da API | Não |
| `BRAND_LOGO_URL`, `BRAND_FAVICON_URL` | Não (opcional) | URL pública da sua logo/favicon | `.env` da API | Não |
| `BRAND_PRIMARY_COLOR` | Não (opcional, padrão `#0F766E`) | Hex da sua cor de marca (`#rgb` ou `#rrggbb`) | `.env` da API | Não |

Essas variáveis nunca escondem o rodapé residual `RastrackDash · powered by PalmUP` — isso é fixo no produto (veja [`../CUSTOMIZATION.md`](../CUSTOMIZATION.md)).

## Regra: `NEXT_PUBLIC_*` vs. variável só de servidor

- Qualquer variável com prefixo `NEXT_PUBLIC_` é embutida no bundle do navegador e é **pública** — hoje isso é só `NEXT_PUBLIC_API_URL`. Nunca crie uma `NEXT_PUBLIC_*` para um token, senha ou chave.
- Todas as demais variáveis (`.env` da API, e o restante do `.env` do web) ficam **só no servidor** e nunca são enviadas ao navegador.
- Se um provedor pedir uma chave/token, ela vai sempre em uma variável de servidor (API) — nunca em `NEXT_PUBLIC_*` nem em código do `apps/web`.

## Esqueleto copiável de produção (envs da API)

Placeholders apenas — **nenhum valor real**. Cole cada linha, uma de cada vez, direto no painel de variáveis de ambiente do serviço da API no Dokploy (ou nas envs do serviço equivalente no seu provedor). Nunca cole um valor real aqui, em um arquivo commitado, ou em um chat de IA — se um agente de IA estiver te guiando, ele deve pedir para **você** digitar cada segredo direto no formulário do Dokploy, nunca pedir para colá-lo na conversa.

```bash
# ---- Núcleo / público (não secreto) ----
NODE_ENV=production
API_PORT=3000
API_PUBLIC_URL=https://[SUA-API].seudominio.com
WEB_ORIGIN=https://[SEU-WEB].seudominio.com
AUTH_COOKIE_DOMAIN=.seudominio.com

# ---- Primeiro platform_owner (preencher os dois, redeploy, logar, depois remover a senha) ----
SETUP_PLATFORM_ADMIN_EMAIL=[E-MAIL DO ADMIN, PREENCHER DIRETO NO DOKPLOY]
SETUP_PLATFORM_ADMIN_PASSWORD=[PREENCHER NO DOKPLOY — remover depois do primeiro login]

# ---- Banco de dados / Redis (montar a partir da tela de conexão do Dokploy) ----
DATABASE_URL=postgresql://[USUARIO]:[SENHA_URL_ENCODED]@[HOST_INTERNO]:5432/[BANCO]
REDIS_URL=redis://[HOST_INTERNO]:6379

# ---- Segredos gerados (gere valores novos para produção; nunca reuse os de dev) ----
JWT_ACCESS_SECRET=[GERAR]
JWT_REFRESH_SECRET=[GERAR]
EXTERNAL_CONNECTOR_ENCRYPTION_KEY=[GERAR]
META_TOKEN_ENCRYPTION_KEY=[GERAR]

# ---- Licença (PalmUP) ----
LICENSE_SERVER_URL=[já vem preenchido no .env.example — não altere sem orientação da PalmUP]
LICENSE_KEY=[PREENCHER NO DOKPLOY]
LICENSE_ACCOUNT_IDENTITY=[e-mail exato da sua conta de compra]

# ---- WhatsApp — OPCIONAL: apenas o padrão do deployment. As conexões de
#      cada workspace são criadas em /integrations, com credenciais na UI ----
UAZAPI_BASE_URL=[OPCIONAL]
UAZAPI_TOKEN=[OPCIONAL, PREENCHER NO DOKPLOY]
WAHA_BASE_URL=[OPCIONAL]
WAHA_API_KEY=[OPCIONAL, PREENCHER NO DOKPLOY]
ZAPI_BASE_URL=[OPCIONAL]
ZAPI_INSTANCE_ID=[OPCIONAL]
ZAPI_TOKEN=[OPCIONAL, PREENCHER NO DOKPLOY]
NOD_API_BROKER_URL=[já vem preenchido no .env.example — só se tiver o add-on licenciado]

# ---- Gatilhos de conversão (sem estas quatro, "Nova regra" não aparece) ----
INBOUND_WEBHOOKS_ENABLED=true
INBOUND_WEBHOOK_ENCRYPTION_KEY=[GERAR — Base64 de 32 bytes]
INBOUND_CONVERSION_RULES_ENABLED=true
INBOUND_WEBHOOK_PRODUCTION_ENABLED=true

# ---- Meta ----
META_CONNECTION_MODES=manual
# Botão "Conectar Meta (PalmUP)". URL pública, NÃO é segredo nem App Secret.
PALMUP_META_BROKER_URL=[já vem preenchido no .env.example — https://wpptrack-api.rastrack.app]
META_APP_ID=[PREENCHER — só se usar App próprio]
# App Secret do app Meta. Obrigatório antes de ativar o envio automático
# em uma conexão Meta WhatsApp (Cloud API).
META_APP_SECRET=[PREENCHER NO DOKPLOY]
# Só para o webhook de Meta Ads (/webhooks/meta).
META_WEBHOOK_VERIFY_TOKEN=[GERAR]

# ---- Opcional ----
BRAND_NAME=[opcional]
BRAND_LOGO_URL=[opcional]
BRAND_PRIMARY_COLOR=[opcional, ex. #0F766E]
```

O web (Vercel ou serviço Dokploy separado) só precisa de uma variável: `NEXT_PUBLIC_API_URL=https://[SUA-API].seudominio.com` — ela é pública por definição (ver regra acima).
