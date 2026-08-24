# AGENTS.md

Ponto de entrada para agentes de IA neste repositório.

**Leia primeiro:** [`docs/AI_AGENTS.md`](docs/AI_AGENTS.md)

Resumo operacional:

1. `pnpm setup` (ou `--dry-run`) e preencher `.env`
2. Subir Postgres/Redis, API e web
3. Ativar licença (`LICENSE_*`) e conferir `/backoffice/license`
4. Criar workspace + conectar Meta + WhatsApp provider
5. Whitelabel opcional via `BRAND_*` — **nunca** remover footer `RastrackDash · powered by PalmUP`
6. Não reintroduzir Asaas/Guru/UAZAPI_ADMIN/license private key PalmUP

Spec e plano: `docs/superpowers/`.
