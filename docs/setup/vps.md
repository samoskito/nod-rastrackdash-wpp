# VPS — recomendação de dimensionamento

Não é um provisionador automático. Use-o para escolher a máquina **antes** do deploy.
A aplicação web em Next.js pode (e, na arquitetura PalmUP, costuma) ficar na **Vercel**; a VPS carrega principalmente **Dokploy + API Nest + PostgreSQL + Redis + workers**.

## Fontes

1. **Dokploy (oficial)** — documentação de instalação:
   > "To ensure a smooth experience with Dokploy, your server should have at least **2GB of RAM** and **30GB of disk space**. This specification helps to handle the resources consumed by Docker during builds and prevents system freezes."
   - Fonte: [Dokploy Installation — Requirements](https://github.com/Dokploy/website/blob/main/apps/docs/content/docs/core/installation.mdx)
   - Portas: 80, 443, 3000 (painel Dokploy)
2. **Stack RastrackDash / WppTrack** (código real):
   - API NestJS (Node 22) + Prisma
   - PostgreSQL 16
   - Redis 7 + BullMQ (filas: e-mail, meta sync, webhooks, CAPI, etc.)
   - Builds Docker no próprio host (pico de RAM/CPU na hora do deploy)
3. **Carga de produto** (ordem de grandeza, não é benchmark de laboratório):
   - 500 leads/dia ≈ **~0,35 lead/min** em média (picos no horário de anúncio)
   - Cada lead típico: 1–N webhooks Uazapi/WA + parsing + escrita no PostgreSQL + possível regra de conversão + enqueue CAPI/Meta
   - Em regime baixo/médio, o gargalo raramente é CPU sustentada; é **RAM** (Node + PostgreSQL + Redis + Dokploy/Traefik) e **I/O de disco** em build/migrate

## O que roda na VPS (cenário padrão do aluno)

| Componente | Papel | RAM ordem de grandeza (idle/leve) |
|---|---|---|
| Dokploy + Traefik + Docker overhead | PaaS / proxy | ~400–800 MB |
| API Nest (+ workers no mesmo processo ou sidecar) | webhooks, CAPI, autenticação | ~300–700 MB |
| PostgreSQL 16 | dados | ~200–500 MB (+ shared_buffers sob carga) |
| Redis 7 | filas/cache | ~50–150 MB |
| Pico de **build** Docker/pnpm | deploy | +1–2 GB temporários |

Conclusão: **2 GB totais é o piso do Dokploy sozinho para não travar no build** — não é um piso confortável para Dokploy **+** app completo sob build simultâneo. Por isso, a faixa "mínima viável do produto" sobe.

## Perguntas iniciais (IA deve fazer)

1. Quantos **clientes/workspaces** pretende rodar nesta instância?
2. Quantos **leads/dia** em média (e no pico de campanha)?
3. Vai rodar **build na mesma VPS** (build local do Dokploy) ou tem servidor de build separado?
4. A web fica na **Vercel** (recomendado) ou também na VPS?

## Faixas recomendadas (RastrackDash)

| Perfil | Workspaces | Leads/dia (média) | Pico de webhooks (ordem) | Faixa | Especificação sugerida | Observação |
|---|---|---|---|---|---|---|
| **Somente Dokploy (referência oficial)** | — | — | — | Piso Dokploy | **2 GB RAM / 30 GB disco** | Somente o painel; **não** recomenda rodar o app completo com folga |
| **Mínima do produto** | 1–5 | até ~500 | dezenas/min em pico curto | Mínima | **2 vCPU / 4 GB RAM / 60–80 GB SSD** | Dokploy + API + PostgreSQL + Redis; web na Vercel; evite build pesado e tráfego no mesmo instante |
| **Recomendada** | 5–20 | até ~5.000 | centenas/min em campanha | Padrão | **4 vCPU / 8 GB RAM / 120–160 GB SSD** | Folga para workers BullMQ, PostgreSQL, deploys e picos CTWA |
| **Alta** | 20+ ou múltiplas instâncias WA | >5.000 ou picos fortes | alto e sustentado | Alta | **4–8 vCPU / 16 GB RAM / 200 GB+ SSD** | Separe PostgreSQL ou workers; considere servidor de build remoto do Dokploy |
| **Não fazer** | — | — | — | — | 1 GB RAM / HDD lento | O Dokploy já alerta para travamentos em builds |

### Por que 500 leads/dia não exigem uma máquina enorme?

- 500/dia é carga **baixa** se bem enfileirada (BullMQ) e com webhooks idempotentes.
- O que drena uma máquina pequena:
  - **Build Docker** na mesma VPS (pnpm + Prisma)
  - Sync Meta Graph em fan-out
  - Falta de índices / queries pesadas nos relatórios
  - Muitas instâncias WhatsApp com loops de QR/reconexão
- Por isso, a **mínima do produto é 4 GB**, não 2 GB: 2 GB é o mínimo do Dokploy; o app precisa de teto acima do piso do PaaS.

### Separação recomendada (como a PalmUP)

- **Vercel:** frontend Next
- **VPS:** API + DB + Redis + Dokploy
- Opcional depois: Postgres gerenciado / Redis gerenciado / build server Dokploy

## Providers (links de afiliado PalmUP)

Placeholders até Samuel fornecer URLs reais:

- HostGator: `[AFILIADO_HOSTGATOR]`
- DigitalOcean: `[AFILIADO_DIGITALOCEAN]`
- Contabo: `[AFILIADO_CONTABO]`

O Dokploy também cita Hetzner como bom custo-benefício na documentação oficial (referência de mercado, não afiliado PalmUP).

## Checklist rápido pós-deploy

- RAM disponível em idle > 25%
- Disco livre > 20%
- O deploy não derruba o host (se derrubar, aumente a RAM ou use build remoto)
- Webhooks com p95 aceitável (sem fila crescendo sem parar no Redis/BullMQ)
