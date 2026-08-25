# Setup local (Docker Compose)

Caminho recomendado para desenvolver, homologar ou apenas conhecer o RastrackDash na sua máquina antes de decidir sobre um deploy em VPS. Cobre Postgres/Redis via Docker Compose, `.env`, migrations, subida da API e do web, e as verificações locais.

## Pré-requisitos

- Node.js 20+
- pnpm (`corepack enable` já ativa a versão fixada em `package.json`)
- Docker e Docker Compose

Verifique:

```bash
node --version
pnpm --version
docker --version
docker compose version
```

## 1. Clonar e instalar

```bash
git clone <url-do-seu-fork-ou-repo> rastrackdash
cd rastrackdash
pnpm install
```

**Validação:** `pnpm install` termina sem erro e cria `node_modules/`.

## 2. Subir Postgres e Redis

O `docker-compose.yml` na raiz sobe Postgres 16 e Redis 7 com credenciais de desenvolvimento (`rastrackdash`/`rastrackdash`, banco `rastrackdash`).

```bash
docker compose up -d postgres redis
docker compose ps
```

**Validação:** os dois serviços aparecem `running`/`healthy` em `docker compose ps`.

## 3. Configurar o `.env`

Prefira o script de setup, que copia `.env.example` para `.env` de forma idempotente e mostra os próximos passos:

```bash
pnpm setup -- --dry-run   # revisa o que seria feito, sem executar nada
pnpm setup                # copia .env, instala deps, gera Prisma client, roda migrations
```

Se preferir manualmente:

```bash
cp .env.example .env
```

Abra o `.env` e preencha, no mínimo, os placeholders `replace-me-*` com valores aleatórios locais (podem ser gerados com `openssl rand -hex 32`, por exemplo) e confirme `DATABASE_URL`/`REDIS_URL` (os valores padrão do `.env.example` já casam com o `docker-compose.yml` acima). Para a tabela completa de variáveis, use [`environment.md`](environment.md).

**Nunca versione o `.env`.** Ele já está no `.gitignore`.

**Validação:** `test -f .env` e nenhum `replace-me-` restante nas variáveis que você pretende usar (`grep replace-me .env`).

## 4. Migrations do Prisma

Se você já rodou `pnpm setup` sem `--dry-run`, este passo foi feito automaticamente. Manualmente:

```bash
pnpm --filter @wpptrack/api prisma:generate
pnpm --filter @wpptrack/api exec prisma migrate deploy --schema apps/api/prisma/schema.prisma
```

**Validação:** o comando termina com "All migrations have been successfully applied" (ou equivalente) e sem erro de conexão.

## 5. Primeiro administrador

```bash
pnpm --filter @wpptrack/api create-user -- --email voce@suaagencia.com --password 'uma-senha-forte' --role owner
```

O `pnpm setup` também oferece esse passo automaticamente se as variáveis `SETUP_ADMIN_EMAIL`/`SETUP_ADMIN_PASSWORD` estiverem definidas no ambiente antes de rodá-lo.

**Validação:** o comando retorna sucesso (sem imprimir a senha) e você consegue logar depois com esse e-mail.

## 6. Subir API e web

Em dois terminais separados:

```bash
pnpm --filter @wpptrack/api dev
```

```bash
pnpm --filter @wpptrack/web dev
```

Padrões: web em `http://localhost:3000`, API em `http://localhost:3333` (`API_PORT` no `.env`).

**Validação:**

```bash
curl -s http://localhost:3333/health
curl -s http://localhost:3333/health/ready
```

Ambos devem responder com status HTTP 200/JSON de saúde (`/health/ready` retorna 503 se banco/Redis não estiverem prontos — releia o passo 2 se isso acontecer).

## 7. Verificação completa no navegador

1. Logue com o admin criado no passo 5.
2. Abra `/backoffice` e confira o checklist de onboarding (banco, licença, Meta, workspace).
3. Abra `/backoffice/license` — com `LICENSE_SERVER_URL` preenchido e sem ativação, a instância fica **bloqueada para escrita** (`423`) e a página mostra o que fazer. Preencha `LICENSE_*` (veja [`environment.md`](environment.md)), reinicie a API, ative a licença e confirme "utilizável":

   ```bash
   curl -s -X POST http://localhost:3333/license-client/activate \
     -H 'content-type: application/json' -d '{}'
   ```

   (a rota de ativação continua liberada durante o bloqueio; a chave sai do `.env`, nunca do corpo do comando em chat)
4. Abra `/integrations` para conectar Meta ([`meta-manual.md`](meta-manual.md)) e um provedor de WhatsApp.

## Próximos passos

- Variáveis de ambiente em detalhe: [`environment.md`](environment.md)
- Deploy em VPS com Dokploy: [`dokploy.md`](dokploy.md)
- Algo deu errado? [`troubleshooting.md`](troubleshooting.md)
