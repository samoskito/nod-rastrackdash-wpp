import { PrismaClient } from "@prisma/client";
import { loadLocalEnv } from "../config/load-env";
import {
  runDashboardLeadsImport,
  supabaseRestSource,
} from "../dashboard-leads-import/dashboard-leads-import";

/**
 * Importa o histórico do Dashboard Leads (Supabase) para os workspaces.
 * Dry-run por padrão: mostra o que seria importado sem gravar nada.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   pnpm --filter @wpptrack/api dashboard-leads:import -- \
 *     --map locaville=<workspaceId> --map venerata=<workspaceId> [--apply]
 *
 * Passe as credenciais do Supabase só na linha de comando (nunca em arquivo
 * versionado). Passo a passo em docs/setup/dashboard-leads-import.md.
 */

export function parseArgs(argv: string[]): {
  apply: boolean;
  workspaceBySlug: Record<string, string>;
} {
  const workspaceBySlug: Record<string, string> = {};
  let apply = false;

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--apply") {
      apply = true;
    } else if (key === "--map") {
      const [slug, workspaceId] = (argv[index + 1] ?? "").split("=");
      if (!slug?.trim() || !workspaceId?.trim()) {
        throw new Error("--map espera slug=workspaceId");
      }
      workspaceBySlug[slug.trim()] = workspaceId.trim();
      index += 1;
    }
  }

  if (Object.keys(workspaceBySlug).length === 0) {
    throw new Error("Informe ao menos um --map slug=workspaceId");
  }

  return { apply, workspaceBySlug };
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
    const report = await runDashboardLeadsImport(
      prisma,
      supabaseRestSource(url, key),
      args,
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
