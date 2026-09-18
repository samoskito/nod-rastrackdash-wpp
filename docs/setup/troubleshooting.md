# Troubleshooting

Cada entrada segue: **sintoma → diagnóstico seguro → causa provável → correção → verificação**. "Diagnóstico seguro" nunca inclui comandos destrutivos nem pedir para colar segredos em algum lugar.

## Docker não sobe / `docker compose up` falha

- **Diagnóstico:** `docker --version`, `docker compose version`, `docker compose ps`, `docker compose logs postgres redis`.
- **Causa provável:** Docker Desktop/daemon não está rodando, ou porta `5432`/`6379` já em uso por outro processo local.
- **Correção:** inicie o Docker; se a porta estiver ocupada, pare o outro processo ou ajuste a porta publicada em `docker-compose.yml` (e a porta correspondente em `DATABASE_URL`/`REDIS_URL`).
- **Verificação:** `docker compose ps` mostra `postgres` e `redis` como `running`.

## Postgres ou Redis indisponíveis para a API

- **Diagnóstico:** `curl -s http://localhost:3333/health/ready` (retorna detalhe de qual dependência falhou); `docker compose logs postgres`; `docker compose logs redis`.
- **Causa provável:** `DATABASE_URL`/`REDIS_URL` no `.env` não batem com o host/porta reais (comum ao trocar de Docker local para Dokploy sem atualizar a env), ou o serviço de banco ainda está inicializando.
- **Correção:** confira [`environment.md`](environment.md) e corrija a URL; se acabou de subir o container, aguarde alguns segundos e tente de novo.
- **Verificação:** `/health/ready` retorna `200` com todas as dependências `ok`.

## Erro de migration (`prisma migrate deploy`/`dev`)

- **Diagnóstico:** leia a mensagem de erro completa do Prisma (geralmente indica a migration e a linha do problema); `pnpm --filter @wpptrack/api exec prisma migrate status --schema apps/api/prisma/schema.prisma`.
- **Causa provável:** banco vazio/errado apontado por engano, migration parcialmente aplicada por uma execução anterior interrompida, ou schema divergente de uma migration manual feita fora do Prisma.
- **Correção:** confirme que `DATABASE_URL` aponta para o banco certo; se uma migration ficou parcialmente aplicada, resolva manualmente antes de tentar de novo (não rode comandos destrutivos como reset em um banco com dados reais sem ter certeza absoluta).
- **Verificação:** `prisma migrate status` mostra "Database schema is up to date".

## API não inicia / erro de DI (dependency injection) do Nest

- **Diagnóstico:** leia o stack trace completo no log de start — o Nest normalmente aponta o módulo/provider que falhou ao resolver.
- **Causa provável:** variável de ambiente obrigatória ausente (ex.: `API_PORT` inválido lança erro explícito no boot), ou um módulo espera uma dependência que não foi importada.
- **Correção:** confira a variável apontada no erro contra [`environment.md`](environment.md); se for um erro de módulo, não é esperado em uso normal do template — abra uma issue com o log completo (sem segredos).
- **Verificação:** a API sobe e `GET /health` responde `200`.

## Erro de CORS no navegador

- **Diagnóstico:** console do navegador mostra `blocked by CORS policy`; confira `WEB_ORIGIN` (API) e `NEXT_PUBLIC_API_URL` (web).
- **Causa provável:** `WEB_ORIGIN` na API não é exatamente igual à URL pública do web (protocolo/domínio/porta), ou o web está apontando para uma API diferente da que você está testando.
- **Correção:** alinhe as duas variáveis (sem barra final divergente, mesmo protocolo `http`/`https`) e reinicie a API.
- **Verificação:** a requisição do web para a API não aparece mais bloqueada no console.

## Login volta para `/login`

