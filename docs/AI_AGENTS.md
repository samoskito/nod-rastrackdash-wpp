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

1. `docs/superpowers/specs/2026-08-19-nod-rastrackdash-wpp-student-edition-design.md` (spec APROVADA)
2. `docs/superpowers/plans/2026-08-19-rastrackdash-student-edition-implementation.md` (plano faseado)
3. `docs/CUSTOMIZATION.md` (o que o aluno pode editar)
4. `docs/setup/` (guias passo a passo)
5. `AGENTS.md` / este arquivo

## Estado atual do repositório (pós F3–F6.2)

- Código sanitizado do produto presente (G4+)
- **License client** no template (activate/heartbeat/soft-lock/status) — server PalmUP privado
- WhatsApp providers: `uazapi_byo`, `nod_api`, `waha`, `zapi` + parsers inbound
- Backoffice aluno sem billing PalmUP; aba Licença RO
- Whitelabel `BRAND_*` com footer residual fixo
- `pnpm setup` → `scripts/setup.mjs`
- Checklist real: `GET /onboarding/status` + UI em `/backoffice`

## Regras inegociáveis

- Nunca commitar `.env` com secrets
- Nunca remover footer `RastrackDash · powered by PalmUP`
- Nenhuma chave de serviço no frontend
- 1 licença = 1 conta de aluno (anti-share); instâncias do mesmo aluno ilimitadas
- Soft-lock quando licença bloqueada: leitura ok, escrita bloqueada
- Não hardcodar secrets PalmUP (Asaas, UAZAPI_ADMIN, license private key, Guru)

## Prompt de partida (aluno cola na IA)

```text
Você vai me ajudar a configurar o RastrackDash.
1) Leia AGENTS.md e docs/AI_AGENTS.md, a design spec e o plano em docs/superpowers/.
2) Confirme o estado atual: license client, multi-provider WhatsApp, whitelabel e setup script já existem neste repo; license server PalmUP é externo.
3) Rode `pnpm setup` (ou --dry-run) e siga docs/setup/ na ordem: env → banco → LICENSE_* → admin → primeiro workspace → Meta manual → WhatsApp → brand opcional → deploy.
4) Em cada passo, rode a verificação (incl. /backoffice checklist e /backoffice/license) e só avance se passar.
5) Nunca remova o footer RastrackDash/PalmUP e nunca coloque secrets no frontend.
Pergunte agora: chave de licença, email da conta, quantos clientes pretendo rodar e leads/dia médios (para recomendar VPS).
```

## Stack atual

- `apps/web` Next.js
- `apps/api` NestJS + Prisma + PostgreSQL + Redis + BullMQ
- `packages/shared` contratos Zod
- Deploy aluno: Vercel (web) + VPS/Dokploy (api/db/redis)
