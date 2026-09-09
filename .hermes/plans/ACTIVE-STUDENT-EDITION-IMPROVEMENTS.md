# PLANO ATIVO — Melhorias da Student Edition

> **ARQUIVO CANÔNICO DE EXECUÇÃO**
>
> Este é o plano ativo para as melhorias observadas durante a instalação dos alunos.
> Não executar fases do plano mestre original sem decisão explícita de Samuel.
>
## Regra de continuidade

Antes de qualquer tarefa de código, o orquestrador deve:

1. ler este arquivo;
2. confirmar a fase ativa e o repositório correto;
3. confirmar o escopo permitido e o que está proibido;
4. executar Gate 1 (Claude ou Codex);
5. executar Gate 2 (modelo, reasoning/effort, arquivos e testes);
6. atualizar este arquivo quando a implementação começar;
7. atualizar novamente após testes, revisão, commit, PR e merge;
8. declarar o próximo passo somente depois de verificar o estado real.

Não iniciar escritor antes da aprovação dos dois gates. Não misturar dois escritores no mesmo worktree.

## Repositórios e responsabilidades

### Template público — `nod-rastrackdash-wpp`

É o repositório que o aluno clona. Contém o produto Student Edition, backoffice, workspaces, providers BYO e o cliente de licença. Não contém o license server privado PalmUP, billing privado, Guru, secrets PalmUP ou notificações de venda.

### Produto privado — `dash-com-ia`

É a aplicação principal da PalmUP/WppTrack. Contém o license server e os domínios privados. Não deve ser usado para executar as melhorias do template público, salvo quando uma tarefa indicar explicitamente esse repositório.

## O que NÃO faz parte deste plano

- Não reimplementar o license server.
- Não implementar entrega de license key por e-mail/WhatsApp.
- Não reabrir a Fase 2 de notificações do plano mestre original.
- Não criar QR Code, instância UAZAPI, assinatura de provider ou cobrança de WhatsApp.
- Não copiar billing/Asaas/Guru/provisionamento do produto privado.
- Não iniciar conectores ou UAZAPI antes das fases próprias deste plano.

## Política aprovada de entrega de e-mail

Para convites e ativações de responsáveis de clientes, `queued` significa somente que a tarefa foi aceita pela fila/SMTP configurado. A plataforma não promete nem confirma que o provedor entregou a mensagem na caixa do destinatário.

O fluxo operacional aprovado é:

1. tentar o envio automático;
2. permitir reenvio quando o cliente informar que não recebeu;
3. oferecer geração manual de um link de ativação/senha de uso único e com expiração, para o administrador copiar e enviar diretamente ao cliente;
4. deixar melhorias de confirmação por provedor, rastreamento de entrega e diagnóstico avançado para etapa posterior.

Falha de auditoria interna não deve ser confundida com falha de entrega do provedor. A auditoria deve registrar o melhor estado operacional conhecido, sem armazenar token bruto, senha ou segredo. A garantia de entrega na caixa de entrada é responsabilidade operacional do aluno junto ao cliente nesta etapa.

O arquivo histórico `docs/superpowers/plans/2026-08-19-rastrackdash-student-edition-implementation.md` é referência histórica/arquitetural, não é a fila atual de execução.

## Status oficial

