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

No serviço da API, dispare um **novo deploy** (o mesmo botão de deploy usado na instalação). Não mude repositório, branch, Dockerfile, diretório de build, comando de execução (Run Command), build args nem volumes.

O que acontece, sem você rodar nada à mão:

1. O Dokploy clona a `main` e builda a imagem pelo `Dockerfile` da raiz. Durante o build, a imagem registra sozinha qual commit foi instalado (linha `build identity:` no log de build) — você **não** informa SHA nenhum. Detalhes em [Versão instalada](#versão-instalada).
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
6. Se você envia conversões para a Meta: faça o passo de [Conversões Meta depois desta atualização](#conversões-meta-depois-desta-atualização-trocar-token) **antes** de conferir os eventos.
7. Versão instalada conferida como em [Conferir depois do deploy](#conferir-depois-do-deploy).

### Exemplo: depois da atualização com Data Crazy

- Em `/integrations` → **Webhooks de entrada** → **Adicionar conexão**, a opção **Data Crazy** aparece na lista.
- Ao gerar o webhook, a conexão nasce **em observação** — é esperado. Ela só vai para produção depois de uma entrega **CTWA real** ser processada e o parser **Data Crazy v1** ser certificado no backoffice.
- Não existe canal/número provisório: o canal aparece sozinho após o primeiro webhook. E só mensagens inbound com **CTWA** viram lead.
- Passo a passo completo da conexão: [`whatsapp-providers.md`](whatsapp-providers.md#data-crazy--conexão-de-webhook-de-entrada-ctwa) e passo 10.2 do [Guia do Aluno](../GUIA-ALUNO.md#102-painel-webhooks-de-entrada--umbler-gupshup-data-crazy-e-meta-whatsapp-cloud-api).

Se **Webhooks de entrada** nem aparece, ou Data Crazy não está na lista, veja [Não apareceu Data Crazy / feature nova depois do merge](troubleshooting.md#não-apareceu-data-crazy--feature-nova-depois-do-merge).

## Conversões Meta depois desta atualização (Trocar token)

Nesta versão, **todo** envio de conversão para a Meta (inclusive o **LeadSubmitted** automático e o que vem do Kommo) passa a usar a mesma estrutura: **Integrações → Tokens, BMs e destinos**. Foi uma mudança do produto feita pela PalmUP — **você não quebrou nada na Meta**.

O que você pode ver se pular este passo: em **Auditoria de conversoes** (`/events`), o LeadSubmitted aparece como **Bloqueado**, com "Destino Meta ainda nao configurado" e "A conexao Meta precisa ser refeita". Isso acontece **mesmo com o painel parecendo perfeito** (estrutura **Ativa**, pixel e página escolhidos, rotas automáticas ligadas). O painel está certo; só falta regravar o token uma vez.

### Se você já tem uma estrutura em Tokens, BMs e destinos

Uma ação só: **regravar o mesmo token no card que já existe**.

1. Abra `/integrations` → **Tokens, BMs e destinos**.
2. **Não** clique em **+ Nova conexao**.
3. **Não** apague a estrutura (ícone de lixeira, **Remover estrutura**).
4. No card do BM que já está lá, clique no ícone de **chave** (**Trocar token**).
5. Cole o **mesmo** token permanente que você já usa e clique em **Validar troca**.

Pronto. Continuam os mesmos: BM, conta de anúncios, pixel, página e destinos. Colar o mesmo token **não** cria um segundo BM — ele só atualiza a credencial guardada naquele card.

Só gere um token **novo** na Meta se ela recusar o atual ao validar. Mesmo nesse caso, cole o token novo pelo **Trocar token** do mesmo card — nunca por **+ Nova conexao**.

### Se você ainda usava o caminho antigo (versão Alpha / só login social)

A partir desta versão, o envio de conversões **não** usa mais o caminho antigo da Alpha. Ele usa **Tokens, BMs e destinos**.

1. Abra `/integrations` → **Tokens, BMs e destinos**.
2. **Já aparece um card do seu BM?** Faça o [Trocar token](#se-você-já-tem-uma-estrutura-em-tokens-bms-e-destinos) acima, com o mesmo token.
3. **A lista está vazia?** Aí sim, crie a estrutura pela primeira vez seguindo o [guia de Meta Ads](meta-manual.md): token do usuário do sistema, BM, conta de anúncios, pixel e página.

### Eventos que já ficaram "Bloqueado"

Os LeadSubmitted que ficaram **Bloqueado** antes do Trocar token **não voltam sozinhos**. Você mesmo reenvia, pelo painel, em três passos e nesta ordem:

1. Faça o **Trocar token** acima (se ainda não fez). Reenviar antes disso só bloqueia de novo.
2. **Atualize a instância** para a versão mais recente do template — API **e** web ([Passo 1](#passo-1--trazer-o-código-novo) ao [Passo 5](#passo-5--verificação-pós-atualização) deste guia). O botão de reenvio só existe a partir desta atualização: numa instância antiga, os eventos bloqueados continuam sem reenvio.
3. Abra **Auditoria de conversoes** (`/events`), escolha em **Inicio**/**Fim** um período que cubra **desde quando** os eventos ficaram bloqueados, clique em **Aplicar** e depois em **Reenviar bloqueados** (ao lado de "Eventos do periodo").

O que esperar:

- Só o **owner** do workspace vê o botão. Membro vê a lista, mas não reenvia.
- O reenvio respeita o período e os filtros que estão na tela, e vai até **500 eventos por clique**. Tem mais que isso? Clique de novo.
- O painel mostra a contagem real: quantos foram para a fila, quantos **já não estavam bloqueados** (ficaram de fora) e quantos não puderam entrar na fila agora (tente de novo em instantes).
- Evento já **Enviado** nunca é reenviado — não há risco de duplicar conversão na Meta.
- Quer reenviar um evento só? Na linha dele, use o botão **Reenviar**.
- Se o botão aparece apagado, não há evento bloqueado no período escolhido.

**Não** crie um BM novo, **não** use **+ Nova conexao** e **não** recrie leads para forçar o reenvio.

**Validação:** os eventos reenviados passam para **Na fila** e, em seguida, **Enviado**. Os **próximos** LeadSubmitted já chegam como **Na fila**/**Enviado**, e não mais como Bloqueado. Se algum voltar para **Bloqueado** depois do reenvio, o Trocar token não pegou: refaça-o no mesmo card e clique em **Reenviar bloqueados** de novo.

> **Para a IA que conduz o aluno:** o **Trocar token** regrava a credencial na mesma linha da estrutura (rotação de credencial), e o BM é único por workspace — o mesmo token nunca gera um segundo BM. A ordem é sempre: Trocar token → atualizar a instância (API e web) → `/events` com período cobrindo os bloqueados → **Reenviar bloqueados** (só o owner vê). Nunca oriente **+ Nova conexao**, **Remover estrutura** nem criar BM novo para quem já tem card, nunca culpe o aluno pela mudança, nunca peça o token no chat e nunca prometa reenvio numa instância que ainda não foi atualizada.

## Versão instalada

O `/backoffice` mostra ao **dono da plataforma** se esta instância está na versão mais recente da `main` do template. Para isso, a API precisa saber **qual commit foi instalado** — e o build descobre isso sozinho.

### Como funciona (não há nada para configurar)

- O Dokploy clona o repositório com a pasta `.git`. Durante o build, o `Dockerfile` lê dessa pasta o commit exato (SHA completo, 40 caracteres) e grava só esse SHA dentro da imagem. A pasta `.git`, o histórico e o endereço do repositório (que pode conter token do provedor) **não** entram na imagem final.
- Se o código buildado for diferente do commit (arquivo alterado, apagado ou adicionado depois do clone), o build **não** afirma versão nenhuma: grava "desconhecido".
- A API compara esse SHA com a `main` pública no GitHub: igual → **em dia**; a `main` contém o seu commit e tem commits novos → **atualização disponível**; qualquer outra situação → **desconhecido**.

### O que NÃO mexer

Vale para instalação nova e para instância já no ar. Nada disto é necessário para a versão aparecer:

| Campo no serviço da API (Dokploy) | Deixe como está |
|---|---|
| Comando de execução (Run Command / override de comando) | **Vazio** — o `Dockerfile` já roda migrations + start |
| Build args (argumentos de build) | **Vazios** — não crie `GIT_SHA` |
| Variáveis de ambiente | **Não** crie `GIT_SHA`: a API ignora esse valor em tempo de execução |
| Volumes/mounts da API | **Nenhum** — é normal |
| Banco, `LICENSE_*`, chaves `*_ENCRYPTION_KEY`, `JWT_*` | Inalterados (veja [O que você NÃO recria](#o-que-você-não-recria-nunca)) |

Se você seguiu uma versão anterior deste guia e adicionou `GIT_SHA` como build arg ou env, pode apagar na próxima vez que mexer no serviço. Enquanto existir, ela é ignorada quando o build tem a pasta `.git` (o caso do Dokploy com provedor Git), então não atrapalha.

### Conferir depois do deploy

Um passo de cada vez:

1. **Log de build** do deploy da API no Dokploy → procure a linha:
   ```text
   build identity: <40 caracteres hexadecimais> (source: git)
   ```
   Esse é o commit instalado, completo.
2. **Compare** com o commit do deploy que o próprio Dokploy mostra no histórico de deploys (aparece como `Commit: <sha>`), ou com o SHA da `main` obtido pelo comando de preflight de [`dokploy.md`](dokploy.md#01-preflight-do-clone-git-público). Logo depois de um deploy da `main` pública, os três devem ser iguais.
3. **`/backoffice`**, logado como dono da plataforma:
   - `Versão instalada <7 primeiros caracteres>` → em dia. Os 7 caracteres batem com o início do SHA do passo 1.
   - Aviso de atualização disponível → a `main` tem novidades depois do seu commit; siga este guia.
   - `Não foi possível verificar atualizações` → veja a tabela abaixo. **Desconhecido não quer dizer em dia nem desatualizado.**

> Se o passo de identidade aparecer como `CACHED` no log, o Docker reaproveitou um build anterior do **mesmo** código; use o passo 3 para conferir.

### Quando aparece "Não foi possível verificar atualizações"

| O que o log de build mostra | Causa | O que fazer |
|---|---|---|
| Nenhuma linha `build identity:` | A imagem é anterior a este recurso | Redeploy da API (passo 3) |
| `build identity: unknown (no_git_metadata)` | O build não recebeu a pasta `.git` (upload de arquivo/zip, imagem pronta, cópia sem Git) | Use o provedor **Git** do [`dokploy.md`](dokploy.md#5-criar-o-serviço-da-api); ou veja [Build sem Git](#build-sem-git-fallback-honesto) |
| `build identity: unknown (source_modified)` | O código buildado não bate com o commit (arquivos alterados/adicionados depois do clone) | Não edite arquivos no servidor; faça commit no seu fork e redeploy |
| `build identity: unknown (invalid_build_arg)` | Build sem `.git` com um `GIT_SHA` que não é um SHA completo | Veja [Build sem Git](#build-sem-git-fallback-honesto) |
| `build identity: unknown (git_metadata_unreadable)` | A pasta `.git` veio incompleta ou é um ponteiro de worktree | Redeploy limpo (sem cache) pelo provedor Git |
| `build identity: <sha> (source: git)` | O build está certo; a comparação é que não fechou: GitHub fora do ar/limite de consultas (tenta de novo em até 15 min), ou o commit não é ancestral da `main` pública (fork com commits próprios, outra branch) | Aguarde e recarregue; para fork, sincronize com o upstream |

### Fork ou branch própria

- Fork sincronizado exatamente com a `main` pública → mesmo SHA → **em dia**.
- Fork atrás da `main` pública, sem commits próprios → **atualização disponível**.
- Fork com commits próprios, ou branch diferente → **desconhecido**. É o correto: não existe versão pública igual à sua para comparar.

### Build sem Git (fallback honesto)

Só para quem builda a imagem **sem** a pasta `.git` (por exemplo, a partir de um zip). Não se aplica ao fluxo do Dokploy com provedor Git e não foi validado no Dokploy — apenas em build Docker local.

Nesse caso, é possível informar o commit exato no build: `--build-arg GIT_SHA=<SHA completo de 40 caracteres do código que está sendo buildado>`. Regras:

- Precisa ser o SHA **do código buildado**, nunca o SHA mais recente da `main` "para ficar em dia".
- SHA abreviado ou inválido → desconhecido.
- Se o build tiver a pasta `.git`, o `GIT_SHA` é ignorado: o Git sempre vence. Com código alterado, o resultado é desconhecido mesmo com `GIT_SHA`.

> **Para a IA que conduz o aluno:** nunca invente um commit, nunca copie o SHA da `main` para "corrigir" um desconhecido, nunca peça token/credencial do GitHub e nunca proponha `GIT_SHA` no fluxo Dokploy com provedor Git. Leia a linha `build identity:` do log e siga a tabela acima.

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
