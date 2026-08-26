import { PrismaClient, type WorkspaceRole } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import {
  acquirePlatformWorkspaceWriteLocks,
  withWorkspaceUniqueRetry,
} from "../common/prisma/workspace-write-concurrency";
import { assertBcryptCompatiblePassword } from "../auth/password.service";
import { assertCliUserIsNotPlatformAdmin } from "./create-user-guards";

const ALLOWED_ROLES = new Set<WorkspaceRole>(["owner", "admin", "member"]);

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === "--force") {
      parsed.force = "true";
      continue;
    }

    if (!token?.startsWith("--")) {
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      continue;
    }

    parsed[token.slice(2)] = value;
    index += 1;
  }

  return parsed;
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .substring(0, 50);

  return slug || "workspace";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.email || !args.password) {
    throw new Error(
      'Uso: pnpm --filter @wpptrack/api create-user -- --email email@dominio.com --password senha-forte --name "Nome" --workspace "Minha Agencia" [--role owner|admin|member] [--force]',
    );
  }

  const email = args.email.toLowerCase().trim();
  const name = args.name?.trim() || email.split("@")[0];
  const workspaceName = args.workspace?.trim() || `${name}'s Workspace`;
  const workspaceSlug = args.slug
    ? slugify(args.slug.trim())
    : slugify(args.workspace || "workspace");
  const requestedRole = (args.role as WorkspaceRole | undefined) || "owner";

  if (!ALLOWED_ROLES.has(requestedRole)) {
    throw new Error("Role invalida. Use owner, admin ou member.");
  }

  const prisma = new PrismaClient();

  try {
    assertBcryptCompatiblePassword(args.password);
    const passwordHash = await bcrypt.hash(args.password, 12);
    const result = await withWorkspaceUniqueRetry(() =>
      prisma.$transaction(async (tx) => {
        await acquirePlatformWorkspaceWriteLocks(tx);

        let user = await tx.user.findUnique({
          where: { email },
          select: {
            id: true,
            email: true,
            passwordHash: true,
            emailVerifiedAt: true,
            platformRole: true,
          },
        });

        assertCliUserIsNotPlatformAdmin(user);

        if (user) {
          if (user.passwordHash && args.force !== "true") {
            throw new Error(
              "Usuario ja possui senha. Use --force para redefinir.",
            );
          }

          user = await tx.user.update({
            where: { id: user.id },
            data: {
              passwordHash,
              emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
            },
            select: {
              id: true,
              email: true,
              passwordHash: true,
              emailVerifiedAt: true,
              platformRole: true,
            },
          });
        } else {
          user = await tx.user.create({
            data: {
              email,
              name,
              passwordHash,
              authProvider: "email",
              emailVerifiedAt: new Date(),
            },
            select: {
              id: true,
              email: true,
              passwordHash: true,
              emailVerifiedAt: true,
              platformRole: true,
            },
          });
        }

        let workspace = await tx.workspace.findUnique({
          where: { slug: workspaceSlug },
        });

        if (!workspace) {
          workspace = await tx.workspace.create({
            data: { name: workspaceName, slug: workspaceSlug },
          });
        }

        const existingMember = await tx.workspaceMember.findUnique({
          where: {
            workspaceId_userId: { workspaceId: workspace.id, userId: user.id },
          },
        });

        if (!existingMember) {
          await tx.workspaceMember.create({
            data: {
              workspaceId: workspace.id,
              userId: user.id,
              role: requestedRole,
            },
          });
        }

        return {
          userId: user.id,
          workspaceId: workspace.id,
          role: existingMember?.role ?? requestedRole,
        };
      }),
    );

    console.log(
      JSON.stringify({
        ok: true,
        userId: result.userId,
        workspaceId: result.workspaceId,
        role: result.role,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Falha ao criar usuario",
  );
  process.exit(1);
});
