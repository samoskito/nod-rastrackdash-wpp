# Guia para agentes de IA (vibe coding)

Este arquivo é a memória principal para agentes (Claude Code, Codex, Grok, etc.) que ajudam o aluno a configurar o RastrackDash.

## O que é este projeto

- **Produto:** RastrackDash
- **Repo:** `nod-rastrackdash-wpp`
- **Dono do código-base:** PalmUP
- **Usuário deste clone:** o **aluno** (agência/dev) que opera uma plataforma multi-tenant para os **clientes dele**

Não confundir:

- **Aluno** = quem comprou a licença e hospeda a instância
- **Cliente do aluno** = workspace/empresa final dentro do painel do aluno
- **PalmUP** = emite licença, opera license server, opcionalmente NOD API

## Documentos obrigatórios

Leia **nesta ordem** antes de propor qualquer comando:

1. `AGENTS.md` / este arquivo
2. `docs/AI_ONBOARDING_PROMPT.pt-BR.md` — prompt oficial que o aluno cola; contém as regras de segurança e o formato passo-a-passo que você deve seguir
3. `docs/GUIA-ALUNO.md` — jornada completa da compra ao primeiro workspace
4. `docs/setup/README.md` e os guias que ele indexa (`local.md`, `dokploy.md`, `vps.md`, `environment.md`, `troubleshooting.md`, `meta-manual.md`)
5. `docs/CUSTOMIZATION.md` (o que o aluno pode editar)
6. `docs/superpowers/specs/2026-08-19-nod-rastrackdash-wpp-student-edition-design.md` (spec APROVADA)
7. `docs/superpowers/plans/2026-08-19-rastrackdash-student-edition-implementation.md` (plano faseado)

## Estado atual do repositório (pós F3–F6.2)

- Código sanitizado do produto presente (G4+)
- **License client** no template (activate/heartbeat/lock/status) — server PalmUP privado; **fail-closed**: sem ativação válida a escrita responde `423`
- WhatsApp providers: `uazapi_byo`, `nod_api`, `waha`, `zapi` + parsers inbound
- Backoffice aluno sem billing PalmUP; aba Licença RO
- Whitelabel `BRAND_*` com footer residual fixo
- `pnpm setup` → `scripts/setup.mjs`
- Checklist real: `GET /onboarding/status` + UI em `/backoffice`

## Regras inegociáveis

- Nunca commitar `.env` com secrets, nunca pedir para o aluno colar um secreto no chat — sempre no `.env` local ou na UI do provedor (Dokploy, Vercel, etc.)
- Nunca remover footer `RastrackDash · powered by PalmUP` nem sugerir uma forma de escondê-lo
- Nenhuma chave de serviço no frontend (nunca em `NEXT_PUBLIC_*`)
- 1 licença = 1 conta de aluno (anti-share); instâncias do mesmo aluno ilimitadas
- Soft-lock quando licença bloqueada: leitura ok, escrita bloqueada
- Não hardcodar secrets PalmUP (Asaas, UAZAPI_ADMIN, license private key, Guru)
- **Fail-closed**: se um comando falhar ou uma verificação não passar, pare e diagnostique (`docs/setup/troubleshooting.md`) antes de propor o próximo passo — nunca avance "torcendo para dar certo"
- Antes do primeiro comando, pergunte ao aluno o alvo de deploy (Docker local, VPS/Dokploy ou outro) e as decisões não-secretas necessárias (workspaces/leads-dia, provedores de WhatsApp) — nunca assuma

## Quando o aluno pedir para atualizar ou mudar algo

Atualizar uma instância que já está no ar é **redeploy**, não instalação. Antes de propor qualquer passo:

1. Siga [`docs/setup/update.md`](setup/update.md). Se algum passo pedir banco novo, segredo novo, administrador novo ou licença nova, **pare**: isso é instalação e apagaria o que está rodando.
2. Leia o que mudou desde a versão instalada:
   - a linha de notas de atualização no topo de `[Unreleased]` (ou da versão mais recente) do [`CHANGELOG.md`](../CHANGELOG.md);
   - o guia de [`docs/releases/unreleased.json`](releases/unreleased.json) (ou da Release), com backup, migrations, variáveis, preservação de customizações, verificação e recuperação.
3. Para **cada variável de ambiente nova ou com padrão alterado**, explique ao aluno:
   - o que ela faz;
   - se é obrigatória;
   - o valor recomendado;
   - onde preencher (painel de env do serviço da API no Dokploy, Vercel ou `.env` local; nunca em chat nem em arquivo commitado);
   - o que acontece se ficar sem valor.

   A fonte é [`docs/setup/environment.md`](setup/environment.md), comparado com o `.env` que o aluno já usa. Não apague nem regenere variáveis que já existem.
4. Se houver migration, peça um **backup do PostgreSQL antes** do redeploy. As migrations rodam sozinhas no boot da API.
5. Depois do redeploy, faça a verificação descrita nas notas e em `update.md`. Se algo falhar, use `troubleshooting.md`. Nunca reinstale para "resolver".

Se a mudança pedida pelo aluno não for uma atualização (trocar uma variável, ligar ou desligar um recurso, mudar um fluxo), use `environment.md` e o guia da integração em `docs/setup/`. Diga o efeito antes de qualquer alteração.

**Quem altera este repositório** (manutenção ou porte do SaaS) tem uma obrigação: toda mudança que pede ação do aluno fica documentada **no mesmo commit**. Isso inclui variável nova ou com padrão alterado, passo diferente na atualização e fluxo de uso que mudou. Atualize:
- `.env.example`, com comentário;
- `docs/setup/environment.md`;
- a linha de notas de atualização do `CHANGELOG.md`;
- o guia de `docs/releases/unreleased.json`;
- `docs/setup/update.md`, se o procedimento de atualização mudar;
- o guia da integração afetada.

Sem isso, a IA do aluno não tem como orientá-lo.

## Prompt de partida (aluno cola na IA)

O prompt oficial e completo — com as perguntas obrigatórias antes de qualquer comando, as regras de segredo e o checklist final — vive em [`docs/AI_ONBOARDING_PROMPT.pt-BR.md`](AI_ONBOARDING_PROMPT.pt-BR.md). Use-o como a fonte da verdade; não crie uma versão resumida divergente. Ordem operacional resumida: ambiente → banco/Redis → migrations → `LICENSE_*` → primeiro admin → primeiro workspace → Meta manual → WhatsApp → marca opcional → deploy → verificação pós-deploy.

## Stack atual

- `apps/web` Next.js
- `apps/api` NestJS + Prisma + PostgreSQL + Redis + BullMQ
- `packages/shared` contratos Zod
- Deploy aluno: Vercel (web) + VPS/Dokploy (api/db/redis)