| Etapa | Escopo | Repositório | Status | Evidência |
|---|---|---|---|---|
| Fase 0 | onboarding, Dokploy, Git/GitHub, envs, providers BYO e docs | público | **CONCLUÍDA** | PR #24, merge `7ba875a` |
| Fase 1 | bootstrap persistente, `platform_owner`, RBAC, convites e proteção de owner | público | **CONCLUÍDA** | PR #25, merge `6212b33` |
| Fase 2 | backoffice real multi-cliente, responsáveis, suporte escopado, anti-IDOR, ativação automática de licença e SMTP opcional | público | **CONCLUÍDA — HOMOLOGADA EM INSTALAÇÃO INDIVIDUAL (2026-08-27)** | base `374cc48`; hardening `525886a`/`5d743d5`/`51781b1`; publicado até `454725c`; homologação confirmada pelo Samuel: deploy no commit, licença autoativada no boot, workspace sem SMTP, link manual one-time, bootstrap password removida |
| Fase 3 | conectores externos MySQL/PostgreSQL com egress/SSRF seguro | público | **FASE 3A MERGEADA — SMOKE REAL PAUSADO** | PR #43 merge `a48e93d`; API deployada; listagem autenticada OK no workspace `cmtbvwoop0000qa2swt9x8amu`; create/test MySQL real pausado até MySQL público fictício no Dokploy; PostgreSQL ainda não suportado |
| Fase 4 | UAZAPI por conexão/workspace, webhook e gatilhos | público | **IMPLEMENTADA E PARCIALMENTE HOMOLOGADA** | PRs #28–#41; UAZAPI e WAHA validados em produção; GupShup/Umbler existem como inbound webhook no código, mas a UX/aluno e a paridade com o app de referência ainda precisam de fechamento |

### Checkpoint MySQL — pausado em 2026-09-04

Registro exato de onde paramos, para retomar sem perder contexto:

| Item | Estado | Evidência |
|---|---|---|
| Backend Fase 3A | **MERGEADO** | PR #43 → `a48e93d` |
| Workspace ID no backoffice | **MERGEADO** | PR #44 → `3f0de68` |
| API deployada | **SIM** | `https://aula.nodinfra.com.br/health` e `/health/ready` OK |
| Web com Workspace ID | **SIM** | Samuel copiou `cmtbvwoop0000qa2swt9x8amu` |
| Smoke auth + list conectores | **OK** | `GET .../external-connectors` → `200 []`, sem secrets |
| Create/test MySQL real | **PAUSADO** | falta MySQL fictício **público** na porta 3306 |
| PostgreSQL external | **NÃO INICIADO** | sem adapter/testes reais |
| UI de conectores no backoffice | **NÃO EXISTE** | Fase 3A foi só backend |
| Migration | **NENHUMA** | não necessária na 3A |

#### Decisão técnica já fechada para retomar MySQL

- **Não** usar banco real de cliente.
- Conector aceita apenas destino **público** + porta **3306** (bloqueia localhost/RFC1918/host interno Dokploy).
- Caminho escolhido por Samuel: MySQL fictício **no Dokploy com 3306 pública**, sem provedor externo.
- Próximos passos quando retomar:
  1. criar serviço MySQL `mysql-smoke-external` no Dokploy;
  2. database `smoke_external` + user read-only + 1 tabela fake;
  3. expor host público:3306;
  4. `POST` create conector read-only;
  5. `POST .../test` + `GET .../status`;
  6. validar bloqueio de destino privado e ausência de secrets no payload.

### Prioridade máxima — pedidos urgentes dos alunos (2026-09-04)

Samuel elevou estes 3 itens à **prioridade máxima**, acima do restante do plano de melhorias e acima da retomada do MySQL:

| Prio | Pedido | Já estava no plano? | Estado real no código (`main` @ `3f0de68`) | Ação |
|---:|---|---|---|---|
| **P0.1** | Botão para **excluir workspace** no backoffice | **Parcial / gap** — Fase 2 cobre criar/listar/responsáveis/suporte, mas **não** delete de workspace na UI/API de backoffice | `BackofficeWorkspacesController` só tem `GET/POST` + activation; existe script break-glass `apps/api/scripts/delete-workspace.js`, **sem botão** | Implementar delete seguro no backoffice (platform_owner), com confirmação, anti-IDOR, auditoria e ordem FK-safe; depois UI |
| **P0.2** | Trazer conexões **GupShup e Umbler** para o app do aluno | **Sim** — fila WhatsApp / homologação E2E e inbound genérico | Já existem parsers/conexões inbound (`gupshup`, `umbler`), painel inbound e regras; **não** estão no registry de “Conexões WhatsApp” (`uazapi_byo/waha/zapi/nod_api`) | Fechar paridade de UX/aluno: onboarding claro em Integrações, webhook copiável, docs e homologação; portar o que faltar do app de referência sem reintroduzir billing/QR |
| **P0.3** | Conexão/parser **direto com Meta** (Samuel tem payload) | **Sim** — item Meta/Facebook e webhook Meta parcial | Meta manual + CAPI + `GET/POST /webhooks/meta` já existem; falta validar/estender parser com o payload real do Samuel | Receber payload (redigido), mapear contrato atual vs desejado, implementar/ajustar parser com testes e fail-closed |

