-- 1.3.1 (revisao do #121): data em que o token Graph da conexao de
-- Formularios Meta foi salvo. O aviso "Reconecte a Pagina" / "Falta
-- permissao" passa a sumir so quando o token e trocado depois da falha, e nao
-- em qualquer edicao da conexao (rotulo, ativar).
-- Aditiva: uma coluna opcional nova; nenhuma tabela, coluna, indice ou
-- constraint existente e alterada ou removida. As conexoes que ja existem
-- recebem a data da ultima edicao (updatedAt), que era a referencia do aviso
-- ate a 1.3.0: nada muda na tela na atualizacao.
-- Idempotente: IF NOT EXISTS, e o preenchimento so toca linhas sem valor.

ALTER TABLE "MetaLeadFormConnection" ADD COLUMN IF NOT EXISTS "graphTokenUpdatedAt" TIMESTAMP(3);

UPDATE "MetaLeadFormConnection"
SET "graphTokenUpdatedAt" = "updatedAt"
WHERE "graphTokenUpdatedAt" IS NULL;
