# Provedores de WhatsApp — contrato BYO e matriz de webhook

Este documento existe porque "preencher a env do provedor" **não** é a
mesma coisa que "ter uma conexão de WhatsApp funcionando por workspace".
Leia isto antes de configurar qualquer provedor.

> Fatos verificados diretamente no código nesta revisão (não é opinião nem
> suposição de IA) — inclusive o próprio texto que a UI do produto mostra
> ao aluno. Onde o comportamento não está confirmado no repositório, este
> documento diz explicitamente **"a confirmar"** — nunca inventa um
> contrato.

## Regra central: env global ≠ conexão do workspace

Nenhuma variável de ambiente, sozinha, cria uma conexão persistida nem
habilita gatilhos/automação para um workspace. Preencher `UAZAPI_*`/
`WAHA_*`/`ZAPI_*`/`NOD_API_BROKER_URL` só torna aquele **adapter**
disponível no backend (ele passa a responder `getHealth()`). Isso é
necessário, mas não é a mesma coisa que "workspace X está recebendo
mensagens".

⚠️ **Ponto que confunde muita gente e por isso está documentado aqui em
destaque:** os quatro adapters de status (`uazapi_byo`, `nod_api`, `waha`,
`zapi`) são **uma única instância por deployment inteiro**, configurada
pela env — **não** por workspace, e **não há UI para criar múltiplas
instâncias desses provedores**. É o próprio produto que diz isso ao
aluno na tela de Integrações:

> "Esta edição conecta uma única instância Uazapi configurada por variável
> de ambiente (`UAZAPI_BASE_URL`/`UAZAPI_TOKEN`). Não há marketplace de
> instâncias nem cobrança dentro do painel."
> — `apps/web/src/app/(app)/integrations/page.tsx`

Ou seja: se você (aluno/agência) atende vários clientes finais (workspaces)
e quer que cada um tenha seu **próprio** número/instância Uazapi/WAHA/
Z-API, **este template, hoje, não oferece isso pronto** — todos os
workspaces enxergam a saúde da mesma instância única configurada na env.
Múltiplas instâncias reais por workspace é o modelo de
**conexão inbound genérica** (Umbler/Gupshup, próxima seção), que é
per-workspace de verdade.

## Dois modelos de conexão diferentes no código (não confunda um pelo outro)

| Modelo | O que é | Escopo real | Providers |
|---|---|---|---|
| **Adapter de status/health** (`WhatsappProviderAdapter`) | Consulta a API do provedor para saber se a instância (única, do deployment) está conectada (`getHealth`); em alguns casos lista labels. Não recebe webhooks de mensagem. | **Um por deployment inteiro**, não por workspace — confirmado na própria UI do produto (citação acima) | `uazapi_byo`, `nod_api`, `waha`, `zapi` |
| **Conexão de webhook inbound** (`InboundWebhookConnection`) | Registro por workspace com parser dedicado e segredo próprio (`secretHash`, rotacionável), criável pelo próprio aluno em `/integrations` | **Por workspace, múltiplas conexões possíveis** | `umbler`, `gupshup` (self-service); `uazapi` também existe no enum, mas é provisionado só automaticamente — veja aviso abaixo |
| **Meta (Cloud API oficial)** | Token de usuário do sistema colado na UI por workspace, sem OAuth | Por workspace | `meta` — ver [`meta-manual.md`](meta-manual.md) |

### Aviso confirmado sobre `uazapi` no modelo de webhook inbound

O enum de banco (`InboundWebhookProvider`) inclui `uazapi`, e existe um
`UazapiConversionBridgeService` que provisiona automaticamente uma
`InboundWebhookConnection`/`InboundWebhookChannel` **a partir de um
`WhatsappInstance` já existente**. O código da própria criação de
conexão inbound recusa explicitamente o caminho manual para esse
provider:

> "Conexoes UAZAPI sao criadas automaticamente a partir da instancia
> WhatsApp" — `inbound-webhook-connections.service.ts`

