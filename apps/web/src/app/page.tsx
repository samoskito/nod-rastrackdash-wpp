import { redirect } from "next/navigation";
import {
  BACKOFFICE_HOME_PATH,
  WORKSPACE_HOME_PATH,
} from "../lib/post-login-path";
import { serverApiFetch } from "../lib/server-api";

type HomeSession = {
  user?: { platformRole?: string | null };
  supportContext?: unknown;
};

export default async function HomePage() {
  let session: HomeSession | undefined;

  try {
    session = await serverApiFetch<HomeSession>("/auth/me");
  } catch {
    session = undefined;
  }

  // Administrador da plataforma sem acesso de suporte aberto vai direto para
  // "Clientes e acessos". Quem está em acesso de suporte segue no workspace.
  if (session?.user?.platformRole && !session.supportContext) {
    redirect(BACKOFFICE_HOME_PATH);
  }

  redirect(WORKSPACE_HOME_PATH);
}
