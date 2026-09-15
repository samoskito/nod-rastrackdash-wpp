# Guia do aluno — da compra ao primeiro workspace

Esta é a jornada completa: da compra da licença até ter clientes reais operando dentro da sua instância do RastrackDash. Se preferir ser guiado por uma IA passo a passo, use o [prompt oficial de onboarding com IA](AI_ONBOARDING_PROMPT.pt-BR.md) — ele segue exatamente esta mesma ordem.

## Papéis (não confundir)

- **PalmUP** — dona do produto-base, emite e opera o servidor privado de licenças e, opcionalmente, o broker NOD API.
- **Aluno (você)** — comprou a licença, hospeda esta instância e a administra.
- **Cliente do aluno** — a empresa final, criada como *workspace* dentro do seu painel. Não é cliente direto da PalmUP neste template.

## 1. Compra e licença

1. Receba da PalmUP a chave de licença (`LICENSE_KEY`) por e-mail e/ou WhatsApp após a compra.
2. Anote o e-mail da sua conta de compra — ele vai virar `LICENSE_ACCOUNT_IDENTITY` e **precisa ser idêntico** ao vinculado na PalmUP; um valor diferente faz a ativação retornar `403`.
3. Leia o [README do aluno](../README.pt-BR.md) para confirmar os papéis acima antes de seguir.

## 2. Escolha o caminho de instalação

| Caminho | Quando escolher |
|---|---|
| **Local (Docker Compose)** — [`setup/local.md`](setup/local.md) | Conhecer o produto, testar, homologar antes de decidir a VPS |
| **VPS com Dokploy** — [`setup/dokploy.md`](setup/dokploy.md) | Deploy real, com clientes de verdade acessando |

A arquitetura recomendada para produção é **Vercel para o web** + **Dokploy em uma VPS para API, PostgreSQL e Redis**. Antes de contratar a VPS, dimensione com [`setup/vps.md`](setup/vps.md) (pergunta: quantos workspaces e leads/dia).

Você pode seguir o caminho local primeiro e migrar para Dokploy depois — os passos de produto (3 em diante) são os mesmos nos dois caminhos.

## 3. Clonar, instalar e configurar o ambiente

1. Clone o repositório e instale Node.js 20+, pnpm, Docker e Docker Compose (só necessário para o caminho local).
2. Execute `pnpm setup -- --dry-run` para revisar o que será feito, depois `pnpm setup` — ele copia o `.env`, instala dependências, gera o client do Prisma e roda as migrations.
3. Revise o `.env` criado: preencha os placeholders `replace-me-*` e as variáveis dos serviços que você vai usar. A tabela completa, com o que é obrigatório/opcional, onde obter cada valor e o que é secreto, está em [`setup/environment.md`](setup/environment.md). **Nunca versione o `.env`.**

No caminho Dokploy, as mesmas variáveis vão direto no formulário de env do serviço na VPS, nunca em um arquivo commitado — veja [`setup/dokploy.md`](setup/dokploy.md) passo a passo.

## 4. Banco de dados (PostgreSQL + Redis) e migrations

- **Local:** `docker compose up -d postgres redis` sobe Postgres 16 e Redis 7 com as credenciais de desenvolvimento do `docker-compose.yml`.
- **Dokploy:** crie dois serviços de banco gerenciados (PostgreSQL e Redis) com volume persistente, e monte `DATABASE_URL`/`REDIS_URL` a partir do host interno que o Dokploy expõe.

As migrations do Prisma rodam automaticamente pelo `pnpm setup` (local) ou pelo `CMD` do `Dockerfile` a cada deploy (Dokploy). Manualmente: `pnpm --filter @wpptrack/api exec prisma migrate deploy --schema apps/api/prisma/schema.prisma`.

## 5. API e web no ar

- **Local:** `pnpm --filter @wpptrack/api dev` e `pnpm --filter @wpptrack/web dev` em terminais separados. Padrões: API em `http://localhost:3333`, web em `http://localhost:3000`.
- **Dokploy + Vercel:** deploy do serviço da API na VPS (build a partir do `Dockerfile` do repositório) e do `apps/web` na Vercel (ou também no Dokploy), com `NEXT_PUBLIC_API_URL` apontando para a URL pública da API.

**Verificação de saúde**, nos dois caminhos: `GET /health` e `GET /health/ready` devem responder OK antes de seguir.

## 6. Primeiro administrador de plataforma

O caminho oficial e único para criar o primeiro `platform_owner` (acesso a `/backoffice/clients`) é o bootstrap por variáveis de ambiente da API — não existe script de terminal, allowlist de e-mail ou cadastro público que conceda esse papel.

