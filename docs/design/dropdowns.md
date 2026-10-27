# Dropdowns (selects) da plataforma

**Padrão:** `<select>` nativo com o visual dos filtros da Visão geral e de
Relatórios ("Todas as contas", "Todos os BMs", "Todos os números"). Não há
componente React: o visual vem do CSS.

- Dentro do app (`.app-shell`), **todo `<select>` já recebe o padrão
  automaticamente** pelo bloco "Platform dropdown" no fim de
  `apps/web/src/styles/globals.css`. Não precisa de classe, wrapper ou
  estilo próprio.
- Fora do app (login, backoffice), use a classe `.filter-control`, que é a
  mesma referência visual.
- Seleção com busca ou múltipla escolha usa os componentes customizados já
  existentes (`.filter-combobox` / `AdAccountFilter`, `.searchable-select`),
  com o mesmo fundo, borda e foco.

## O que o padrão define

| Item | Valor |
| --- | --- |
| Fundo | `rgba(5, 8, 7, 0.84)` + brilho sutil no topo (preto) |
| Texto | `var(--ink)` (branco), Hanken Grotesk 750, 13px |
| Borda | `1px solid var(--border)`, cantos de 8px |
| Seta | chevron próprio desenhado no fundo, cor `var(--ink-muted)` |
| Hover | borda `rgba(190, 226, 215, 0.22)` |
| Foco | borda menta + anel `0 0 0 3px rgba(18, 184, 132, 0.16)` |
| Desativado | opacidade 0.62, texto `var(--ink-soft)`, cursor bloqueado |
| Opções | fundo `var(--graphite-900)`, texto branco (onde o navegador permite) |

O contexto (formulário, tabela, modal) define apenas tamanho: largura,
altura e padding vertical. Não redefina fundo, borda, raio, fonte ou seta de
um select em regras de contexto. Os selects com `.filter-control` (barra
compacta de Relatórios/Eventos) mantêm o raio e o tamanho de fonte do
contexto.

O `<select>` continua nativo: teclado, leitores de tela e o seletor do
celular funcionam sem mudança.
