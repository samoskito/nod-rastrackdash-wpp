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

## Licença `403`/"não configurada"

- **Diagnóstico:** `/backoffice/license`; log da API no momento da ativação (`activate()`).
- **Causa provável:** `LICENSE_ACCOUNT_IDENTITY` não é exatamente o e-mail da conta vinculada à chave (retorna `403`), ou `LICENSE_KEY`/`LICENSE_SERVER_URL` estão vazios/errados ("não configurada").
- **Correção:** confirme com a PalmUP qual e-mail está vinculado à chave e ajuste `LICENSE_ACCOUNT_IDENTITY` para bater exatamente; confirme que `LICENSE_KEY` foi colada sem espaços extras.
- **Verificação:** `/backoffice/license` mostra `usable: true`.

## WhatsApp não conecta (Uazapi / WAHA / Z-API)

- **Diagnóstico:** `/integrations` mostra o status de saúde reportado pelo provedor (`connected`/`needs_reconnect`/`disconnected`/`error`); confira se as variáveis do provedor escolhido estão preenchidas (veja [`environment.md`](environment.md)).
- **Causa provável:**
  - `needs_reconnect`: sessão/instância precisa escanear QR de novo na sua própria instância Uazapi/WAHA/Z-API (fora deste template).
  - `disconnected`: variáveis do provedor ausentes ou instância parada.
  - `error`: URL/token errados ou instância inacessível pela rede onde a API roda.
- **Correção:** reconecte diretamente no painel/instância do provedor; confirme host/porta acessíveis a partir do servidor da API (não só do seu navegador).
- **Verificação:** `/integrations` volta a mostrar `connected` para o provedor.

## Meta não conectado / relatórios falham com "meta not configured"

- **Diagnóstico:** `/integrations`; `GET /onboarding/status` (campo `metaConnected`).
- **Causa provável:** token do usuário do sistema não foi colado na UI de integrações do workspace atual, ou expirou/foi revogado no Meta Business Suite.
- **Correção:** siga [`meta-manual.md`](meta-manual.md) para gerar e colar um novo token no workspace certo.
- **Verificação:** `/integrations` mostra Meta conectado e os relatórios voltam a popular.

## Dokploy: crash-loop no deploy da API

- **Diagnóstico:** logs do serviço no painel do Dokploy, olhando as primeiras linhas após o boot.
- **Causa provável:** `DATABASE_URL`/`REDIS_URL` apontando para host externo em vez do host interno do Dokploy; falta de RAM durante o build (veja [`vps.md`](vps.md)); variável obrigatória ausente.
- **Correção:** ajuste a env para o host interno correto; se for RAM, aumente a VPS ou use build remoto do Dokploy; preencha a variável faltante.
- **Verificação:** deploy conclui, log mostra "migrations aplicadas" seguido do start da API sem reinício.

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
