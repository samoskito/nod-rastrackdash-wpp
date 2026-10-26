import { inboundParserProductionEligible } from "./inbound-webhook-parser-eligibility";

/**
 * Fase 6.1c — produção direta (regra de produto do nod).
 *
 * O que foi validado no SaaS chega ao aluno em produção: a mesma plataforma
 * manda o mesmo payload, então o aluno não retesta, não certifica e não
 * libera nada. Por isso, quando o leitor (parser release) da integração é
 * validado (certificado por migration, ou o leitor nativo do Meta Cloud v1):
 *  - a conexão nasce em produção;
 *  - cada número (canal) nasce com o envio ativo;
 *  - a regra de conversão nasce enviando.
 *
 * A etapa de observação fica só para leitores que ainda não foram validados
 * (hoje nenhum do nod). As travas que não são "teste" continuam valendo no
 * envio: licença utilizável, rota Meta válida e destino com pixel e página.
 * Faltando rota ou pixel, nada é enviado e a tela diz o que configurar.
 */
export function productionDirectEligible(
  release:
    | {
        provider: string;
        version: string;
        status: string;
      }
    | null
    | undefined,
): boolean {
  // Sem a release em mãos, fail-closed: nasce como antes (sem envio).
  return Boolean(release) && inboundParserProductionEligible(release!);
}

/** Status de nascimento de uma conexão de entrada. */
export function bornConnectionStatus(release: {
  provider: string;
  version: string;
  status: string;
}): "production" | "observation" {
  return productionDirectEligible(release) ? "production" : "observation";
}

/**
 * Status de nascimento de um número numa conexão. A conexão pausada pelo
 * operador continua pausada: o número nasce ativo, mas só envia (e só ganha
 * a data de ativação) quando a conexão volta para produção.
 */
export function bornChannelState(
  connection: { status: string } | null | undefined,
  release: { provider: string; version: string; status: string } | null | undefined,
  activatedAt: Date,
): { status: "active" | "discovered"; productionActivatedAt: Date | null } {
  if (
    !connection ||
    !productionDirectEligible(release) ||
    (connection.status !== "production" && connection.status !== "paused")
  ) {
    return { status: "discovered", productionActivatedAt: null };
  }
  return {
    status: "active",
    productionActivatedAt:
      connection.status === "production" ? activatedAt : null,
  };
}
