# Setup em VPS com Dokploy

Passo a passo para levar a API, o PostgreSQL e o Redis do RastrackDash para uma VPS usando [Dokploy](https://dokploy.com) como PaaS. Este guia não inventa rótulos exatos de tela — o Dokploy muda a UI entre versões — mas descreve os **conceitos** que qualquer versão recente cobre, para você reconhecer a opção certa mesmo que o texto do botão seja diferente.

Antes de começar, dimensione a máquina com [`vps.md`](vps.md) (RAM/CPU conforme workspaces e leads/dia).

## Arquitetura recomendada

- **Vercel** para `apps/web` (Next.js) — mais simples, CDN e HTTPS automáticos.
- **VPS + Dokploy** para `apps/api` (NestJS), PostgreSQL e Redis.

Você pode rodar o web também na VPS via Dokploy se preferir; os passos de API/banco/Redis abaixo não mudam.

## 0. Pré-requisitos

- VPS com Dokploy instalado (2 GB RAM é o piso só do Dokploy; siga [`vps.md`](vps.md) para o piso real do produto).
- Domínio (ou subdomínio) que você controla, para apontar à API e, se quiser, ao web.
- Repositório acessível pelo Dokploy (Git remoto, ou build local + registry, conforme sua configuração de Dokploy).

## 1. Criar o projeto e o serviço da API

1. No painel do Dokploy, crie um **projeto** novo para o RastrackDash.
2. Dentro dele, crie um **serviço de aplicação** apontando para este repositório e para o `Dockerfile` na raiz (build multi-stage já preparado para `apps/api`).
3. Configure o **build** para usar o `Dockerfile` do repositório (não é necessário customizar comandos — o Dockerfile já roda `prisma generate`, build do `@wpptrack/shared` e do `@wpptrack/api`).

**Validação:** o serviço aparece criado no projeto, ainda sem deploy bem-sucedido (esperado neste ponto — faltam banco, Redis e envs).

## 2. Criar PostgreSQL e Redis como serviços gerenciados

No mesmo projeto, crie dois **serviços de banco de dados** gerenciados pelo Dokploy (não containers avulsos que você mesmo cuida):

- Um serviço **PostgreSQL** (a versão usada pelo produto é a 16 — veja `docker-compose.yml` para referência local).
- Um serviço **Redis** (versão 7 usada localmente).

Ao criar cada um, o Dokploy gera (ou permite definir) usuário, senha e nome do banco/instância. Anote **onde esses valores ficam guardados na própria UI do Dokploy** — normalmente cada serviço de banco mostra uma tela de "conexão"/"credenciais" com host interno, porta, usuário, senha e nome do banco. Você vai usá-los no próximo passo, mas nunca precisa copiá-los para fora do painel do Dokploy além de colar na env da API.

Conceitos que valem para qualquer versão do Dokploy:

- **Host interno**: dentro da rede do Dokploy, o serviço da API se conecta ao banco pelo nome interno do serviço (não por IP público) — normalmente algo como `<nome-do-servico>` ou um hostname interno mostrado na tela de conexão do banco.
- **Porta**: Postgres `5432`, Redis `6379`, salvo se você mudou explicitamente.
- **Persistência (volume)**: confirme que o serviço de banco tem um **volume persistente** anexado antes de colocar dados reais — sem isso, um redeploy pode apagar o banco. Todo serviço de banco gerenciado pelo Dokploy deveria oferecer essa opção por padrão; confirme na tela do serviço.

**Validação:** os dois serviços de banco de dados aparecem com status "rodando"/"saudável" no painel, com um volume persistente listado.

## 3. Variáveis de ambiente da API

No serviço da API, abra a seção de **variáveis de ambiente** e preencha a partir do seu `.env` local validado (veja [`environment.md`](environment.md) para a tabela completa). No mínimo:

- `DATABASE_URL` — monte com host interno/porta/usuário/senha/nome do banco do passo 2 (`postgresql://usuario:senha@host-interno:5432/nome-do-banco`).
- `REDIS_URL` — mesma lógica (`redis://host-interno:6379`).
- `NODE_ENV=production`
- `API_PORT` (ou deixe o padrão do Dockerfile/env) e `API_PUBLIC_URL` com a URL pública que você vai apontar para este serviço.
- `WEB_ORIGIN` com a URL pública do seu frontend (Vercel ou Dokploy), para CORS.
- Segredos gerados (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `EXTERNAL_CONNECTOR_ENCRYPTION_KEY`, `META_TOKEN_ENCRYPTION_KEY`, e demais `replace-me-*`) — gere valores novos para produção, não reuse os de desenvolvimento local.
- `LICENSE_SERVER_URL`, `LICENSE_KEY`, `LICENSE_ACCOUNT_IDENTITY` — preencha `LICENSE_KEY` direto no campo de env do Dokploy, nunca em um arquivo versionado.
- Provedores de WhatsApp que você for usar (`UAZAPI_*`, `WAHA_*`, `ZAPI_*`, `NOD_API_BROKER_URL`).

**Nunca** cole esses valores em um `.env` commitado no repositório nem em um chat de IA — preencha direto no formulário do Dokploy.

**Validação:** todas as variáveis obrigatórias de [`environment.md`](environment.md) estão preenchidas no serviço (sem `replace-me-*` restante).

## 4. Deploy e ordem de migrations

Dispare o deploy da API. O `CMD` do `Dockerfile` já roda `prisma migrate deploy` automaticamente antes de iniciar o processo (`pnpm --dir apps/api exec prisma migrate deploy ... && pnpm --filter @wpptrack/api start`), então a ordem correta é: **banco e Redis no ar primeiro, depois o deploy da API** — nessa ordem as migrations aplicam sozinhas a cada deploy.

**Validação:** o log de deploy mostra as migrations sendo aplicadas (ou "no pending migrations") seguido da mensagem de start da API, sem o container reiniciar em loop.

## 5. Domínio e HTTPS

Configure o domínio/subdomínio da API no serviço (Dokploy normalmente integra com Let's Encrypt via Traefik para HTTPS automático — confirme a opção equivalente na sua versão). Aponte o DNS do domínio para o IP da VPS antes de pedir o certificado.

**Validação:**

```bash
curl -s https://sua-api.seudominio.com/health
curl -s https://sua-api.seudominio.com/health/ready
```

## 6. Deploy do web

- **Vercel (recomendado):** conecte o repositório, aponte o diretório `apps/web`, defina `NEXT_PUBLIC_API_URL=https://sua-api.seudominio.com` nas envs do projeto Vercel.
- **Dokploy:** crie um segundo serviço de aplicação apontando para `apps/web`, com a mesma variável `NEXT_PUBLIC_API_URL` e domínio/HTTPS próprios.

Depois de publicado, volte na env `WEB_ORIGIN` da API (passo 3) e confirme que aponta para essa URL pública do web — CORS depende disso.

**Validação:** abrir a URL pública do web carrega a tela de login sem erro de CORS no console do navegador.

## 7. Verificação pós-deploy

1. Logue no web publicado.
2. `/backoffice` → checklist de onboarding completo.
3. `/backoffice/license` → licença "utilizável" (depende do passo 3 com `LICENSE_*` corretos).
4. `/integrations` → Meta ([`meta-manual.md`](meta-manual.md)) e ao menos um provedor de WhatsApp conectados.
5. `GET https://sua-api.../health/ready` → `200`.

## Diagnóstico de crash-loop

Se o container da API reinicia repetidamente:

1. Veja os logs do serviço no painel do Dokploy — a causa quase sempre aparece nas primeiras linhas após "Bootstrapping".
2. Causas comuns:
   - `DATABASE_URL`/`REDIS_URL` errados ou apontando para host externo em vez do host interno do Dokploy → o container falha ao conectar e sai.
   - `prisma migrate deploy` falhou por schema divergente ou banco inacessível no boot → sem migrations aplicadas, a API não sobe.
   - Falta de memória durante o build (veja o piso de RAM em [`vps.md`](vps.md)) derruba o host inteiro, não só o container.
   - Variável obrigatória ausente causa um `throw` no boot (ex.: `API_PORT` inválido) — confira [`environment.md`](environment.md).
3. Corrija a variável/serviço apontado, redeploy, e repita a validação do passo 4.

Mais cenários: [`troubleshooting.md`](troubleshooting.md).

## O que este template não recria

- O **servidor de licenças privado da PalmUP** é externo (`LICENSE_SERVER_URL` aponta para ele) — não crie um serviço para "hospedar a licença" no seu Dokploy.
- **Guru** (checkout) e **Asaas** (split/cobrança da PalmUP) são serviços privados da PalmUP — não recrie nada equivalente no seu projeto público. Cobrança do **seu** cliente final, se você quiser, é BYO — veja [`billing/README.md`](billing/README.md).
- O broker **NOD API** (`nod_api`) é um serviço PalmUP privado acessado via `NOD_API_BROKER_URL` — você não hospeda essa parte, só configura a env se tiver o add-on licenciado.
