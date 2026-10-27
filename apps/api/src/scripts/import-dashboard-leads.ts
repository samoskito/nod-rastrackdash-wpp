import { PrismaClient } from "@prisma/client";
import { loadLocalEnv } from "../config/load-env";
import { LicenseClientService } from "../licensing-client/license-client.service";
import {
  runDashboardLeadsImport,
  supabaseRestSource,
  type CreateWorkspacesOption,
} from "../dashboard-leads-import/dashboard-leads-import";

/**
 * Importa o histórico do Dashboard Leads (Supabase) para os workspaces.
 * Dry-run por padrão: mostra o que seria importado sem gravar nada.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   pnpm --filter @wpptrack/api dashboard-leads:import -- \
 *     --create-workspaces --owner-email <login de cliente> \
 *     --actor-email <login de plataforma> [--map slug=<workspaceId>] [--apply]
 *
 * --create-workspaces cria uma empresa (workspace) por projeto ativo, todas
 * do mesmo login de cliente; sem ela, cada projeto precisa de um --map.
 *
 * Passe as credenciais do Supabase só na linha de comando (nunca em arquivo
 * versionado). Passo a passo em docs/setup/dashboard-leads-import.md.
 */

export type ImportArgs = {
  apply: boolean;
  workspaceBySlug: Record<string, string>;
  createWorkspaces: boolean;
  ownerEmail?: string;
  actorEmail?: string;
};

export function parseArgs(argv: string[]): ImportArgs {
  const workspaceBySlug: Record<string, string> = {};
  let apply = false;
  let createWorkspaces = false;
  let ownerEmail: string | undefined;
  let actorEmail: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--apply") {
      apply = true;
    } else if (key === "--create-workspaces") {
      createWorkspaces = true;
    } else if (key === "--owner-email" || key === "--actor-email") {
      const value = argv[index + 1]?.trim();
      if (!value) throw new Error(`${key} espera um e-mail`);
      if (key === "--owner-email") ownerEmail = value;
      else actorEmail = value;
      index += 1;
    } else if (key === "--map") {
      const [slug, workspaceId] = (argv[index + 1] ?? "").split("=");
      if (!slug?.trim() || !workspaceId?.trim()) {
        throw new Error("--map espera slug=workspaceId");
      }
      workspaceBySlug[slug.trim()] = workspaceId.trim();
      index += 1;
    }
  }

  if (createWorkspaces && (!ownerEmail || !actorEmail)) {
    throw new Error(
      "--create-workspaces exige --owner-email (login de cliente) e --actor-email (login de plataforma)",
    );
  }
  if (!createWorkspaces && Object.keys(workspaceBySlug).length === 0) {
    throw new Error(
      "Informe --create-workspaces ou ao menos um --map slug=workspaceId",
    );
  }

  return { apply, workspaceBySlug, createWorkspaces, ownerEmail, actorEmail };
}

/**
 * nod: an --apply run writes like the panel does, so a blocked license
 * refuses it (the HTTP writes answer 423). Licensing off (no
 * LICENSE_SERVER_URL) never blocks, as in the guard.
 */
export function licenseWriteAssertion(
  license: Pick<LicenseClientService, "getLockState">,
): () => Promise<void> {
  return async () => {
    const decision = await license.getLockState();
    if (decision.locked) {
      throw new Error(
        "Licença bloqueada: a importação com --apply está desativada. Reative a licença em /backoffice/license e rode de novo.",
      );
    }
  };
}

/**
 * Same rules as the backoffice screen: the owner is an activated client login
 * (never a platform user); the actor recorded in the audit is a platform owner.
 */
export async function resolveCreateWorkspaces(
  prisma: Pick<PrismaClient, "user">,
  ownerEmail: string,
  actorEmail: string,
): Promise<CreateWorkspacesOption> {
  const [owner, actor] = await Promise.all([
    prisma.user.findFirst({
      where: { email: { equals: ownerEmail, mode: "insensitive" } },
      select: { id: true, passwordHash: true, platformRole: true },
    }),
    prisma.user.findFirst({
      where: {
        email: { equals: actorEmail, mode: "insensitive" },
        platformRole: "platform_owner",
      },
      select: { id: true },
    }),
  ]);

  if (!owner) throw new Error("--owner-email não corresponde a nenhum usuário.");
  if (owner.platformRole) {
    throw new Error(
      "Um administrador da plataforma não pode ser responsável de cliente: use o login de cliente em --owner-email.",
    );
  }
  if (!owner.passwordHash) {
    throw new Error("O login de --owner-email ainda não foi ativado.");
  }
  if (!actor) {
    throw new Error("--actor-email não pertence a um Platform Owner ativo.");
  }

  return { ownerUserId: owner.id, actorUserId: actor.id };
}

async function main() {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente.");
  }

  const prisma = new PrismaClient();
  try {
    const createWorkspaces = args.createWorkspaces
      ? await resolveCreateWorkspaces(prisma, args.ownerEmail!, args.actorEmail!)
      : undefined;
    const report = await runDashboardLeadsImport(
      prisma,
      supabaseRestSource(url, key),
      {
        apply: args.apply,
        workspaceBySlug: args.workspaceBySlug,
        createWorkspaces,
        assertCanWrite: licenseWriteAssertion(
          new LicenseClientService(prisma as never, process.env),
        ),
      },
    );
    console.log(JSON.stringify(report, null, 2));
    if (!args.apply) {
      console.log("Dry-run: nada foi gravado. Rode de novo com --apply.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
