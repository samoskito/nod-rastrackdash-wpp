import type { WhatsappConnectionDto } from "@wpptrack/shared";

/**
 * Fase 6.1c (porte do SaaS #63): aviso de desconexão confirmada de uma
 * conexão Uazapi BYO ou WAHA. A API só marca o alerta depois de 2 leituras
 * seguidas de "desconectado" na API de status do provedor; uma leitura
 * isolada, um estado passageiro ou um erro de leitura nunca aparecem aqui.
 */
export function whatsappDisconnectAlertText(
  connection: Pick<WhatsappConnectionDto, "provider" | "disconnectAlert">,
  formatDateTime: (iso: string) => string = defaultFormat,
): string | null {
  const alert = connection.disconnectAlert;
  if (!alert) return null;
  const panel =
    connection.provider === "waha"
      ? "no painel da sua WAHA (sessão parada ou esperando ser pareada de novo)"
      : "no painel da sua Uazapi";
  return `WhatsApp desconectado desde ${formatDateTime(alert.confirmedAt)}: o status do provedor confirmou a desconexão em 2 leituras seguidas. Enquanto isso, as conversas deste número não chegam. Reconecte o número ${panel} e use “Testar” para conferir.`;
}

function defaultFormat(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(date);
}
