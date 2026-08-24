# Guia do aluno — da compra ao primeiro workspace

1. Receba da PalmUP a chave de licença e use o e-mail da sua conta como `LICENSE_ACCOUNT_IDENTITY`.
2. Leia o [README do aluno](../README.pt-BR.md) e confirme que você é o operador da instância; seus clientes serão workspaces dentro dela.
3. Escolha a VPS com o [guia de dimensionamento](setup/vps.md). A arquitetura recomendada usa Vercel para web e Dokploy para API, banco e Redis.
4. Clone o repositório, instale Node.js 20+, pnpm, Docker e Docker Compose.
5. Execute `pnpm setup -- --dry-run` e então `pnpm setup`; revise o `.env` criado sem versioná-lo.
6. Suba PostgreSQL e Redis, aplique as migrations e crie o primeiro administrador pelo fluxo indicado pelo setup.
7. Preencha `LICENSE_SERVER_URL`, `LICENSE_KEY` e `LICENSE_ACCOUNT_IDENTITY`; abra `/backoffice/license` e confirme que a licença está utilizável.
8. Crie seu primeiro workspace para um cliente final e confirme o checklist em `/backoffice`.
9. Conecte Meta pelo [guia manual](setup/meta-manual.md) e configure ao menos um provedor de WhatsApp BYO ou NOD API.
10. Se necessário, defina `BRAND_*` para sua agência, preservando o rodapé residual obrigatório `RastrackDash · powered by PalmUP`.
11. Faça o deploy e repita as verificações de `/backoffice`, `/backoffice/license` e `/integrations` no ambiente publicado.

Consulte a [matriz de aceite v1](release/ACCEPTANCE-v1.pt-BR.md) para saber exatamente o que foi verificado nesta versão.
