import { conversionEventBuilderLabel } from "@wpptrack/shared";

/**
 * O catálogo de eventos do pacote shared é ASCII de propósito (teste de
 * contrato em packages/shared). As telas mostram o texto com acentos.
 */
const accents: ReadonlyArray<[RegExp, string]> = [
  [/\bNao\b/gu, "Não"],
  [/\bnao\b/gu, "não"],
  [/\be enviado\b/gu, "é enviado"],
  [/\bO valor e opcional\b/gu, "O valor é opcional"],
  [/\bmaximo\b/gu, "máximo"],
  [/\bConteudo\b/gu, "Conteúdo"],
  [/\bpagina\b/gu, "página"],
  [/\bintencao\b/gu, "intenção"],
  [/\bextraido\b/gu, "extraído"],
  [/\bexpedicao\b/gu, "expedição"],
  [/\boperacoes\b/gu, "operações"],
  [/\boperacao\b/gu, "operação"],
  [/\bfisico\b/gu, "físico"],
  [/\bAvaliacao\b/gu, "Avaliação"],
  [/\bComentario\b/gu, "Comentário"],
  [/\bmonetario\b/gu, "monetário"],
  [/\bvez por lead\b/gu, "vez por lead"],
];

export function accentEventCopy(text: string): string {
  return accents.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text,
  );
}

/** Rótulo do evento com acentos, para as telas de Conversões. */
export function ruleEventLabel(eventName: string): string {
  return accentEventCopy(conversionEventBuilderLabel(eventName));
}