1. Defina **`SETUP_PLATFORM_ADMIN_EMAIL`** e **`SETUP_PLATFORM_ADMIN_PASSWORD`** juntas no ambiente da API — no `.env` local ou no painel de variáveis de ambiente do serviço da API no Dokploy (nunca commitadas, nunca coladas em chat).
2. Faça (re)deploy da API — local: reinicie `pnpm --filter @wpptrack/api dev`; Dokploy: redeploy do serviço. O bootstrap roda automaticamente no boot seguinte, antes da API aceitar conexões, e cria a conta `platform_owner` **sem workspace nenhum**.
3. Logue no web com esse e-mail/senha e confirme que abre `/backoffice/clients`. Se cair em `/overview`, o bootstrap não rodou como esperado — veja [`setup/troubleshooting.md`](setup/troubleshooting.md#login-abre-overview-em-vez-de-backofficeclients) antes de tentar de novo.
4. Crie o primeiro workspace/cliente em `/backoffice/clients` (detalhado no passo 8) — o bootstrap cria só a conta de plataforma, nunca um workspace.
5. Depois de confirmar o primeiro login, **remova `SETUP_PLATFORM_ADMIN_PASSWORD`** do ambiente (ou limpe o valor) e faça um novo (re)deploy/restart da API — sem a senha preenchida, o bootstrap simplesmente para de rodar a cada boot; é seguro remover e evita deixar uma senha em texto plano no painel.

Detalhe completo do mecanismo (idempotência, promoção de conta já existente com `SETUP_PLATFORM_ADMIN_CONFIRM_EXISTING=true`) em [`setup/environment.md`](setup/environment.md#bootstrap-do-primeiro-administrador-por-env--caminho-oficial); passo a passo em Dokploy no passo 13 de [`setup/dokploy.md`](setup/dokploy.md).

⚠️ `WPPTRACK_PLATFORM_ADMIN_EMAILS` e `AUTH_PUBLIC_REGISTRATION_ENABLED=true` **não concedem** papel de plataforma no código atual — não são caminhos alternativos para o primeiro administrador, mesmo que pareçam funcionar para outra coisa.

### Conta de workspace (opcional, ambiente local)

Isso é diferente de conta de plataforma: se você quiser testar, no seu ambiente local, uma conta comum de cliente/workspace (sem acesso a `/backoffice/clients`), use:

```bash
pnpm --filter @wpptrack/api create-user -- --email voce@suaagencia.com --password 'uma-senha-forte' --role owner
```

Esse comando cria a conta **e** um workspace, com você como `owner` dele (`pnpm setup` também oferece esse passo automaticamente se `SETUP_ADMIN_EMAIL`/`SETUP_ADMIN_PASSWORD`, sem "PLATFORM" no nome, estiverem definidas antes de rodá-lo). Ele se recusa a criar/alterar qualquer conta que já tenha papel de plataforma — não é um caminho para o primeiro `platform_owner` acima (veja [`setup/local.md`](setup/local.md#5-primeiro-administrador)).

## 7. Ativar a licença

1. Preencha `LICENSE_SERVER_URL` (já vem no `.env.example`), `LICENSE_KEY` e `LICENSE_ACCOUNT_IDENTITY` — sempre em `.env` local ou env do serviço, nunca commitado.
2. Reinicie a API e ative a licença: `POST /license-client/activate` (rota liberada mesmo com a instância bloqueada; a chave sai do `.env`, você não cola nada em chat).
3. Abra `/backoffice/license` e confirme que a licença aparece como **utilizável**.
4. Se ver `403`, confira se `LICENSE_ACCOUNT_IDENTITY` é exatamente o e-mail vinculado à sua compra ([`setup/troubleshooting.md`](setup/troubleshooting.md)).

Sem licença ativa a instância fica **bloqueada para escrita** (`423`): você consegue logar e navegar, mas não criar workspace/cliente no passo 8. Ative antes de seguir.

## 8. Primeiro workspace (cliente)

Logue com o administrador criado, crie seu primeiro workspace para um cliente final e confirme o checklist em `/backoffice` (banco conectado, licença utilizável, Meta conectado, ao menos um workspace — também disponível via `GET /onboarding/status`).

**SMTP é opcional aqui.** Ao criar o workspace em `/backoffice/clients`, decida se você quer configurar SMTP agora (para o responsável receber um e-mail automático de ativação) ou deixar para depois — o workspace é criado da mesma forma nos dois casos. Sem `EMAIL_PROVIDER=smtp`/`SMTP_*` preenchidos (veja [`setup/environment.md`](setup/environment.md#e-mail-smtp-byo)), ou se o envio falhar, a tela mostra que é preciso gerar o link manual: use o botão de gerar link de ativação na lista de workspaces e envie você mesmo (WhatsApp, e-mail avulso etc.) para o responsável. Nenhum segredo real é necessário só para testar o fluxo — sem SMTP configurado, o link manual sempre funciona.

## 9. Conectar Meta Ads

Siga o [guia manual de Meta](setup/meta-manual.md): criar/usar um usuário do sistema no Gerenciador de Negócios do cliente, gerar um token e colá-lo na UI de **Integrações** do workspace — nunca em `.env` público nem em chat.

## 10. Conectar WhatsApp

Escolha ao menos um provedor e configure as variáveis correspondentes (tabela em [`setup/environment.md`](setup/environment.md)). Antes de decidir, leia [`setup/whatsapp-providers.md`](setup/whatsapp-providers.md) — o contrato completo de cada um, inclusive quais já têm webhook inbound confirmado e quais ainda não:

- **Uazapi BYO** — sua própria instância Uazapi (`UAZAPI_*`). ⚠️ É **uma única instância para todo o deployment**, não por workspace — a própria tela de Integrações avisa isso; não existe passo de "criar instância" separado.
- **NOD API** — broker gerenciado pela PalmUP, add-on licenciado (`NOD_API_BROKER_URL`, usa a `LICENSE_KEY`); mesmo escopo de instância única acima.
- **WAHA** — sua própria instância self-hosted [WAHA](https://github.com/devlikeape/waha) (`WAHA_*`); mesmo escopo de instância única.
- **Z-API** — sua própria instância [Z-API](https://www.z-api.io/) (`ZAPI_*`); mesmo escopo de instância única.
- **Umbler / Gupshup** — este sim é por workspace de verdade: conexão de webhook inbound genérica, criada em `/integrations`, com segredo próprio por conexão (não têm variável de ambiente).
- **Data Crazy / Zap Responder** — ainda **não implementados** neste código (nenhum adapter, parser ou variável) — não tente configurá-los agora.

Preencher `UAZAPI_*`/`WAHA_*`/`ZAPI_*`/`NOD_API_BROKER_URL` só disponibiliza aquele provedor (uma instância única do deployment todo) no backend — não cria nada por workspace. Só a conexão de webhook inbound (Umbler/Gupshup) é criada por workspace em `/integrations`. Confirme depois em `/integrations` que o provedor escolhido aparece `connected`.

⚠️ **Gatilhos de conversão (`Nova regra`) exigem envs próprias da API, desligadas por padrão.** Isso vale para **qualquer origem** que use gatilhos (UAZAPI, NOD API, WAHA, Z-API, Umbler, Gupshup, etc.). Sem essas envs, leads/webhooks podem chegar normalmente e mesmo assim `Gatilhos de conversão → Nova regra` não aparece. Checklist do mentor, direto na env da API (Dokploy):

1. `INBOUND_WEBHOOKS_ENABLED=true`
2. `INBOUND_WEBHOOK_ENCRYPTION_KEY=<gere com: node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))">`
3. `INBOUND_CONVERSION_RULES_ENABLED=true`
4. `INBOUND_WEBHOOK_PRODUCTION_ENABLED=true` (obrigatório em produção)
5. Redeploy da API
6. Confirme em `/settings#whatsapp-triggers` (com a conexão WhatsApp/origem já criada) que **Nova regra** aparece disponível

Detalhe completo de cada variável em [`setup/environment.md`](setup/environment.md#gatilhos-de-conversão--obrigatórias-no-caminho-do-aluno).

## 11. Marca (whitelabel) — opcional

Defina `BRAND_NAME`, `BRAND_LOGO_URL`, `BRAND_FAVICON_URL`, `BRAND_PRIMARY_COLOR` para personalizar sua agência (veja [`../docs/CUSTOMIZATION.md`](CUSTOMIZATION.md)). O rodapé residual **`RastrackDash · powered by PalmUP`** é fixo e não pode ser removido nem escondido, com ou sem essas variáveis.

## 12. Verificações pós-deploy

Repita, no ambiente publicado (não só localmente):

- `GET /health` e `GET /health/ready` → OK
- `/backoffice` → checklist completo
- `/backoffice/license` → licença utilizável
- `/integrations` → Meta e ao menos um provedor de WhatsApp conectados
- Se usou Dokploy: sem crash-loop no log do serviço da API ([`setup/troubleshooting.md`](setup/troubleshooting.md) tem o roteiro de diagnóstico)

## Referência rápida

- [Prompt oficial de onboarding com IA](AI_ONBOARDING_PROMPT.pt-BR.md)
- [Índice de guias de instalação](setup/README.md)
- [Local (Docker Compose)](setup/local.md) · [VPS — dimensionamento](setup/vps.md) · [Deploy com Dokploy](setup/dokploy.md)
- [Variáveis de ambiente](setup/environment.md) · [Troubleshooting](setup/troubleshooting.md)
- [Meta manual](setup/meta-manual.md) · [Provedores de WhatsApp (BYO)](setup/whatsapp-providers.md) · [Cobrança BYO](setup/billing/README.md)
- [Personalização permitida](CUSTOMIZATION.md)
- [Matriz de aceite v1](release/ACCEPTANCE-v1.pt-BR.md) — o que já foi verificado nesta versão

## O que este template não faz por você

Este template não cria automaticamente sua conta na Meta, sua instância de provedor WhatsApp, o servidor de licenças PalmUP nem cobrança privada da PalmUP — são serviços externos que você configura ou contrata separadamente. Veja [`setup/dokploy.md`](setup/dokploy.md#o-que-este-template-não-recria) para a lista completa do que nunca deve ser recriado no seu deploy.
