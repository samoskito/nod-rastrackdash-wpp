# CUSTOMIZATION.md

O que o aluno pode personalizar sem quebrar updates (`upstream` + tags).

## Seguro editar / configurar

- Nome da agencia, logo, favicon, cor primaria (whitelabel)
- Textos de UI nao marcados como core
- `.env` / secrets **do aluno** (SMTP BYO, Uazapi/WAHA/Z-API BYO, Meta System User do cliente)
- Docs locais de operacao do aluno

## Nao editar (PALMUP-CORE)

- Client de licenca / guards de soft-lock
- Assinatura e verificacao de cache de licenca
- Nucleo de auth multi-tenant, migrations core
- Integracoes core e parsers inbound (a menos que esteja adicionando provider novo no ponto de extensao documentado)
- Footer residual `RastrackDash · powered by PalmUP`

Se precisar customizar core, voce assume o custo de merge em updates futuros.

## Backoffice (edicao aluno) — F6.1

- Assinaturas/cobranca PalmUP e a area "Operacoes internas" (financeiro,
  saude multi-tenant, CAPI, jobs) foram removidas da navegacao do
  backoffice — sao ferramentas internas da equipe PalmUP, sem uso para o
  aluno.
- A aba **Licenca** (`/backoffice/license`) e somente leitura: mostra
  `status`, `usable`, `softLock`, `hardLock`, `expiresAt`, `validUntil` e
  `source` vindos de `GET /license-client/status`. Nunca exibe
  `LICENSE_KEY`, identidade de conta ou tokens.
- O link de ativacao para o dono do cliente
  (`clientOwnerActivationLinkResultSchema`) so existe hoje como contrato em
  `@wpptrack/shared`; o endpoint que o implementava foi removido na
  sanitizacao do template publico. Fica **deferido** — nao foi reconstruido
  aqui para evitar recriar a stack de administracao multi-tenant da
  PalmUP fora de escopo (ver `.claude-task-f6-1-backoffice.md`).