### Fila ativa reordenada — 2026-09-04

| Ordem | Item | Status | Observação |
|---:|---|---|---|
| **1** | **P0.1 Excluir workspace no backoffice** | **PRÓXIMA** | prioridade máxima dos alunos |
| **2** | **P0.2 GupShup + Umbler no app do aluno** | **NA FILA** | base inbound já existe; fechar UX/paridade/homologação |
| **3** | **P0.3 Meta direto / parser com payload real** | **NA FILA** | Samuel fornece payload; não inventar contrato |
| 4 | Retomada smoke MySQL fictício no Dokploy | **PAUSADA** | só depois dos P0 |
| 5 | Doc de atualização do aluno (redeploy API/Web) | **PENDENTE** | necessária para aula; banner de versão ainda separado |
| 6 | Banner de atualização de versão | **PENDENTE / A CONFIRMAR** | plano histórico citava; validar o que já entrou vs o que falta |
| 7 | PostgreSQL external connector | **PENDENTE** | só com adapter + testes reais |
| 8 | Segurança operacional geral + release | **PENDENTE** | após P0 e homologações |

### Estado atual detalhado — atualizado em 2026-09-04

- `main` atual: `3f0de68` (Workspace ID no backoffice).
- Fase 3A backend MySQL: mergeada no PR #43 (`a48e93d`), deploy da API confirmado.
- Smoke MySQL: **auth/list OK**; create/test **pausado** por decisão de prioridade e por falta de MySQL público fictício.
- Workspace de teste da instalação aula: `cmtbvwoop0000qa2swt9x8amu` (Agência Palmup).
- Delete de workspace: **gap confirmado** para o aluno (criar sim, excluir não).
- GupShup/Umbler: **existem no produto** como inbound webhook; a demanda é trazer/fechar a experiência no app do aluno e homologar.
- Meta: conexão manual e webhook base existem; demanda urgente é parser/conexão direta com payload real fornecido por Samuel.
- MySQL, banner e release ficam **depois** dos 3 P0.

### Decisão de ordenação — atualizada em 2026-09-04

O modelo operacional continua: **uma instalação por aluno**, com banco/deploy/backoffice próprios.

Ordem vigente **agora**:

1. **P0.1** — excluir workspace no backoffice;
2. **P0.2** — GupShup + Umbler no app do aluno;
3. **P0.3** — Meta direto/parser com payload do Samuel;
4. retomar smoke MySQL fictício no Dokploy (3306 pública);
5. doc de atualização do aluno;
6. banner de atualização (se ainda incompleto);
7. PostgreSQL external, se necessário;
8. segurança final + release.

A Fase 3A MySQL **não está abandonada**: está **mergeada e pausada** no ponto de homologação real.

## Fase 2 — Backoffice real multi-cliente

### Objetivo

Transformar `/backoffice/clients`, que hoje é uma página honesta/informativa, em gestão real de clientes/workspaces sem dados fictícios e sem vazamento entre workspaces.

### Slices, na ordem

1. **Listar e criar cliente/workspace**
   - `GET /backoffice/workspaces`;
   - `POST /backoffice/workspaces`;
   - owner da plataforma cria workspace e primeiro responsável em transação;
   - reutilização de usuário existente exige confirmação explícita e auditoria.

2. **Responsáveis e acesso**
   - listar owners/members do workspace;
   - convidar, reenviar ativação, revogar membership;
   - transferência de owner em dois passos;
   - workspace nunca fica sem owner.

3. **Equipe da plataforma**
   - expor a administração de `platform_owner`/`platform_operator` já implementada;
   - manter distinção entre equipe da plataforma e equipe do cliente.

