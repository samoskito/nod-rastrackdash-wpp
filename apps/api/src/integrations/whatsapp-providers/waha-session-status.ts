import type { IntegrationStatus } from "@wpptrack/shared";

/**
 * Status da sessão da WAHA (`GET /api/sessions/{s}` e evento
 * `session.status`) traduzido para o status de integração do app.
 *
 * - WORKING: conectada.
 * - SCAN_QR_CODE: o aluno precisa ler o QR no painel da WAHA dele.
 * - STARTING: subindo; tratada como reconexão pendente, não como erro.
 * - STOPPED: sessão parada no servidor do aluno.
 * - FAILED (ou qualquer valor desconhecido): erro.
 */
export function mapWahaSessionStatus(status: string | null): IntegrationStatus {
  switch (status) {
    case "WORKING":
    case "authenticated":
      return "connected";
    case "SCAN_QR_CODE":
    case "STARTING":
      return "needs_reconnect";
    case "STOPPED":
      return "disconnected";
    case "FAILED":
    default:
      return "error";
  }
}

export function wahaSessionStatusMessage(
  status: string | null,
): string | undefined {
  switch (status) {
    case "WORKING":
    case "authenticated":
      return undefined;
    case "SCAN_QR_CODE":
      return "WAHA session requires QR reconnection";
    case "STARTING":
      return "WAHA session is starting";
    case "STOPPED":
      return "WAHA session stopped";
    case "FAILED":
      return "WAHA session error";
    default:
      return "WAHA session API returned an unknown status";
  }
}