O problema, confirmado nesta revisão: **não existe, em nenhum lugar deste
repositório, um caminho (endpoint ou UI) que crie um registro
`WhatsappInstance`.** Todos os usos de `whatsappInstance` no código são
apenas leitura (`findFirst`/`findMany`). Isso significa que, hoje, o
webhook inbound do Uazapi por workspace (tanto a rota legada global
`POST /webhooks/uazapi` quanto a rota por instância
`POST /webhooks/uazapi/instances/:instanceId`) depende de uma linha
`WhatsappInstance` que **nada neste template cria** — ambas as rotas
fazem `whatsappInstance.findFirst/findMany` por `providerInstanceId` e
retornam `401 Unauthorized` se não encontrarem nada. Trate isso como uma
lacuna confirmada do produto, não como um passo que você (aluno) esqueceu
de clicar em algum lugar — não há botão para isso. Se seu fluxo depende
de mensagens inbound do Uazapi chegando roteadas por workspace, é um
bloqueio de produto, não de configuração; não invente uma solução aqui.

## Matriz de autenticação de webhook

| Rota / provedor | Mecanismo confirmado no código | Pré-requisito | Status |
|---|---|---|---|
| `POST /webhooks/uazapi` (legado, global) | Token comparado à env global `UAZAPI_WEBHOOK_AUTH_TOKEN` | Também exige um `WhatsappInstance` existente casando `providerInstanceId` do payload — **sem criação confirmada** (ver aviso acima) | **Mecanismo de auth confirmado; pré-requisito de dados não é atendível hoje** |
| `POST /webhooks/uazapi/instances/:instanceId` | Bearer comparado ao hash salvo em `WhatsappInstance.webhookTokenHash` | Mesmo bloqueio acima — precisa do `WhatsappInstance` já existir | **Mecanismo de auth confirmado; pré-requisito de dados não é atendível hoje** |
| Conexão inbound `umbler`/`gupshup` (`InboundWebhookConnection`) | Query param `?token=` comparado ao `secretHash` daquela conexão; rotacionável via endpoint dedicado | Criar a conexão em `/integrations` (self-service, confirmado) | **Confirmado e funcional** |
| `GET /webhooks/meta` (handshake) | `hub.verify_token` comparado à env global `META_WEBHOOK_VERIFY_TOKEN` | — | **Confirmado** |
| `POST /webhooks/meta` (eventos) | Resolve o workspace pelo `page_id` do payload contra `MetaConversionDestination` | Destino configurado em [`meta-manual.md`](meta-manual.md) | **Confirmado o roteamento por página; nenhum segredo de assinatura de payload adicional confirmado além do handshake** |
| WAHA — webhook inbound | Nenhuma rota HTTP dedicada encontrada no backend para eventos inbound do WAHA | — | **A confirmar** — não documente um mecanismo até existir código/rota real |
| Z-API — webhook inbound | Nenhuma rota HTTP dedicada encontrada no backend para eventos inbound do Z-API | — | **A confirmar** |
| NOD API — webhook inbound | Nenhuma rota HTTP dedicada encontrada além do broker de instância (`NOD_API_BROKER_URL`) | — | **A confirmar** |
| Data Crazy | Provedor não implementado no código (nenhum adapter, parser ou valor de enum) | — | **Não implementado — não configure, não existe contrato ainda** |
| Zap Responder | Provedor não implementado no código (nenhum adapter, parser ou valor de enum) | — | **Não implementado — não configure, não existe contrato ainda** |

## Por provedor

### Uazapi BYO (`uazapi_byo`)

- Você roda sua própria instância Uazapi (fora deste template).
- Env: `UAZAPI_BASE_URL`, `UAZAPI_TOKEN` (token da sua própria instância —
  nunca um token de frota administrativo; `UAZAPI_ADMIN_TOKEN` não existe
  neste template e não deve ser reintroduzido).
- Credenciais: painel da sua própria instância Uazapi.
- **Escopo confirmado: uma única instância para todo o deployment**, não
  por workspace — a própria tela de Integrações avisa isso (citação
  acima). Health check funciona (`getHealth`); label catalog funciona
  (`listLabels`).
- Webhook inbound por workspace: mecanismo de auth existe no código, mas
  depende de um `WhatsappInstance` que nada cria hoje — veja o aviso na
  seção anterior. Não prometa esse fluxo funcionando de ponta a ponta ao
  aluno sem essa ressalva.

### NOD API (`nod_api`)

