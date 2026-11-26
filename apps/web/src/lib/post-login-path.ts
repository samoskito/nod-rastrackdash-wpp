export const BACKOFFICE_HOME_PATH = "/backoffice/clients";
export const WORKSPACE_HOME_PATH = "/overview";

/**
 * Para onde ir depois do login.
 *
 * - Link explícito (redirectTo interno e válido) sempre vale.
 * - "/" e "/overview" sem mais nada contam como "sem destino": é o que o
 *   middleware grava quando alguém abre o painel direto sem estar logado.
 * - Sem destino, o administrador da plataforma vai para "Clientes e acessos"
 *   (é onde ele cria os workspaces); os demais vão para o painel do cliente.
 */
export function resolvePostLoginPath(
  redirectTo: string | null | undefined,
  platformRole: string | null | undefined,
): string {
  const safe = safeInternalPath(redirectTo);
  const isDefaultLanding =
    safe === null || safe === "/" || safe === WORKSPACE_HOME_PATH;

  if (!isDefaultLanding) {
    return safe;
  }

  return platformRole ? BACKOFFICE_HOME_PATH : (safe ?? WORKSPACE_HOME_PATH);
}

function safeInternalPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }

  try {
    const parsed = new URL(value, "http://wpptrack.local");

    if (parsed.origin !== "http://wpptrack.local") {
      return null;
    }

    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}
