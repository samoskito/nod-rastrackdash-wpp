# Atualizar uma instância que já está no ar

Saiu uma novidade no template (ex.: **Data Crazy** em Webhooks de entrada) e a sua instância do RastrackDash já está funcionando com clientes? Este é o guia. **Você não reinstala nada**: só puxa o código novo da `main`, deixa a API aplicar as migrations sozinha no boot e publica o web de novo.

> **Regra de mentor:** atualizar é **redeploy**, não instalação. Se em algum momento um passo pedir para criar banco novo, gerar segredo novo, recriar o administrador ou trocar a licença, **pare** — isso é instalação, não atualização, e apagaria o que já está rodando.

## Quando usar este guia

| Situação | Guia |
|---|---|
| Instância **já no ar** (API respondendo, você já loga, já tem workspace) e quer as novidades da `main` | **Este guia** |
| Primeira instalação, ainda sem banco/API/licença | [`dokploy.md`](dokploy.md) (ou [`local.md`](local.md) para testar) |
| Algo quebrou **depois** de atualizar | [`troubleshooting.md`](troubleshooting.md) — não reinstale para "resolver" |

O caminho recomendado é o mesmo da instalação: **API + PostgreSQL + Redis no Dokploy** e **web na Vercel**. Se você roda local com Docker Compose, veja a seção curta [Instalação local](#instalação-local-docker-compose) no fim.

## O que você NÃO recria (nunca)

Tudo isto já existe e continua valendo depois da atualização. Recriar qualquer item quebra a instância ou perde dados:

| Item | Por que não mexer |
|---|---|
| **Serviço PostgreSQL e o volume dele** | É onde vivem workspaces, leads, conexões, estado da licença. Banco novo = instância vazia. |
| **Administrador de plataforma** | Já está no banco. Não preencha de novo `SETUP_PLATFORM_ADMIN_PASSWORD` só porque está atualizando. |
| **`LICENSE_KEY` e `LICENSE_ACCOUNT_IDENTITY`** | Continuam os mesmos. Não peça chave nova à PalmUP para atualizar; a API revalida sozinha no boot. |
| **`INBOUND_WEBHOOK_ENCRYPTION_KEY`** | Os segredos das conexões de webhook de entrada foram cifrados com ela. Trocar = todas as URLs/tokens já colados nos provedores param de valer. |
| **`EXTERNAL_CONNECTOR_ENCRYPTION_KEY`, `META_TOKEN_ENCRYPTION_KEY`, `JWT_*`** | Mesma lógica: credenciais salvas deixam de ser lidas (e trocar `JWT_*` desloga todo mundo). |
| **Domínios (`API_PUBLIC_URL`, `WEB_ORIGIN`)** | Atualização não é hora de trocar domínio — receivers, cookies e a identificação da instância dependem deles. |

> **Sobre volumes:** a aba de volumes do **serviço da API** no Dokploy mostrando "No volumes"/"nenhum volume" é **normal** — a API não guarda dados em disco, e isso **não** significa que algo vai ser apagado. Os dados ficam no volume do **serviço PostgreSQL**. O que apaga dados é excluir o serviço PostgreSQL (ou o volume dele), não fazer redeploy da API.

## Antes de começar (5 minutos)

1. **Confira o que mudou.** Leia a seção `[Unreleased]` (ou a versão mais recente) do [`CHANGELOG.md`](../../CHANGELOG.md). Se a novidade pedir uma **variável de ambiente nova**, anote — ela entra no passo 2. Data Crazy, por exemplo, **não** pede env nova.
2. **Garanta um backup recente do PostgreSQL.** O Dokploy oferece backup para serviços de banco (o nome da tela varia por versão). Se você nunca configurou, faça um agora, antes do redeploy. Não é burocracia: é o seu "desfazer".
3. **Escolha um horário calmo.** O redeploy da API leva alguns minutos de build; durante a troca do container, webhooks podem receber erro e os provedores costumam reenviar.

## Passo 1 — Trazer o código novo

- **Dokploy apontando para o repositório público** `https://github.com/samoskito/nod-rastrackdash-wpp`, branch `main` (o caminho do [`dokploy.md`](dokploy.md)): nada a fazer aqui — o próximo deploy já clona a `main` atual.
- **Dokploy ou Vercel apontando para um fork seu:** primeiro sincronize o fork com o repositório público (no GitHub, a opção de sincronizar o fork com o upstream). Sem isso, o redeploy publica o **mesmo código antigo**.

**Validação:** a `main` que o seu deploy usa contém a novidade (ex.: o commit do Data Crazy aparece no histórico do repositório/fork).

## Passo 2 — Variáveis novas (só se o CHANGELOG pedir)

Se o passo "Antes de começar" apontou env nova, preencha **direto no painel de env do serviço da API no Dokploy** — nunca em arquivo commitado, nunca colando segredo em chat. Detalhe de cada variável em [`environment.md`](environment.md).

Não apague nem regenere as envs que já existem (veja [O que você NÃO recria](#o-que-você-não-recria-nunca)).

## Passo 3 — Redeploy da API (Dokploy)

No serviço da API, dispare um **novo deploy** (o mesmo botão de deploy usado na instalação). Não mude repositório, branch, Dockerfile nem diretório de build.

O que acontece, sem você rodar nada à mão:

1. O Dokploy clona a `main` e builda a imagem pelo `Dockerfile` da raiz.
   Para o painel indicar se esta instância acompanha a `main`, passe o SHA do commit como build arg `GIT_SHA` (por exemplo, `--build-arg GIT_SHA=<sha-do-commit>`; não é segredo). Use uma variável de build apenas se o seu provedor documentar que a disponibiliza: `$COMMIT` é um exemplo, não uma variável do Dokploy verificada por este guia.
2. Ao subir, o container executa:
   ```
   prisma migrate deploy && pnpm --filter @wpptrack/api start
   ```
   Ou seja, **as migrations novas são aplicadas no boot**, antes da API aceitar tráfego. Não existe serviço separado de migration e você **não** precisa (nem deve) rodar `prisma migrate deploy` manualmente contra produção.
3. A API revalida a licença sozinha no boot, com a mesma `LICENSE_KEY`.

**Validação:**

- Log de runtime mostra as migrations aplicadas (ou "no pending migrations") seguido do start da API, **sem reiniciar em loop**.
- ```bash
  curl -s https://sua-api.seudominio.com/health
  curl -s https://sua-api.seudominio.com/health/ready
  ```
  Ambos `200`, dependências `ok`.

Se o container entrar em crash-loop logo após as migrations, **não** reinstale e **não** apague o banco: vá para [Erro de migration](troubleshooting.md#erro-de-migration-prisma-migrate-deploydev) e [Dokploy: crash-loop](troubleshooting.md#dokploy-crash-loop-no-deploy-da-api).

## Passo 4 — Novo deploy do web (Vercel)

Faça o web **depois** da API — assim a tela nova já encontra a API nova.

- **Vercel:** crie um **novo deploy de produção a partir da `main`** atual. Se o projeto está ligado a um fork seu com deploy automático, sincronizar o fork (passo 1) já dispara o deploy; confirme que ele terminou.
- **Web no Dokploy:** redeploy do serviço do web.

Por que isso é obrigatório: telas novas (como a opção Data Crazy) só existem no build novo do web, e as variáveis `NEXT_PUBLIC_*` (ex.: `NEXT_PUBLIC_API_URL`) são embutidas **no build**. "Reiniciar" um deploy antigo não traz nada novo.

**Validação:** abra o web publicado, faça login normalmente, sem erro de CORS no console. Se o navegador mostrar a tela antiga, recarregue sem cache.

## Passo 5 — Verificação pós-atualização

1. Login com o seu administrador de sempre → `/backoffice/clients` abre (nada de cadastro novo).
2. `/backoffice` → checklist de onboarding continua completo.
3. `/backoffice/license` → licença **utilizável**.
4. `/integrations` → as conexões que já existiam continuam lá, com o status de antes.
5. Se você usa gatilhos: `/settings#whatsapp-triggers` continua mostrando suas origens e **Nova regra**.

### Exemplo: depois da atualização com Data Crazy

- Em `/integrations` → **Webhooks de entrada** → **Adicionar conexão**, a opção **Data Crazy** aparece na lista.
- Ao gerar o webhook, a conexão nasce **em observação** — é esperado. Ela só vai para produção depois de uma entrega **CTWA real** ser processada e o parser **Data Crazy v1** ser certificado no backoffice.
- Não existe canal/número provisório: o canal aparece sozinho após o primeiro webhook. E só mensagens inbound com **CTWA** viram lead.
- Passo a passo completo da conexão: [`whatsapp-providers.md`](whatsapp-providers.md#data-crazy--conexão-de-webhook-de-entrada-ctwa) e passo 10.2 do [Guia do Aluno](../GUIA-ALUNO.md#102-painel-webhooks-de-entrada--umbler-gupshup-data-crazy-e-meta-whatsapp-cloud-api).

Se **Webhooks de entrada** nem aparece, ou Data Crazy não está na lista, veja [Não apareceu Data Crazy / feature nova depois do merge](troubleshooting.md#não-apareceu-data-crazy--feature-nova-depois-do-merge).

## Se algo der errado

- **Fail-closed:** pare no primeiro passo que falhar e diagnostique em [`troubleshooting.md`](troubleshooting.md) antes de seguir. Não avance "torcendo para dar certo".
- **Não reinstale para corrigir.** Reinstalar = banco novo, admin novo, segredos novos → você perde clientes, conexões e históricos.
- **Não volte para uma versão antiga por conta própria** depois que as migrations rodaram: o banco já está no formato novo. Leve o log (sem segredos — troque valores sensíveis por `***`) para o suporte/comunidade e restaure o backup só com orientação.

## Instalação local (Docker Compose)

Se a sua instância é local ([`local.md`](local.md)):

```bash
git pull
pnpm install
pnpm --filter @wpptrack/api exec prisma migrate deploy --schema apps/api/prisma/schema.prisma
```

Depois reinicie `pnpm --filter @wpptrack/api dev` e `pnpm --filter @wpptrack/web dev`.

⚠️ **Nunca rode `docker compose down -v`** para "atualizar": o `-v` apaga o volume `postgres_data`, ou seja, o banco inteiro. Se precisar parar os containers, use `docker compose down` (sem `-v`) ou `docker compose stop`.

## Referência

- [Deploy com Dokploy](dokploy.md) · [Variáveis de ambiente](environment.md) · [Troubleshooting](troubleshooting.md)
- [Provedores de WhatsApp e webhooks de entrada](whatsapp-providers.md)
- [Guia do Aluno](../GUIA-ALUNO.md) · [Changelog](../../CHANGELOG.md)