- Broker gerenciado pela PalmUP, add-on licenciado — você não hospeda essa
  parte.
- Env: `NOD_API_BROKER_URL` (normalmente já vem preenchido no
  `.env.example`).
- Credenciais: autentica usando `LICENSE_KEY` + fingerprint da instância —
  não existe token administrativo separado para configurar.
- Mesmo padrão de escopo do `uazapi_byo` (adapter único do deployment,
  não confirmado como multi-instância por workspace).
- Webhook inbound: **a confirmar** (nenhuma rota dedicada encontrada além
  do broker de criação/status de instância).

### WAHA (`waha`, self-host)

- Você roda sua própria instância [WAHA](https://github.com/devlikeape/waha).
- Env: `WAHA_BASE_URL`, `WAHA_API_KEY`, `WAHA_SESSION` (padrão `default`).
- Credenciais: painel/configuração da sua própria instância WAHA.
- O adapter hoje só consulta status/health (`GET
  {WAHA_BASE_URL}/api/sessions/{WAHA_SESSION}`), mesmo padrão de escopo
  de instância única do `uazapi_byo` acima.
- **Não há caminho de webhook inbound confirmado no backend** para
  eventos WAHA. Não prometa esse recurso ao aluno até existir uma rota
  real.

### Z-API (`zapi`, self-host/assinatura)

- Você roda ou assina sua própria instância [Z-API](https://www.z-api.io/).
- Env: `ZAPI_BASE_URL`, `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`.
- Credenciais: painel Z-API.
- O adapter hoje só consulta status/health, mesmo padrão de escopo de
  instância única.
- **Webhook inbound: a confirmar**, mesma ressalva do WAHA acima.

### Meta / API oficial (Cloud API, modo manual)

- Não é um adapter de WhatsApp neste registry — é um modelo próprio, por
  workspace, sem OAuth/login social no MVP do aluno. Siga
  [`meta-manual.md`](meta-manual.md) integralmente.
- Handshake do webhook confirmado via `META_WEBHOOK_VERIFY_TOKEN` (veja
  matriz acima); eventos são roteados por `page_id` até o workspace.

### Umbler e Gupshup (conexão inbound genérica)

- Não têm adapter de status/health — existem apenas como **conexão de
  webhook inbound** (`InboundWebhookConnection`, provider `umbler`/
  `gupshup`), com parser dedicado e segredo por conexão, rotacionável.
- **Este é o único modelo confirmadamente per-workspace e
  multi-instância neste template**: crie quantas conexões quiser por
  workspace em `/integrations`, cada uma com seu próprio segredo.
- Credenciais/config do provedor em si: no painel próprio de cada serviço
  (Umbler, Gupshup) — configure lá a URL de webhook (com o `?token=`
  daquela conexão) fornecida pelo RastrackDash na criação da conexão.

### Data Crazy e Zap Responder

**Não implementados neste código.** Não existe adapter, parser, nem valor
de enum para nenhum dos dois — apenas menções em documentos de
planejamento (fora do escopo desta fase de documentação de produto). Não
oriente o aluno a preencher variáveis de ambiente para esses dois nomes:
não existe nada no backend para consumi-las. Se/quando um adapter ou
parser real for implementado para eles, atualize esta tabela a partir do
código, não a partir deste aviso.

## Onde cada credencial vem

| Provedor | Onde o aluno encontra a credencial |
|---|---|
| Uazapi BYO | Painel da própria instância Uazapi que o aluno administra |
| NOD API | Não há credencial própria — usa `LICENSE_KEY` já configurada |
| WAHA | Painel/configuração da própria instância WAHA self-hosted |
| Z-API | Painel da conta Z-API do aluno |
| Meta | Gerenciador de Negócios (Meta Business Suite) — veja [`meta-manual.md`](meta-manual.md) |
| Umbler / Gupshup | Painel de cada serviço, apontando a URL de webhook (com `?token=`) gerada pelo RastrackDash ao criar a conexão |

## Referências

- [`environment.md`](environment.md) — tabela completa de variáveis, incluindo as de cada provedor.
- [`meta-manual.md`](meta-manual.md) — fluxo completo do Meta manual.
- [`troubleshooting.md`](troubleshooting.md) — sintomas de webhook/instância não autorizada ou não conectando.
