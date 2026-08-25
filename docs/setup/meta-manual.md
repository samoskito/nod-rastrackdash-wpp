# Meta manual — usuário do sistema (edição aluno)

Este é o único caminho do MVP do aluno: **sem login social Facebook e sem OAuth como alternativa**. Antes de abrir a Meta, defina `META_CONNECTION_MODES=manual` no ambiente da API e faça redeploy. Se as capabilities não carregarem, a tela deve permanecer fechada; não tente contornar isso com OAuth.

O handshake do webhook da Meta usa `META_WEBHOOK_VERIFY_TOKEN` e o roteamento dos eventos é por `page_id` até o workspace certo — contrato confirmado em [`whatsapp-providers.md`](whatsapp-providers.md#matriz-de-autenticação-de-webhook), junto com o dos demais provedores.

## Pré-requisitos

- Conta do Gerenciador de Negócios (BM) do **cliente final** ou da agência, com acesso ao App, Pixel, Página do Facebook e conta de anúncios corretos
- Permissão para criar usuário do sistema e gerar token; App ID configurado na API quando o seu fluxo o exigir
- Instância RastrackDash no ar, licença utilizável, administrador já validado em `/backoffice/clients` e workspace selecionado

## Passos

1. No Meta Business Suite, abra **Configurações do negócio** → **Usuários** → **Usuários do sistema** e crie (ou reutilize) um usuário do sistema limitado ao BM correto.
2. Atribua ao usuário somente os ativos necessários: BM, conta de anúncios, Pixel e Página do Facebook que serão usados pelo workspace. Confirme que a conta de anúncios está ativa.
3. Gere um token de usuário do sistema com as permissões exigidas pela operação, incluindo `ads_read` e `business_management`; use as permissões adicionais apenas quando a UI/fluxo Meta pedir. Prefira token permanente de usuário do sistema quando sua política Meta permitir, em vez de token pessoal.
4. No RastrackDash, abra **Integrações** no workspace correto e escolha a conexão manual. Informe o App ID e cole o token somente no formulário da instância; ele fica no backend, nunca em `NEXT_PUBLIC_*`, `.env` público, Git ou chat.
5. Teste/salve a conexão e faça a descoberta dos ativos. Se a validação falhar, corrija permissões, BM ou token na Meta antes de seguir.
6. Selecione explicitamente o BM, a conta de anúncios para relatórios, o Pixel e a Página que receberão a conversão. Salve o destino e valide a seleção no workspace.

## Verificação

- `/integrations` mostra a conexão manual Meta como conectada, os ativos descobertos e o destino (BM/Pixel/Página/conta) selecionado
- `GET /onboarding/status` → `metaConnected: true` (com workspace ativo)
- Relatórios/leads deixam de falhar por “meta not configured”

## Segurança

- Rotacione o token se vazar
- Não commite `.env` nem captures de tela com token
- Prefira um usuário do sistema limitado ao Gerenciador de Negócios do cliente, e não um token pessoal de longa duração sem necessidade
- Não envie App ID/token por chat e nunca use `***` como valor de token; `***` só redige valores em logs compartilhados
