import { PrismaClient } from "@prisma/client";
import { stdin } from "node:process";
import { bootstrapPlatformAdminUser } from "../auth/platform-admin-bootstrap";
import { loadLocalEnv } from "../config/load-env";

type ParsedArgs = {
  email?: string;
  confirmExisting: boolean;
};

async function main(): Promise<void> {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  const email = resolveEmail(args);

  if (!email) {
    throw new Error(
      "Informe --email email@dominio.com ou defina SETUP_PLATFORM_ADMIN_EMAIL.",
    );
  }

  const password = await resolvePassword();

  const prisma = new PrismaClient();

  try {
    const result = await bootstrapPlatformAdminUser(prisma as never, {
      email,
      password,
      confirmExisting: args.confirmExisting,
    });

    console.log(
      JSON.stringify({
        ok: true,
        email: result.email,
        userId: result.userId,
        platformRole: result.platformRole,
        createdUser: result.createdUser,
        changedRole: result.changedRole,
        passwordPreserved: result.passwordPreserved,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

export function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { confirmExisting: false };

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];

    if (key === "--confirm-existing") {
      parsed.confirmExisting = true;
      continue;
    }

    if (key === "--password" || key === "--password-stdin") {
      throw new Error(
        "Senha por argumento nao e aceita. Use SETUP_PLATFORM_ADMIN_PASSWORD ou pipe.",
      );
    }

    if (key === "--email" && args[index + 1]) {
      parsed.email = args[index + 1];
      index += 1;
      continue;
    }

    if (key?.startsWith("--")) {
      throw new Error(`Opcao desconhecida: ${key}`);
    }
  }

  return parsed;
}

export function resolveEmail(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    args.email?.trim() || env.SETUP_PLATFORM_ADMIN_EMAIL?.trim() || undefined
  );
}

export async function resolvePassword(
  env: NodeJS.ProcessEnv = process.env,
  input: Pick<NodeJS.ReadStream, "isTTY" | typeof Symbol.asyncIterator> = stdin,
): Promise<string> {
  const fromEnv = env.SETUP_PLATFORM_ADMIN_PASSWORD;
  if (fromEnv?.trim()) {
    return fromEnv;
  }

  if (input.isTTY) {
    throw new Error(
      "Defina SETUP_PLATFORM_ADMIN_PASSWORD ou forneca a senha por pipe; leitura interativa nao e suportada.",
    );
  }

  return readPasswordFromPipe(input);
}

async function readPasswordFromPipe(
  input: Pick<NodeJS.ReadStream, typeof Symbol.asyncIterator>,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Falha no bootstrap",
    );
    process.exit(1);
  });
}