- **Diagnóstico:** confira `WEB_ORIGIN`, `NEXT_PUBLIC_API_URL`, `AUTH_COOKIE_DOMAIN`, o domínio exibido no navegador e se houve deploy depois da última alteração de env.
- **Causa provável:** origem do web diferente da permitida, cookie configurado para o domínio errado, API ainda com env antiga, ou sessão anterior inválida.
- **Correção:** alinhe origem e URL da API; para subdomínios irmãos use somente o domínio comum com ponto inicial em `AUTH_COOKIE_DOMAIN` (por exemplo, `.nodinfra.com.br`, nunca `https://...`, barra final ou hostname completo da API). Redeploy a API, faça novo deploy do web se `NEXT_PUBLIC_API_URL` mudou, limpe a sessão/cookies do site e entre de novo.
- **Verificação:** após login, a sessão persiste ao navegar e recarregar a página.

## Login abre `/overview` em vez de `/backoffice/clients`

- **Diagnóstico:** o acesso a `/backoffice/clients` depende só do campo `platformRole` gravado no banco para aquele usuário — não existe mais nenhuma allowlist de e-mail avaliada no momento do login. Confira nos logs da API, logo após o boot/redeploy, um dos eventos `platform_admin_env_bootstrap_completed`, `_skipped_existing_owner`, `_existing_user_requires_confirmation` ou `_failed` (veja [`environment.md`](environment.md#bootstrap-do-primeiro-administrador-por-env--caminho-oficial)).
- **Causa provável:**
  - `SETUP_PLATFORM_ADMIN_EMAIL`/`SETUP_PLATFORM_ADMIN_PASSWORD` nunca foram definidas (ou só uma das duas) antes de um redeploy — o bootstrap nunca rodou;
  - você logou com um e-mail diferente do usado em `SETUP_PLATFORM_ADMIN_EMAIL`;
  - já existe um `platform_owner` com **outro** e-mail nessa instância — nesse caso o bootstrap com essas variáveis não faz nada (é fechado depois do primeiro dono), gerencie papéis pela sessão autenticada em vez de reusar a env;
  - o e-mail já pertencia a uma conta comum e `SETUP_PLATFORM_ADMIN_CONFIRM_EXISTING` não estava `true` no boot em que você esperava a promoção;
  - `WPPTRACK_PLATFORM_ADMIN_EMAILS` está preenchida — essa variável é legada e não tem nenhum efeito no código atual, preenchê-la não resolve isso.
- **Correção:** defina `SETUP_PLATFORM_ADMIN_EMAIL` e `SETUP_PLATFORM_ADMIN_PASSWORD` diretamente no Dokploy/provedor (não em Git ou chat), redeploy a API, e logue com esse e-mail/senha exatos. Se o objetivo é promover uma conta que já existe, defina também `SETUP_PLATFORM_ADMIN_CONFIRM_EXISTING=true` antes do redeploy. Não use `***` como valor.
- **Verificação:** o primeiro administrador abre `/backoffice/clients`.

## Workspace criado sem e-mail de ativação (SMTP não configurado)

- **Diagnóstico:** a resposta de `POST /backoffice/workspaces` (ou a mensagem exibida em `/backoffice/clients` após criar o workspace) traz `deliveryStatus: "manual_link_required"`.
- **Causa provável:** SMTP é **opcional** neste template — sem `EMAIL_PROVIDER=smtp`/`SMTP_*` preenchidos (veja [`environment.md`](environment.md#e-mail-smtp-byo)), a API não tem como enviar o e-mail de ativação, mas o workspace é criado normalmente mesmo assim; isso não é um erro.
- **Correção:** nenhuma correção é necessária para continuar — use o botão de gerar link de ativação na lista de workspaces em `/backoffice/clients` e envie esse link manualmente ao responsável (WhatsApp, e-mail avulso etc.). Se preferir enviar e-mails automáticos depois, preencha SMTP e novos workspaces passam a usar `deliveryStatus: "queued"`; workspaces já criados continuam exigindo link manual até o responsável ativar a conta.
- **Verificação:** o responsável consegue acessar o link de ativação gerado e concluir o próprio cadastro.

## Receiver do provedor responde 401 (Uazapi / WAHA / Z-API)

- **Diagnóstico:** confirme qual URL está no painel do provedor. A rota correta é a gerada pelo botão **Gerar receiver** em `/integrations`: `POST {API_PUBLIC_URL}/webhooks/whatsapp/{ID_DA_CONEXAO}?token=...` — a URL **completa**, com o `?token=`.
- **Causas prováveis, em ordem:**
  - **URL antiga.** Cada clique em **Gerar receiver** invalida o token anterior. Se você gerou duas vezes, só a última URL vale.
  - **Só a parte antes do `?`.** Alguns painéis cortam a query string ao colar — confirme que o `?token=...` foi salvo.
  - **WAHA:** o `payload.session` da entrega precisa ser **exatamente** a Sessão salva na conexão. Trocou a sessão na WAHA? Clique em **Gerar receiver** de novo (isso regrava a sessão a partir da configuração salva) e recole a URL.
  - **Z-API:** o `body.instanceId` da entrega precisa ser **exatamente** o Instance ID salvo na conexão.
  - **Conexão excluída/desativada:** conexão em `suspended` rejeita tudo.
  - **Rota legada:** `POST /webhooks/uazapi` e `POST /webhooks/uazapi/instances/:id` só enxergam registros com `provider = "uazapi"` (valor legado); o painel atual grava `uazapi_byo`. Se você configurou uma dessas duas URLs, troque pelo receiver por conexão — preencher `UAZAPI_WEBHOOK_AUTH_TOKEN` não resolve.
- **Correção:** gere o receiver de novo, cole a URL completa no painel do provedor e confirme os campos de vínculo (Sessão na WAHA, Instance ID na Z-API).
- **Verificação:** o próximo evento de teste chega sem `401` nos logs da API.

## Receiver do NOD API responde 501

- **Diagnóstico:** a resposta traz "Receiver inbound para nod_api ainda nao esta disponivel".
- **Causa:** o `nod_api` tem adapter de status/health, mas **ainda não tem parser/receiver inbound** neste código. Não é configuração.
- **Correção:** para receber mensagens hoje, use Uazapi (BYO), WAHA, Z-API, Umbler, Gupshup ou Meta WhatsApp (Cloud API) — veja [`whatsapp-providers.md`](whatsapp-providers.md#matriz-de-ingestão-inbound-o-que-realmente-chega-hoje). Não invente uma URL alternativa.
- **Verificação:** com um provedor com receiver pronto, o evento de teste é aceito com `202`.

## Meta WhatsApp (Cloud API): a Meta recusa o webhook na verificação

- **Diagnóstico:** a Meta mostra erro ao clicar em verificar e salvar; a API responde `401` no `GET /webhooks/inbound/:id`.
- **Causas prováveis:**
  - **Verify token errado.** Ele é gerado pelo produto e mostrado **uma única vez** ao criar a conexão — não é `META_WEBHOOK_VERIFY_TOKEN` (essa variável é do webhook de **Meta Ads**). Perdeu? Use **Gerar nova URL** na conexão e recadastre os dois valores na Meta.
  - **`?token=` colado na URL.** A URL do Meta Cloud **não** leva query string; o token viaja no handshake.
  - **Conexão removida** ou de outro workspace.
  - **`INBOUND_WEBHOOKS_ENABLED` desligada**, o que faz a rota se comportar como inexistente.
- **Correção:** recrie/rotacione a conexão, copie **URL de callback** e **Verify token** em campos separados na Meta, e confirme as envs `INBOUND_*`.
- **Verificação:** a Meta aceita e salva o webhook; a assinatura do campo `messages` fica disponível.

## Meta WhatsApp (Cloud API): parou de receber depois de "Ativar envios automáticos"

- **Diagnóstico:** a Meta passa a registrar falha de entrega; a API responde `404` nos POSTs daquela conexão. O log tinha, antes disso, o aviso `inbound_webhook.meta_cloud_signature_unverified`.
- **Causa:** sem `META_APP_SECRET` preenchida, a API só aceita POSTs de uma conexão `meta_cloud` enquanto ela está em **observação**. Ao colocar a conexão em produção, as entregas passam a exigir a assinatura `x-hub-signature-256` — que não pode ser validada sem o segredo.
- **Correção:** preencha `META_APP_SECRET` com o **App Secret do mesmo app Meta** (não é o token permanente do Graph), redeploy a API. Se precisar voltar a receber já, use **Voltar para observação** na conexão enquanto configura.
- **Verificação:** os POSTs voltam a ser aceitos com `202` e o aviso `meta_cloud_signature_unverified` some do log.

## Meta WhatsApp (Cloud API): chegam mensagens mas nenhum lead

- **Diagnóstico:** na conexão, o contador **"Sem CTWA"** sobe e **"CTWA roteado"** fica em zero.
- **Causa:** é o contrato do produto, não um bug — só mensagem de entrada vinda de um anúncio **Click-to-WhatsApp pago** (com `referral.ctwa_clid`) vira lead. Conversa orgânica, contato salvo ou mensagem iniciada pelo cliente fora do anúncio é classificada como `ignored_no_ctwa`.
- **Correção:** teste clicando no próprio anúncio CTWA ativo. Se você esperava gatilho por **palavra-chave ou tag do atendente**, essa origem não serve: o webhook do Cloud API não entrega mensagens enviadas pelo seu time. Use **Uazapi (BYO)** ou **Umbler Talk** (veja [`whatsapp-providers.md`](whatsapp-providers.md#regra-de-produto-que-vale-para-todos-só-ctwa-vira-lead)).
- **Verificação:** uma mensagem originada de clique no anúncio aparece em **"CTWA roteado"** ou **"CTWA pendente"**.

## Aparece UI OAuth/social do Facebook

- **Diagnóstico:** confira `META_CONNECTION_MODES` no ambiente da API e o resultado de `/integrations` após redeploy.
- **Causa provável:** a variável está ausente/não é `manual`, a API não foi redeployada, ou as capabilities Meta não estão disponíveis.
- **Correção:** defina exatamente `META_CONNECTION_MODES=manual`, redeploy a API e atualize a página. Se as capabilities estiverem indisponíveis, a UI deve permanecer fechada e mostrar configuração Meta indisponível; não use OAuth como contorno.
- **Verificação:** `/integrations` exibe apenas a conexão manual Meta, sem login social/OAuth.

## Preview da Vercel com origem divergente

- **Diagnóstico:** compare a URL exata do preview Vercel com `WEB_ORIGIN` da API e veja o console do navegador para CORS/cookie.
- **Causa provável:** previews usam hostname próprio, diferente do domínio de produção autorizado pela API e pelo cookie.
- **Correção:** teste no domínio de produção, ou adicione explicitamente a origem de preview necessária conforme a política do seu ambiente e redeploy a API. Não troque `AUTH_COOKIE_DOMAIN` pelo hostname completo do preview.
- **Verificação:** o preview autorizado autentica sem erro de CORS/cookie; a produção continua usando sua origem pública correta.

## Licença `403`/"não configurada"

- **Diagnóstico:** `/backoffice/license`; no log da API, logo após o boot, procure `license_auto_activation_succeeded`, `license_auto_activation_failed`, `license_auto_activation_skipped_not_configured` ou `license_auto_activation_skipped_inert`.
- **Causa provável:** `LICENSE_ACCOUNT_IDENTITY` não é exatamente o e-mail da conta vinculada à chave (retorna `403`), ou `LICENSE_KEY`/`LICENSE_SERVER_URL` estão vazios/errados (`skipped_not_configured` / "não configurada"). `skipped_inert` significa `LICENSE_SERVER_URL` vazio — modo de desenvolvimento, sem licenciamento.
- **Correção:** confirme com a PalmUP qual e-mail está vinculado à chave e ajuste `LICENSE_ACCOUNT_IDENTITY` para bater exatamente; confirme que `LICENSE_KEY` foi colada sem espaços extras; redeploy (a ativação é tentada de novo a cada boot, e é idempotente). Se preferir forçar sem reiniciar, use o fallback `POST /license-client/activate`.
- **Não procure a chave numa tela:** não existe UI de listagem/busca/reemissão de licenças neste produto. Se a chave sumiu ou não é reconhecida, o caminho é o suporte da PalmUP, informando o **e-mail usado na compra**.
- **Verificação:** `/backoffice/license` mostra `usable: true`.

## Escrita bloqueada com `423` (licença não ativada)

- **Diagnóstico:** qualquer `POST/PATCH/PUT/DELETE` responde `423` com um `reason` (`license_required`, `activation_failed`, `revoked`, `expired`, `grace_exceeded`); `/backoffice/license` mostra o mesmo estado e o banner aparece no painel. Leitura e login continuam funcionando.
- **Causa provável:**
  - `license_required`: `LICENSE_SERVER_URL` configurado e nenhuma ativação válida ainda (chave ausente ou ativação nunca executada);
  - `activation_failed`: `LICENSE_KEY` preenchida, mas a última tentativa de ativação falhou (chave errada, `403` de identidade, servidor fora);
  - `revoked`/`expired`/`grace_exceeded`: licença bloqueada pelo servidor ou grace de 72h esgotado.
- **Correção:** preencha `LICENSE_KEY` e `LICENSE_ACCOUNT_IDENTITY` (veja [`environment.md`](environment.md)) e reinicie/redeploy a API — a ativação é tentada automaticamente no boot. Se ainda assim falhar, chame `POST /license-client/activate` como fallback; essa rota, `/health` e `/auth` continuam liberadas durante o bloqueio. Para `revoked`/`expired`, renove ou fale com o suporte da PalmUP.
- **Verificação:** `/backoffice/license` mostra `usable: true`, o banner some e a escrita volta a funcionar.

## WhatsApp não conecta (Uazapi / WAHA / Z-API)

- **Diagnóstico:** `/integrations` mostra o status de saúde reportado pelo provedor (`connected`/`needs_reconnect`/`disconnected`/`error`); confira se as variáveis do provedor escolhido estão preenchidas (veja [`environment.md`](environment.md)).
- **Causa provável:**
  - `needs_reconnect`: sessão/instância precisa escanear QR de novo na sua própria instância Uazapi/WAHA/Z-API (fora deste template).
  - `disconnected`: variáveis do provedor ausentes ou instância parada.
  - `error`: URL/token errados ou instância inacessível pela rede onde a API roda.
- **Correção:** reconecte diretamente no painel/instância do provedor; confirme host/porta acessíveis a partir do servidor da API (não só do seu navegador); use **Editar** na conexão para corrigir URL/token. O botão **Testar** usa as credenciais salvas **naquela conexão** e só cai nas variáveis de ambiente quando o campo não foi preenchido na UI — se um workspace continua errado depois de corrigir a env, é porque a conexão dele tem credencial própria (veja [`whatsapp-providers.md`](whatsapp-providers.md#envs-de-provedor-o-que-elas-fazem-hoje)).
- **Verificação:** `/integrations` volta a mostrar `connected` para o provedor.

## "Instância Uazapi (BYO)" no rodapé de Integrações diz que é instância única

- **Diagnóstico:** o card no fim de `/integrations` mostra o texto "Esta edição conecta uma única instância Uazapi configurada por variável de ambiente".
- **Causa:** esse card é o **status global do deployment**, lido de `UAZAPI_BASE_URL`/`UAZAPI_TOKEN`. Ele não descreve o painel **"Provedores e receivers"** logo acima, que é por workspace e aceita várias conexões.
- **Correção:** nenhuma — são dois painéis com escopos diferentes. Para conexões por cliente, use sempre o painel "Provedores e receivers".
- **Verificação:** duas conexões diferentes criadas em workspaces diferentes aparecem cada uma no seu workspace, com status próprio no botão **Testar**.

## Recebo leads/webhooks mas não aparece Nova regra

- **Diagnóstico:** confira na env da API se `INBOUND_WEBHOOKS_ENABLED`, `INBOUND_CONVERSION_RULES_ENABLED` e (em produção) `INBOUND_WEBHOOK_PRODUCTION_ENABLED` estão `true`, e se `INBOUND_WEBHOOK_ENCRYPTION_KEY` está preenchida — veja [`environment.md`](environment.md#gatilhos-de-conversão--obrigatórias-no-caminho-do-aluno).
- **Causa provável:** o padrão de todas as `INBOUND_*` é desligado (`false`/vazio); receber leads/webhooks (UAZAPI, NOD, WAHA, Z-API, etc.) não depende dessas variáveis, mas **Gatilhos de conversão → Nova regra** depende — sem elas ligadas, a tela fica sem criar regra mesmo com leads chegando normalmente. Também pode ser um deploy antigo que ainda não aplicou uma env alterada.
- **Correção:** defina `INBOUND_WEBHOOKS_ENABLED=true`, `INBOUND_WEBHOOK_ENCRYPTION_KEY=<gerada com node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))">`, `INBOUND_CONVERSION_RULES_ENABLED=true` e `INBOUND_WEBHOOK_PRODUCTION_ENABLED=true` (produção) direto no painel de env do serviço da API; redeploy a API (e o web também, se a versão publicada estiver desatualizada).
- **Verificação:** com uma conexão WhatsApp/origem já existente, `/settings#whatsapp-triggers` mostra **Nova regra** disponível.

## As envs `INBOUND_*` estão ligadas, mas a origem não aparece em Gatilhos

- **Diagnóstico:** `/settings#whatsapp-triggers` abre, mas a lista "Origens conectadas" está vazia (ou não lista a conexão que você criou).
- **Causa provável, por origem:**
  - **Umbler, Gupshup, Meta WhatsApp (Cloud API):** a origem aparece assim que a conexão existe em `/integrations` → **Webhooks de entrada**. Se você criou a conexão no painel **"Provedores e receivers"**, criou outra coisa — são painéis diferentes.
  - **Uazapi:** a origem é criada automaticamente pelo produto, mas só quando chega pelo receiver uma mensagem **enviada pelo número conectado** (atendente) ou uma mudança de etiqueta. Uma mensagem apenas recebida do cliente não cria a origem. Responda uma conversa pelo número conectado e recarregue.
  - **WAHA e Z-API:** recebem leads normalmente, mas **ainda não têm** criação automática de origem na central de Gatilhos. É lacuna conhecida do produto, não configuração.
  - **NOD API:** sem receiver inbound (`501`), não há origem.
- **Correção:** use o painel certo para cada plataforma e, no caso da Uazapi, gere um evento de atendente/etiqueta. Não tente criar uma conexão inbound `uazapi` na mão — a API recusa de propósito ("Conexoes UAZAPI sao criadas automaticamente a partir da instancia WhatsApp").
- **Verificação:** a origem aparece em "Origens conectadas" com o número de canais, e **Nova regra** abre o formulário.

## Canal/número não aparece para escolher na regra (Umbler/Gupshup/Meta Cloud)

- **Diagnóstico:** a conexão existe, mas a regra não lista canal nenhum, ou a conexão mostra "Nenhum canal cadastrado ainda".
- **Causa:** o canal ainda não foi cadastrado. **Você não precisa esperar o primeiro webhook** — essa orientação está desatualizada.
- **Correção:** na conexão, use **Cadastrar canal/número** e informe o número conectado. O produto cria um canal provisório; quando a primeira mensagem real daquele número chegar, ela é mesclada no mesmo canal (nada duplica).
- **Verificação:** o canal aparece na conexão e fica selecionável em **Nova regra**.

## Meta Ads não conectado / relatórios falham com "meta not configured"

- **Diagnóstico:** `/integrations`; `GET /onboarding/status` (campo `metaConnected`).
- **Causa provável:** token do usuário do sistema não foi colado na UI de integrações do workspace atual, ou expirou/foi revogado no Meta Business Suite. Cuidado com a confusão mais comum: configurar o **Meta WhatsApp (Cloud API)** não conecta o **Meta Ads** — são duas integrações diferentes (veja [`meta-manual.md`](meta-manual.md#-não-confunda-são-duas-integrações-meta-diferentes)).
- **Correção:** siga [`meta-manual.md`](meta-manual.md) para gerar e colar um novo token no workspace certo.
- **Verificação:** `/integrations` mostra Meta conectado e os relatórios voltam a popular.

## Dokploy: crash-loop no deploy da API

- **Diagnóstico:** logs do serviço no painel do Dokploy, olhando as primeiras linhas após o boot.
- **Causa provável:** `DATABASE_URL`/`REDIS_URL` apontando para host externo em vez do host interno do Dokploy; falta de RAM durante o build (veja [`vps.md`](vps.md)); variável obrigatória ausente.
- **Correção:** ajuste a env para o host interno correto; se for RAM, aumente a VPS ou use build remoto do Dokploy; preencha a variável faltante.
- **Verificação:** deploy conclui, log mostra "migrations aplicadas" seguido do start da API sem reinício.

## Dokploy: falha ao clonar repositório Git público

- **Sintoma:** o deploy para antes do build com mensagens como `could not read Username for 'https://github.com'`, `expected flush after ref listing` ou falha no `git-upload-pack`, mesmo usando um repositório público.
- **Diagnóstico seguro:** no **host/worker do Dokploy**, e não no container da API, execute:
  ```bash
  GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c core.askPass= -c protocol.version=0 -c http.version=HTTP/1.1 ls-remote --heads https://github.com/samoskito/nod-rastrackdash-wpp.git refs/heads/main
  ```
  O resultado esperado termina em `refs/heads/main` e mostra o SHA da branch atual. Não forneça usuário, senha, token ou credencial GitHub.
- **Causa provável:** incompatibilidade/intermitência do Git/libcurl com HTTP/2 e Git protocol v2 no worker do Dokploy. A consulta de referências pode responder `200`, enquanto a etapa seguinte `git-upload-pack` falha com `401`; o Git então exibe uma mensagem enganosa de autenticação.
- **Correção no Dokploy afetado:** configure o Git do serviço Dokploy através de um arquivo persistente montado em `/etc/dokploy` e da variável `GIT_CONFIG_GLOBAL` do serviço. Em uma instalação Docker Swarm com serviço chamado `dokploy`, o operador pode aplicar:
  ```bash
  sudo sh -c 'printf "[http]\n\tversion = HTTP/1.1\n[protocol]\n\tversion = 0\n" > /etc/dokploy/gitconfig && chmod 644 /etc/dokploy/gitconfig && docker service update --env-add GIT_CONFIG_GLOBAL=/etc/dokploy/gitconfig dokploy'
  ```
  Se o nome do serviço ou o diretório persistente forem diferentes na versão instalada, confirme-os na tela/documentação do próprio Dokploy antes de executar. Essa correção é do host/worker; não é uma variável da aplicação nem um passo para colocar na URL do Git.
- **Verificação:** o serviço Dokploy converge, o novo deploy consegue clonar a branch e o build começa. Mantenha `Provider = Git`, a URL pública e a branch `main`.
- **Limite conhecido:** o deploy anterior marcado como concluído não prova sozinho que houve um clone limpo; o problema pode ser intermitente ou um cache anterior. Se a instalação nova não apresentar o sintoma, não aplique a correção por antecipação.

## Dokploy: API sobe nos logs mas o domínio não responde (parece crash-loop, mas não é)

- **Diagnóstico:** o log de runtime mostra "Nest application started"/start bem-sucedido, mas `curl` no domínio público retorna erro de conexão/`502`; confira a variável `API_PORT` no serviço e a "porta interna do container" configurada no Dokploy.
- **Causa provável:** `API_PORT` não foi definida como `3000` (o `Dockerfile` faz `EXPOSE 3000`, mas o padrão da aplicação sem essa variável é `3333`) — a API está de pé, só que numa porta diferente da que o Dokploy está escutando.
- **Correção:** defina `API_PORT=3000` na env do serviço da API e confirme que a porta interna do container configurada no Dokploy também é `3000` (veja [`dokploy.md`](dokploy.md#6-variáveis-de-ambiente-da-api)); redeploy.
- **Verificação:** `curl -s https://sua-api.seudominio.com/health` retorna `200`.

## Dokploy: build da API falha (`prisma generate`, `pnpm install` ou módulo não encontrado)

- **Diagnóstico:** log de **build** (não runtime) do serviço no painel do Dokploy; confira o diretório de build/contexto configurado no serviço.
- **Causa provável:** o diretório de build/contexto foi apontado para `apps/api` em vez da **raiz do repositório** — o `Dockerfile` precisa copiar `packages/shared` e os arquivos do workspace (`pnpm-workspace.yaml`, `turbo.json`) antes de compilar `apps/api`, e isso só existe se o contexto for a raiz.
- **Correção:** ajuste o diretório de build/contexto do serviço para a raiz do repositório (veja o passo 5 de [`dokploy.md`](dokploy.md#5-criar-o-serviço-da-api)); redeploy.
- **Verificação:** o build conclui sem erro de "arquivo não encontrado"/módulo ausente.

## `DATABASE_URL`/`REDIS_URL` malformada com senha gerada pelo Dokploy

- **Diagnóstico:** erro de parsing de URL ou de autenticação nos logs da API logo no boot, mesmo com host/porta/usuário corretos.
- **Causa provável:** a senha gerada tem caractere especial (`@ : / % # ?` etc.) e não foi URL-encoded ao montar a string de conexão.
- **Correção:** gere a versão codificada da senha (`node -e "console.log(encodeURIComponent('sua_senha'))"`) e substitua só a senha na URL — veja [`environment.md`](environment.md#banco-de-dados--autenticação).
- **Verificação:** `/health/ready` retorna `200` com o banco/Redis `ok`.

## URLs web/API não batem (produção)

- **Diagnóstico:** compare `NEXT_PUBLIC_API_URL` (web) com `API_PUBLIC_URL`/domínio real da API; teste `curl` direto na URL configurada no web.
- **Causa provável:** domínio da API mudou (novo deploy, novo subdomínio) e o web não foi atualizado, ou vice-versa.
- **Correção:** atualize `NEXT_PUBLIC_API_URL` no ambiente do web (Vercel/Dokploy) e faça redeploy do web — variáveis `NEXT_PUBLIC_*` só são aplicadas em build novo.
- **Verificação:** o web volta a carregar dados da API sem erro de rede/CORS.

## Domínio / HTTPS não valida

- **Diagnóstico:** confirme que o DNS do domínio aponta para o IP da VPS **antes** de pedir o certificado; `curl -sI https://seu-dominio` fora do servidor.
- **Causa provável:** propagação de DNS ainda não concluída, ou certificado pedido antes do DNS apontar corretamente.
- **Correção:** aguarde a propagação (minutos a poucas horas) e peça o certificado de novo pela UI do Dokploy.
- **Verificação:** `curl -sI https://seu-dominio` retorna `200`/`301` com certificado válido, sem aviso de segurança no navegador.

## Onde olhar logs

- **Local:** saída dos terminais rodando `pnpm --filter @wpptrack/api dev` / `pnpm --filter @wpptrack/web dev`, e `docker compose logs postgres redis`.
- **Dokploy:** aba de logs do serviço no painel, tanto para build quanto para runtime.
- **Nunca** cole um log com token/senha real em uma issue pública ou no chat de uma IA — redija (`***`) o valor sensível antes de compartilhar.
