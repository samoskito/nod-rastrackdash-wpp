# ACCEPTANCE-v1 — RastrackDash Student Edition v1.0.0 (pt-BR)

Avaliacao: 2026-08-24 · Branch `feat/v1-release-docs` (base `main` em `4394196`) · Repositório `github.com/samoskito/nod-rastrackdash-wpp`

Esta é a tradução para alunos e operadores brasileiros da [matriz em inglês](ACCEPTANCE-v1.md). Ela relaciona a [spec §15 "Critérios de Aceite"](../superpowers/specs/2026-08-19-nod-rastrackdash-wpp-student-edition-design.md#15-criterios-de-aceite) ao estado honesto do template público. Os estados não são previsões: itens sem verificação ao vivo nesta sessão permanecem `parcial` ou `não executado`.

Estados: `passou` (verificado ao vivo ou integralmente coberto por testes automatizados aprovados) · `parcial` (implementado e parcialmente verificado, mas sem ponta a ponta/ao vivo) · `falhou` (quebra conhecida) · `não executado` (sem evidência coletada) · `n/a` (fora de escopo deste repositório).

## Matriz de aceite (spec §15)

| ID | Critério | Estado | Evidência / observações |
|---|---|---|---|
| A1 | Compra Guru → chave entregue (e-mail e/ou WhatsApp) | `parcial` | O módulo de entrega vive integralmente no `dash-com-ia` privado, fora deste repositório. Funcionou com hotfixes antes, mas não houve nova evidência nesta sessão; não trate como verde atual. |
| A2 | Clonar template → setup → ativar → app `ativo` | `passou` | `pnpm setup` e checklist por `GET /onboarding/status` foram testados; `activate()` foi validado ponta a ponta com chave real contra o servidor de licenças após o ajuste de cache. Clone, setup e ativação foram verificados separadamente, não em uma única execução nova. |
| A3 | Grace: menos de 72 h sem contato não interrompe o uso | `parcial` | Testes unitários cobrem cache e limites de 72 h; não foi feito teste ao vivo interrompendo a conectividade por ~72 h. |
| A4 | Revogação faz soft-lock no próximo check-in, mesmo dentro de grace | `não executado` | O gatilho de reembolso/revogação vive no `dash-com-ia` privado; não houve evidência ao vivo nesta sessão. |
| A5 | Expiração sem renovação → grace → soft-lock; renovação aprovada reverte sem nova chave | `não executado` | Mesma limitação de A4: fluxo server-side privado, sem verificação recente ao vivo. |
| A6 | Mesma chave ativa mais de uma instância e cria telemetria visível | `não executado` | A telemetria `LicenseActivation` é server-side e privada; não houve execução multi-instância ao vivo. |
| A7 | `activate()` com identidade diferente da vinculada retorna `403` | `parcial` | O tratamento do cliente para `403` e `409` tem teste unitário aprovado. A imposição do servidor é privada e não foi testada ponta a ponta com duas contas reais. |
| A8 | Webhook Guru sem assinatura válida não emite nem revoga licença | `não executado` | Verificação de assinatura vive integralmente no `dash-com-ia` privado. |
| A9 | Template não contém `.env`, segredos PalmUP nem dados de cliente de produção | `não executado` | `gitleaks` e `git-secrets` não estavam instalados. `.gitignore` exclui `.env` e `.env.example` usa placeholders; execute a varredura antes de uma tag. |
| A10 | Aluno configura um provedor WhatsApp sem editar código core | `passou` | Registry e adaptadores `uazapi_byo`, `nod_api`, `waha` e `zapi` são cobertos pela suíte aprovada da API (152/152 em 2026-08-24). |
| A11 | Webhooks inbound multi-provider continuam funcionando | `parcial` | Parsers WAHA/Z-API têm testes aprovados. Umbler/Gupshup não possuem testes dedicados neste checkout e não foram revalidados de forma independente. |
| A12 | Aluno personaliza marca preservando o rodapé PalmUP/RastrackDash | `passou` | Testes de footer e layout aprovados asseguram que `RastrackDash · powered by PalmUP` é exibido independentemente de `BRAND_*`. |
| A13 | Backoffice cria workspace, mostra diagnósticos e licença RO sem emitir/revogar | `parcial` | Endpoint de status e checklist têm testes aprovados. A UI não recebeu QA click-through nesta sessão e há falhas preexistentes na suíte web. |
| A14 | Documentação AI-first é executável por IA com apenas envs e chave fornecidos pelo humano | `passou` | A cadeia `AGENTS.md` → `docs/AI_AGENTS.md` → `docs/setup/README.md`, o setup e o checklist existem e foram verificados nesta entrega. |

**Resumo: 4 passaram · 5 parciais · 5 não executados · 0 falharam · 0 n/a** (de 14).

## Gates de qualidade (evidências de apoio)

| ID | Gate | Estado | Evidência |
|---|---|---|---|
| Q1 | Typecheck — `pnpm typecheck` | `passou` | Limpo, sem erros nas três packages (2026-08-24). |
| Q2 | Testes unitários `@wpptrack/api` | `passou` | 152/152 aprovados em 17 arquivos (2026-08-24). |
| Q3 | Testes unitários `@wpptrack/web` | `falhou` | 277/290 aprovados; 13 falhas preexistentes desde a importação G4, fora do escopo documental. |
| Q4 | Testes unitários `packages/shared` | `falhou` | 113/133 aprovados; 20 falhas preexistentes, sobretudo contratos de billing/subscription fora da edição aluno. |
| Q5 | Varredura de segredos | `não executado` | `gitleaks` e `git-secrets` não estavam instalados no ambiente avaliado. |

## Riscos residuais e pendências

1. O link de ativação do dono do cliente foi removido na sanitização G4 e segue adiado.
2. A implantação real de múltiplas instâncias para o mesmo aluno não foi exercitada.
3. A entrega de chaves por Guru não foi revalidada com evidência recente.
4. Os alertas de desconexão WhatsApp guardam streaks em memória; reiniciam com o processo e não são compartilhados em escala horizontal.
5. A varredura de segredos deve rodar antes de criar uma tag.
6. As falhas de testes web (13) e shared (20) são preexistentes e devem ser tratadas separadamente.
7. Umbler e Gupshup não têm testes inbound dedicados neste checkout.

## Como repetir as verificações

```bash
pnpm setup -- --dry-run
pnpm setup

# Requer LICENSE_KEY e LICENSE_ACCOUNT_IDENTITY no .env
pnpm --filter @wpptrack/api dev
# Abra /backoffice/license ou consulte:
curl -s http://localhost:3333/license/status

pnpm typecheck
pnpm --filter @wpptrack/api test
pnpm --filter @wpptrack/web test
pnpm --filter @wpptrack/shared test

# Instale uma das ferramentas antes de rodar:
gitleaks detect --source . --no-git -v
# ou: git secrets --scan
```

## Documentos relacionados

- [README do aluno](../../README.pt-BR.md)
- [Guias de instalação](../setup/README.md)
- [CHANGELOG.md (EN)](../../CHANGELOG.md)
- [Runbook operacional de licenças PalmUP](../ops/palmup-license-runbook.md)
- [Matriz em inglês](ACCEPTANCE-v1.md)
