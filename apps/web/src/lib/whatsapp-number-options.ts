import type { WhatsappConnectionDto } from "@wpptrack/shared";

/**
 * Fase 6.3b (porte do SaaS #106/#110/#119/#126): um número WhatsApp do
 * workspace nos filtros da Visão Geral, dos Relatórios e dos Leads. No nod o
 * número é a conexão (Uazapi BYO, WAHA etc.: URL do servidor + token, um
 * número por conexão), lida de `/integrations/whatsapp-connections`.
 * Sem imports de servidor: os componentes de cliente usam este arquivo.
 */
export type WhatsappNumberOption = {
  id: string;
  name: string;
  /** Telefone conectado, quando o provedor informa. */
  phone: string | null;
  /**
   * Conexão ativa. Uma conexão removida sai da lista, mas a URL com o id
   * dela continua valendo para o histórico.
   */
  active: boolean;
};

export function toWhatsappNumberOptions(
  connections: readonly WhatsappConnectionDto[],
): WhatsappNumberOption[] {
  return connections.map((connection) => ({
    id: connection.id,
    name: connection.displayName ?? connection.name,
    phone: connection.connectedPhone ?? null,
    active: connection.status === "active",
  }));
}

/** Nome mais o final do telefone mascarado (barra de filtros e avisos). */
export function whatsappNumberLabel(number: WhatsappNumberOption): string {
  const phone = number.phone?.trim();

  if (!phone) {
    return number.name;
  }

  const visibleSuffix = phone.slice(-4);

  return `${number.name} - ${phone.length <= 4 ? visibleSuffix : `•••• ${visibleSuffix}`}`;
}
