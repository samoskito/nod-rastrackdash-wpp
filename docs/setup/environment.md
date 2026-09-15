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
| `WPPTRACK_*_MS`, `WPPTRACK_EXTERNAL_SYNC_*`, `WPPTRACK_EXTERNAL_MYSQL_*` | Não (têm padrão) | Tuning de performance/timeout — mantenha o padrão salvo se tiver um motivo específico para ajustar | `.env` da API | Não |

## Gatilhos de conversão — obrigatórias no caminho do aluno

⚠️ **O padrão de todas as `INBOUND_*` é desligado (`false`/vazio).** Isso
significa que, mesmo com UAZAPI, NOD API, WAHA, Z-API ou outro provedor já
recebendo leads/webhooks, a tela **Gatilhos de conversão → Nova regra** não
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
| `INBOUND_CONVERSION_PRODUCTION_ENABLED` | Não — mantenha `false` a menos que você queira intencionalmente habilitar envio em produção | Fixo | `.env` da API | Não |
| `INBOUND_WEBHOOK_REPLAY_ENABLED` | Não — mantenha `false` a menos que precise reprocessar webhooks | Fixo | `.env` da API | Não |

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
7. Confirmar em `/settings#whatsapp-triggers` (depois de já existir uma conexão WhatsApp/origem) que **Nova regra** está disponível

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
workspace/cliente. Preencha `LICENSE_KEY`/`LICENSE_ACCOUNT_IDENTITY`, reinicie a
API e ative a licença (`POST /license-client/activate`) antes de criar seus
clientes. O cliente de licença só fica inerte (sem travar nada) quando
`LICENSE_SERVER_URL` está **vazio** — cenário de desenvolvimento local do
template, não de uso do produto.

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

## Meta Ads

| Variável | Obrigatória | Onde obter | Onde inserir | Secreto |
|---|---|---|---|---|
| `META_APP_ID` | Só se for usar integração Meta via App próprio | Meta for Developers | `.env` da API | Não |
| `META_APP_SECRET` | Idem | Meta for Developers | `.env` local / env do serviço | **Sim** |
| `META_CONNECTION_MODES` | Sim para o MVP do aluno | Defina exatamente `manual` | `.env` da API / env do serviço | Não |
| `META_GRAPH_API_VERSION` | Não (tem padrão) | Documentação Graph API | `.env` da API | Não |
| `META_TOKEN_ENCRYPTION_KEY` | Sim, antes de conectar qualquer token Meta | Você gera | `.env` local / env do serviço | **Sim** |
| `META_WEBHOOK_VERIFY_TOKEN` | Só se for usar webhooks Meta | Você define | `.env` local / env do serviço | **Sim** |
| `WPPTRACK_META_AUTO_SYNC_*` | Não (têm padrão) | Tuning do sync automático | `.env` da API | Não |
| `WPPTRACK_REPORT_TIMEZONE` | Não (tem padrão `America/Sao_Paulo`) | Seu fuso horário de relatório | `.env` da API | Não |

Defina `META_CONNECTION_MODES=manual` **antes** de configurar Meta e redeploy a API depois de alterar a env. No MVP do aluno não há login social Facebook nem OAuth como caminho alternativo: o token do usuário do sistema é informado por workspace na UI de **Integrações**, nunca em variável pública — veja [`meta-manual.md`](meta-manual.md).

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

Preencher `UAZAPI_*`/`WAHA_*`/`ZAPI_*`/`NOD_API_BROKER_URL` disponibiliza
**uma única instância daquele provedor para o deployment inteiro** — não
por workspace, e não existe UI para criar mais de uma (a própria tela de
Integrações avisa isso ao aluno). O único modelo genuinamente por
workspace/multi-instância neste template é a conexão de webhook inbound
(Umbler/Gupshup), criável em `/integrations`. O contrato completo de cada
provedor — inclusive quais têm webhook inbound confirmado hoje e quais
ainda são "a confirmar" — está em
[`whatsapp-providers.md`](whatsapp-providers.md) — leia antes de configurar.

