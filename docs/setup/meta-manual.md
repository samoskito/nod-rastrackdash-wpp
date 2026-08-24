# Meta manual — usuário do sistema (edição aluno)

Passos curtos para conectar o Meta Ads sem OAuth da PalmUP.

## Pré-requisitos

- Conta do Gerenciador de Negócios do **cliente final** (ou da agência)
- Permissão para criar usuário do sistema e gerar token
- Instância RastrackDash no ar (`/integrations`)

## Passos

1. No Meta Business Suite → **Configurações do negócio** → **Usuários** → **Usuários do sistema**.
2. Crie (ou reutilize) um usuário do sistema com acesso aos ativos de anúncio necessários.
3. Gere um token com as permissões de leitura de insights/ads exigidas pela UI de integrações (não cole o token em issues/chat públicos).
4. No RastrackDash, abra **Integrações** → conexão Meta manual.
5. Cole o token **somente** no formulário da instância (fica no backend; nunca em `NEXT_PUBLIC_*`).
6. Confirme health/status “connected” e que o checklist de onboarding marca Meta.

## Verificação

- `/integrations` mostra Meta conectado
- `GET /onboarding/status` → `metaConnected: true` (com workspace ativo)
- Relatórios/leads deixam de falhar por “meta not configured”

## Segurança

- Rotacione o token se vazar
- Não commite `.env` nem captures de tela com token
- Prefira um usuário do sistema limitado ao Gerenciador de Negócios do cliente, e não um token pessoal de longa duração sem necessidade
