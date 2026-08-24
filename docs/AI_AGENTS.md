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
- **License client** no template (activate/heartbeat/soft-lock/status) — server PalmUP privado
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

## Prompt de partida (aluno cola na IA)

O prompt oficial e completo — com as perguntas obrigatórias antes de qualquer comando, as regras de segredo e o checklist final — vive em [`docs/AI_ONBOARDING_PROMPT.pt-BR.md`](AI_ONBOARDING_PROMPT.pt-BR.md). Use-o como a fonte da verdade; não crie uma versão resumida divergente. Ordem operacional resumida: ambiente → banco/Redis → migrations → `LICENSE_*` → primeiro admin → primeiro workspace → Meta manual → WhatsApp → marca opcional → deploy → verificação pós-deploy.

## Stack atual

- `apps/web` Next.js
- `apps/api` NestJS + Prisma + PostgreSQL + Redis + BullMQ
- `packages/shared` contratos Zod
- Deploy aluno: Vercel (web) + VPS/Dokploy (api/db/redis)
