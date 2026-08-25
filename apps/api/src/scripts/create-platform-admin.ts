import { PrismaClient } from "@prisma/client";
import { stdin, stderr } from "node:process";
import { bootstrapPlatformAdminUser } from "../auth/platform-admin-bootstrap";
import { loadLocalEnv } from "../config/load-env";

type ParsedArgs = {
  email?: string;
  confirmExisting: boolean;
};

loadLocalEnv();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.email) {
    throw new Error(
      "Uso: pnpm --filter @wpptrack/api platform-admin:create -- --email email@dominio.com [--confirm-existing]",
    );
  }

  const password = await readSecret();
  if (password.length < 8) {
    throw new Error("A senha deve ter ao menos 8 caracteres.");
  }

  const prisma = new PrismaClient();

  try {
    const result = await bootstrapPlatformAdminUser(prisma as never, {
      email: args.email,
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

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { confirmExisting: false };

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];

    if (key === "--confirm-existing") {
      parsed.confirmExisting = true;
      continue;
    }

    if (key === "--password" || key === "--password-stdin") {
      throw new Error(
        "Senha deve ser informada pelo prompt silencioso do terminal.",
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

async function readSecret(): Promise<string> {
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  }

  stderr.write("Senha do platform_owner: ");
  stdin.setRawMode?.(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stderr.write("\n");
    };

    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Entrada cancelada."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };

    stdin.on("data", onData);
  });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Falha no bootstrap");
  process.exit(1);
});