| Variável | Obrigatória | Onde obter | Onde inserir | Secreto |
|---|---|---|---|---|
| `UAZAPI_BASE_URL`, `UAZAPI_TOKEN` | Só se usar `uazapi_byo` | Sua própria instância Uazapi | `.env` local / env do serviço | `UAZAPI_TOKEN` **sim** |
| `UAZAPI_WEBHOOK_AUTH_TOKEN` | Não — só se você optar pelo endpoint global legado `POST /webhooks/uazapi` | Você define | `.env` local / env do serviço | **Sim** |
| `WAHA_BASE_URL`, `WAHA_API_KEY` | Só se usar `waha` | Sua própria instância [WAHA](https://github.com/devlikeape/waha) self-hosted | `.env` local / env do serviço | `WAHA_API_KEY` **sim** |
| `WAHA_SESSION` | Não (padrão `default`) | Nome da sessão na sua instância WAHA | `.env` da API | Não |
| `ZAPI_BASE_URL`, `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN` | Só se usar `zapi` | Painel [Z-API](https://www.z-api.io/) | `.env` local / env do serviço | `ZAPI_TOKEN` **sim** |
| `DISCONNECT_ALERTS_ENABLED`, `DISCONNECT_ALERT_STREAK`, `DISCONNECT_ALERT_INTERVAL_MS` | Não (opcional) | Decisão sua | `.env` da API | Não |
| `OPS_ALERT_WEBHOOK_URL` | Só se `DISCONNECT_ALERTS_ENABLED=true` | Webhook do seu Slack/Discord/etc. | `.env` local / env do serviço | **Sim** (trate a URL como sensível — permite postar no seu canal) |

⚠️ **`UAZAPI_WEBHOOK_AUTH_TOKEN` é o segredo do endpoint global legado**
(`POST /webhooks/uazapi`, um único valor para toda a instância, não por
workspace). O endpoint continua existindo no código, mas tanto ele quanto
a rota por instância (`POST /webhooks/uazapi/instances/:instanceId`)
dependem de um registro `WhatsappInstance` já existente — e este template
**não tem, hoje, nenhum caminho confirmado (UI ou API) que crie esse
registro**. Preencher este token sozinho não resolve isso. Prefira a
conexão inbound genérica (Umbler/Gupshup), que é self-service e tem
segredo próprio rotacionável. Detalhes, o aviso completo e a matriz de
webhook em [`whatsapp-providers.md`](whatsapp-providers.md).

Nunca defina `UAZAPI_ADMIN_TOKEN` — essa variável não existe neste template e não deve ser reintroduzida (token de frota interno da PalmUP).

Não existem hoje variáveis de ambiente para Data Crazy ou Zap Responder —
esses dois provedores não têm adapter, parser nem contrato implementado
neste código (veja [`whatsapp-providers.md`](whatsapp-providers.md#data-crazy-e-zap-responder)); não invente valores para eles.

## NOD API broker

| Variável | Obrigatória | Onde obter | Onde inserir | Secreto |
|---|---|---|---|---|
| `NOD_API_BROKER_URL` | Só se usar o provedor `nod_api` (add-on licenciado) | Fornecido pela PalmUP (já vem preenchido no `.env.example`) | `.env` / env do serviço | Não |

O provedor `nod_api` autentica usando `LICENSE_KEY` + fingerprint da instância — não existe token administrativo separado para configurar aqui.

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

# ---- WhatsApp — preencha só o(s) provedor(es) que for usar ----
UAZAPI_BASE_URL=[PREENCHER]
UAZAPI_TOKEN=[PREENCHER NO DOKPLOY]
UAZAPI_WEBHOOK_AUTH_TOKEN=[GERAR]
WAHA_BASE_URL=[PREENCHER]
WAHA_API_KEY=[PREENCHER NO DOKPLOY]
ZAPI_BASE_URL=[PREENCHER]
ZAPI_INSTANCE_ID=[PREENCHER]
ZAPI_TOKEN=[PREENCHER NO DOKPLOY]
NOD_API_BROKER_URL=[já vem preenchido no .env.example — só se tiver o add-on licenciado]

# ---- Meta Ads — só se for usar App próprio ----
META_APP_ID=[PREENCHER]
META_APP_SECRET=[PREENCHER NO DOKPLOY]
META_WEBHOOK_VERIFY_TOKEN=[GERAR]
META_CONNECTION_MODES=manual

# ---- Opcional ----
BRAND_NAME=[opcional]
BRAND_LOGO_URL=[opcional]
BRAND_PRIMARY_COLOR=[opcional, ex. #0F766E]
```

O web (Vercel ou serviço Dokploy separado) só precisa de uma variável: `NEXT_PUBLIC_API_URL=https://[SUA-API].seudominio.com` — ela é pública por definição (ver regra acima).