4. **Suporte escopado**
   - iniciar suporte para um `workspaceId` específico;
   - persistir contexto na sessão;
   - banner persistente com workspace/cliente ativo;
   - sair do suporte;
   - expiração/logout limpam o contexto;
   - auditar início, fim, ator e workspace.

5. **UI real do painel**
   - substituir o placeholder somente quando os endpoints reais existirem;
   - estados vazios, loading e erro honestos;
   - nenhum KPI, cliente ou workspace fictício.

### Writer e ordem técnica

- Backend/API, contratos, autorização, anti-IDOR e testes: **Codex**.
- Frontend/backoffice e banner de suporte: **Claude Code**, depois do contrato/API validado.
- Um único escritor por worktree; não executar Codex e Claude simultaneamente na mesma árvore.

### Arquivos esperados — confirmar após inspeção

Backend provável:

- `apps/api/src/workspaces/backoffice-workspaces.controller.ts`;
- `apps/api/src/workspaces/platform-workspace-access.service.ts`;
- `apps/api/src/workspaces/workspaces.module.ts`;
- `apps/api/src/workspaces/workspaces.service.ts`;
- `apps/api/src/auth/auth.service.ts`;
- `apps/api/src/workspaces/workspace-context.service.ts`;
- `packages/shared/src/schemas/workspace.ts`;
- `packages/shared/src/schemas/platform-administration.ts`;
- testes API de autorização, anti-IDOR, suporte e convites.

Frontend provável, após aceite do backend:

- `apps/web/src/app/(backoffice)/backoffice/clients/page.tsx`;
- `apps/web/src/app/(backoffice)/backoffice/clients/actions.ts`;
- componentes de cliente, navegação e banner de suporte;
- testes de rotas, estados e escopo.

O executor deve inspecionar o estado atual e não assumir que esses arquivos existem.

### Segurança obrigatória

- filtro de banco por `workspaceId` em toda leitura/mutação administrativa;
- nenhum ID de outro workspace pode ser usado para operar ou enumerar dados;
- sessão sem role persistente recebe 401/403 conforme o caso;
- operador não administra owner;
- suporte não concede role de owner;
- contexto de suporte é curto, explícito, auditado e revogável;
- convites continuam one-time, expirados e sem senha transmitida;
- auditoria sem tokens, hashes, senhas ou segredos;
- respostas não inventam dados.

### Migration gate

A expectativa inicial é nenhuma migration, pois os modelos de workspace, memberships, convites, auditoria e sessão já existem.

Se o Codex concluir que uma migration é indispensável, deve parar antes de criá-la e reportar:

- arquivo;
- tabelas/colunas;
- impacto nos dados existentes;
- risco;
- rollback;
- comando exato.

### Aceite da Fase 2

- platform owner lista/cria clientes reais;
- primeiro responsável é criado/convidado com escopo correto;
- convites e memberships são administráveis;
- suporte entra e sai de um único workspace;
- outro workspace não é acessível por ID manipulado;
- auditoria registra ações sem segredos;
- `/backoffice/clients` não usa placeholders para dados reais;
- testes focados, typecheck, build e revisão independente passam;
- commit, push, PR e merge permanecem gates separados.

## Protocolo de atualização deste arquivo

Ao iniciar uma fase:

```text
Status: IMPLEMENTANDO
Branch:
Executor:
Modelo/reasoning:
Task file:
Escopo:
```

Após implementação:

```text
Status: IMPLEMENTAÇÃO CONCLUÍDA — AGUARDANDO REVISÃO
Arquivos:
Testes:
Migrations:
Limitações:
```

Após revisão:

```text
Status: ACEITA PARA COMMIT
Revisão independente:
Bloqueadores:
```

Após merge:

```text
Status: CONCLUÍDA
PR:
Commit mergeado:
Checks:
Deploy:
Próxima fase:
```

Nenhuma fase pode ser marcada como concluída apenas porque um agente terminou; exige evidência real e o gate correspondente.
