# Prompt oficial de onboarding com IA (pt-BR)

Este é o prompt que você (aluno) cola em um agente de IA — Claude Code, Codex CLI/App, ou similar — logo depois de clonar o repositório. Ele existe para que alguém sem experiência prévia em DevOps consiga sair do zero até uma instância rodando, com a IA explicando cada passo, validando antes de seguir e nunca manuseando seus segredos.

## Como usar

1. Compre a licença e receba a chave da PalmUP (e-mail/WhatsApp).
2. Clone o repositório e abra a pasta no Claude Code ou no Codex.
3. Cole o prompt abaixo **exatamente como está** (não precisa editar nada antes de colar — a própria IA vai perguntar o que falta).
4. Responda às perguntas da IA. Quando ela pedir um valor secreto (senha, token, chave), **digite você mesmo** no terminal, no `.env` local ou na UI do provedor — nunca no chat.

## O prompt

```text
Você vai me ajudar a instalar e configurar o RastrackDash a partir deste
repositório clonado, do zero até uma instância rodando de verdade.

1. Leia, nesta ordem: AGENTS.md, docs/AI_AGENTS.md, este arquivo
   (docs/AI_ONBOARDING_PROMPT.pt-BR.md), docs/GUIA-ALUNO.md e o índice
   docs/setup/README.md. Não presuma nada sobre o estado do projeto sem
   conferir o código e esses documentos.

2. Antes de rodar qualquer comando, me pergunte (sem segredos, só decisões):
   a) Alvo do deploy: Docker local (dev/homolog na minha máquina),
      VPS com Dokploy, ou outro provedor (Vercel + outro host)?
   b) Quantos workspaces/clientes finais pretendo rodar e quantos
      leads/dia em média — só para dimensionar (docs/setup/vps.md).
   c) Quais provedores de WhatsApp pretendo usar: Uazapi BYO, NOD API
      (add-on licenciado PalmUP), WAHA (self-host) e/ou Z-API.
   d) Se quero personalizar marca (whitelabel) desde já ou depois.
   Não avance para comandos até eu responder essas perguntas.

3. Nunca me peça para colar senha, token, chave de API, chave de licença
   ou qualquer segredo aqui no chat, e nunca escreva um valor secreto real
   nos seus próprios comandos ou logs. Quando um passo exigir um segredo:
   - me diga exatamente qual variável preencher e onde (arquivo `.env`
     local, ou campo específico da UI do provedor: Dokploy, Vercel, etc.);
   - me diga para editar/colar esse valor eu mesmo, fora do chat;
   - só depois disso, valide o resultado (ex.: um endpoint de status)
     sem nunca me pedir para reexibir o segredo.

4. Siga a ordem de docs/setup/README.md (local ou Dokploy, conforme minha
   resposta no passo 2): ambiente → banco/Redis → migrations →
   `LICENSE_*` → primeiro admin → primeiro workspace → Meta manual →
   WhatsApp → marca opcional → verificação pós-deploy.

5. Para cada passo:
   - explique em 1-3 frases o que vamos fazer e por quê;
   - proponha **um** comando ou ação segura por vez (nada destrutivo,
     nada que apague dados sem eu confirmar antes);
   - rode/peça para eu rodar, mostre o resultado;
   - valide (health check, `/backoffice`, `GET /onboarding/status`,
     `/backoffice/license`, logs) antes de propor o próximo passo;
   - se der erro, pare, leia docs/setup/troubleshooting.md e me proponha
     o diagnóstico e a correção antes de tentar de novo.

6. Nunca invente endpoints privados da PalmUP, campos exatos de UI do
   Dokploy que você não confirmou comigo, nem automações que este
   repositório não suporta. Se não tiver certeza, diga que não tem certeza
   e me peça para conferir na tela.

7. Nunca remova o rodapé residual "RastrackDash · powered by PalmUP" nem
   sugira uma forma de escondê-lo — é uma regra fixa do produto
   (docs/CUSTOMIZATION.md).

8. Ao final, monte comigo um checklist de evidências, sem nenhum valor
   secreto:
   - `GET /health` e `GET /health/ready` respondendo OK;
   - `/backoffice` com o checklist de onboarding completo;
   - `/backoffice/license` mostrando licença utilizável;
   - `/integrations` com Meta e ao menos um provedor de WhatsApp
     conectados;
   - lista dos passos que ficaram pendentes ou que eu decidi pular,
     e por quê.

Pergunte agora: chave de licença já em mãos? Alvo (Docker local /
Dokploy / outro)? Quantos clientes e leads/dia (aproximado)? Quais
provedores de WhatsApp?
```

## O que esperar da IA depois de colar o prompt

- Perguntas de decisão (não segredos) antes do primeiro comando.
- Um passo por vez, com explicação curta, comando único e validação.
- Pedidos explícitos para você digitar segredos fora do chat, nunca a IA pedindo para colá-los.
- Parada e diagnóstico guiado (ver [`docs/setup/troubleshooting.md`](setup/troubleshooting.md)) sempre que um comando falhar, em vez de insistir cegamente.
- Um checklist final sem segredos, cobrindo saúde da API, licença, Meta e WhatsApp.

## Limites conhecidos

- A IA não tem acesso ao servidor de licenças, ao Guru nem ao Asaas da PalmUP — esses serviços são privados (veja [`docs/ops/palmup-license-runbook.md`](ops/palmup-license-runbook.md)).
- Ela não conhece os rótulos exatos da UI do Dokploy além do que está documentado aqui; sempre vai pedir para você confirmar o que está vendo na tela antes de prosseguir.
- Ela não substitui a leitura humana do [`docs/GUIA-ALUNO.md`](GUIA-ALUNO.md) — use este prompt como copiloto, não como piloto automático sem supervisão.
