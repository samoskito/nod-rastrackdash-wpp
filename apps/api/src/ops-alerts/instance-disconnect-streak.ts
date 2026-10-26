/**
 * Fase 6.1c — alerta de desconexão do WhatsApp por conexão (porte do SaaS #63,
 * 6be4bdcd / 86aaac21, adaptado à Uazapi BYO e à WAHA do aluno).
 *
 * Uma leitura isolada de "desconectado" não basta: o alerta só dispara depois
 * de DISCONNECT_CONFIRMATIONS leituras seguidas. Estados passageiros ou
 * ambíguos nem contam nem quebram a sequência; uma leitura "conectado" zera a
 * sequência; erro ao ler o status nunca alerta.
 *
 * A sequência fica nas próprias linhas de WorkspaceOpsAlertDelivery (chave
 * `disconnect:<conexão>`), como no SaaS: sem tabela nova e compartilhada entre
 * instâncias da API.
 */

export type DisconnectObservation = "disconnected" | "connected" | "ambiguous";

/** Leituras seguidas de "desconectado" exigidas antes do alerta. */
export const DISCONNECT_CONFIRMATIONS = 2;

/** Providers do aluno conferidos (cada conexão tem um único número). */
export const DISCONNECT_ALERT_PROVIDERS = ["uazapi_byo", "waha"] as const;

/** Status da Uazapi que significam sessão encerrada, não só ociosa. */
const UAZAPI_DEFINITIVE_DISCONNECT = new Set([
  "disconnected",
  "closed",
  "logged_out",
  "loggedout",
]);

export const DISCONNECT_OBSERVED_DETAIL = "disconnect_observed streak=";
export const DISCONNECT_CONFIRMED_DETAIL = "disconnect_confirmed streak=";
export const CONNECTED_OBSERVED_DETAIL = "connected_observed";

/**
 * Classifica uma leitura de status.
 *
 * - Uazapi BYO: só "desconectado" quando o status bruto da instância diz que
 *   a sessão acabou (disconnected/closed/logged_out). Hibernada, offline,
 *   pendente, aguardando pareamento, erro ou sem status bruto: ambígua.
 * - WAHA: STOPPED (sessão parada no servidor do aluno) ou a sessão esperando
 *   ser pareada de novo no painel da WAHA. STARTING (subindo), FAILED e
 *   qualquer status desconhecido: ambígua.
 */
export function classifyDisconnectReading(reading: {
  provider: string;
  status: string;
  providerStatus: string | null;
}): DisconnectObservation {
  if (reading.status === "connected") return "connected";
  if (reading.provider === "uazapi_byo") {
    const raw = reading.providerStatus?.trim().toLowerCase() ?? "";
    return reading.status === "disconnected" &&
      UAZAPI_DEFINITIVE_DISCONNECT.has(raw)
      ? "disconnected"
      : "ambiguous";
  }
  if (reading.provider === "waha") {
    const raw = reading.providerStatus?.trim().toUpperCase() ?? "";
    if (reading.status === "disconnected" && raw === "STOPPED") {
      return "disconnected";
    }
    if (
      reading.status === "needs_reconnect" &&
      raw !== "" &&
      raw !== "STARTING"
    ) {
      return "disconnected";
    }
    return "ambiguous";
  }
  return "ambiguous";
}

/** Linha que registra um desconectado já confirmado (alerta enviado ou não). */
export function isConfirmedDisconnectDetail(
  detail: string | null | undefined,
): boolean {
  const value = detail ?? "";
  return (
    value.startsWith(DISCONNECT_CONFIRMED_DETAIL) ||
    value.startsWith("sent=") ||
    value === "debounced"
  );
}

/**
 * Sequência atual a partir da última linha da chave. Uma linha de confirmado
 * (alerta enviado, adiado pelo intervalo ou sem destino) mantém a sequência
 * confirmada, para a tela não "esquecer" o alerta na leitura seguinte.
 */
export function disconnectStreakFromDetail(
  detail: string | null | undefined,
): number {
  const value = detail ?? "";
  if (value.startsWith(DISCONNECT_OBSERVED_DETAIL)) {
    const streak = Number.parseInt(
      value.slice(DISCONNECT_OBSERVED_DETAIL.length),
      10,
    );
    return Number.isFinite(streak) && streak > 0 ? streak : 0;
  }
  if (value.startsWith(DISCONNECT_CONFIRMED_DETAIL)) {
    const streak = Number.parseInt(
      value.slice(DISCONNECT_CONFIRMED_DETAIL.length),
      10,
    );
    return Number.isFinite(streak) && streak >= DISCONNECT_CONFIRMATIONS
      ? streak
      : DISCONNECT_CONFIRMATIONS;
  }
  return isConfirmedDisconnectDetail(value) ? DISCONNECT_CONFIRMATIONS : 0;
}

export function disconnectAlertKey(whatsappInstanceId: string): string {
  return `disconnect:${whatsappInstanceId}`;
}

/** Alerta de desconexão confirmado de uma conexão WhatsApp (tela do aluno). */
export type WhatsappDisconnectAlertState = {
  /** Primeira confirmação da sequência atual (2ª leitura de desconectado). */
  confirmedAt: string;
  /** Última leitura registrada desta sequência. */
  lastCheckedAt: string;
};

type DeliveryReader = {
  workspaceOpsAlertDelivery: {
    findFirst(args: unknown): Promise<{
      detail?: string | null;
      createdAt: Date;
    } | null>;
  };
};

/**
 * Alerta confirmado de cada conexão do workspace, lido das linhas do alerta
 * (sem chamar o provedor). Some na primeira leitura "conectado".
 */
export async function readDisconnectAlertStates(
  client: DeliveryReader,
  workspaceId: string,
  whatsappInstanceIds: readonly string[],
): Promise<Map<string, WhatsappDisconnectAlertState>> {
  const states = new Map<string, WhatsappDisconnectAlertState>();
  for (const id of whatsappInstanceIds) {
    const alertKey = disconnectAlertKey(id);
    const last = await client.workspaceOpsAlertDelivery.findFirst({
      where: { workspaceId, alertKey },
      orderBy: { createdAt: "desc" },
      select: { detail: true, createdAt: true },
    });
    if (!last || !isConfirmedDisconnectDetail(last.detail)) continue;
    const reset = await client.workspaceOpsAlertDelivery.findFirst({
      where: { workspaceId, alertKey, detail: CONNECTED_OBSERVED_DETAIL },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const first = await client.workspaceOpsAlertDelivery.findFirst({
      where: {
        workspaceId,
        alertKey,
        ...(reset ? { createdAt: { gt: reset.createdAt } } : {}),
        OR: [
          { detail: { startsWith: DISCONNECT_CONFIRMED_DETAIL } },
          { detail: { startsWith: "sent=" } },
          { detail: "debounced" },
        ],
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    states.set(id, {
      confirmedAt: (first ?? last).createdAt.toISOString(),
      lastCheckedAt: last.createdAt.toISOString(),
    });
  }
  return states;
}
