import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { MetaCloudAppSecretSourceDto } from "@wpptrack/shared";
import type { RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";

/**
 * App Secret do app Meta por conexão Meta Cloud.
 *
 * Agências têm um app Meta por BM de cliente: um único META_APP_SECRET no
 * ambiente só valida a assinatura de um deles. Cada conexão `meta_cloud` pode
 * guardar o App ID e o App Secret do próprio app. A regra de resolução é
 * única e vale em todo lugar (assinatura, nascer em produção, ativação,
 * intake, replay e inscrição na WABA):
 *
 *   1. o segredo da conexão, se estiver configurado;
 *   2. senão, o META_APP_SECRET do ambiente da API (instalação com um app só);
 *   3. senão, nenhum.
 *
 * O segredo fica cifrado com a mesma chave e o mesmo algoritmo dos payloads
 * de webhook (INBOUND_WEBHOOK_ENCRYPTION_KEY, AES-256-GCM), com um contexto
 * próprio (AAD) amarrado ao workspace e à conexão: o valor copiado para outra
 * linha não decifra. Nunca é devolvido, logado nem auditado.
 */
export type MetaCloudAppSecretSource = MetaCloudAppSecretSourceDto;

export type MetaCloudAppSecretConnection = {
  id: string;
  workspaceId: string;
  provider: string;
  metaAppId?: string | null;
  metaAppSecretEncrypted?: string | null;
};

const ALGORITHM = "aes-256-gcm";
const FORMAT_VERSION = "v1";
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const ASSOCIATED_DATA_PREFIX = "wpptrack:meta-cloud-app-secret:v1";
const ENCRYPTION_ERROR = "Meta Cloud app secret encryption failed";
const DECRYPTION_ERROR = "Meta Cloud app secret decryption failed";

function encryptionKey(env: RuntimeEnv): Buffer {
  const config = parseInboundWebhooksConfig(env);
  if (!config.enabled) throw new Error(ENCRYPTION_ERROR);
  return config.encryptionKey;
}

function associatedData(context: {
  workspaceId: string;
  connectionId: string;
}): Buffer {
  for (const value of [context.workspaceId, context.connectionId]) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 255 ||
      value.includes("\0")
    ) {
      throw new Error(ENCRYPTION_ERROR);
    }
  }
  return Buffer.from(
    [ASSOCIATED_DATA_PREFIX, context.workspaceId, context.connectionId].join(
      "\0",
    ),
    "utf8",
  );
}

function decodeBase64(value: string | undefined, length?: number): Buffer {
  const decoded = Buffer.from(value ?? "", "base64");
  if (
    !value ||
    decoded.toString("base64") !== value ||
    (length !== undefined && decoded.length !== length)
  ) {
    throw new Error(DECRYPTION_ERROR);
  }
  return decoded;
}

/** Cifra o App Secret: "v1.<iv>.<tag>.<ciphertext>" (base64). */
export function encryptMetaCloudAppSecret(
  secret: string,
  context: { workspaceId: string; connectionId: string },
  env: RuntimeEnv,
): string {
  try {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, encryptionKey(env), iv);
    cipher.setAAD(associatedData(context));
    const ciphertext = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]);
    return [
      FORMAT_VERSION,
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      ciphertext.toString("base64"),
    ].join(".");
  } catch {
    throw new Error(ENCRYPTION_ERROR);
  }
}

export function decryptMetaCloudAppSecret(
  value: string,
  context: { workspaceId: string; connectionId: string },
  env: RuntimeEnv,
): string {
  try {
    const [version, iv, tag, ciphertext, extra] = value.split(".");
    if (version !== FORMAT_VERSION || extra !== undefined) {
      throw new Error(DECRYPTION_ERROR);
    }
    const decipher = createDecipheriv(
      ALGORITHM,
      encryptionKey(env),
      decodeBase64(iv, IV_LENGTH_BYTES),
    );
    decipher.setAAD(associatedData(context));
    decipher.setAuthTag(decodeBase64(tag, AUTH_TAG_LENGTH_BYTES));
    const secret = Buffer.concat([
      decipher.update(decodeBase64(ciphertext)),
      decipher.final(),
    ]).toString("utf8");
    if (!secret.trim()) throw new Error(DECRYPTION_ERROR);
    return secret;
  } catch {
    throw new Error(DECRYPTION_ERROR);
  }
}

function hasConnectionSecret(
  connection: Pick<MetaCloudAppSecretConnection, "metaAppSecretEncrypted"> | null,
): boolean {
  return Boolean(connection?.metaAppSecretEncrypted?.trim());
}

function environmentSecret(env: RuntimeEnv): string | null {
  const value = env.META_APP_SECRET?.trim();
  return value ? value : null;
}

/**
 * De onde vem o segredo desta conexão, sem decifrar nada. É o que os
 * portões (nascer em produção, ativar, intake, replay) e a tela consultam.
 */
export function metaCloudAppSecretSource(
  connection: Pick<MetaCloudAppSecretConnection, "metaAppSecretEncrypted"> | null,
  env: RuntimeEnv,
): MetaCloudAppSecretSource {
  if (hasConnectionSecret(connection)) return "connection";
  return environmentSecret(env) ? "environment" : "none";
}

export type ResolvedMetaCloudAppSecret = {
  source: MetaCloudAppSecretSource;
  /**
   * null quando não há segredo, ou quando o da conexão não decifra (chave
   * trocada): nesse caso a fonte continua "connection" e a assinatura falha
   * fechada, sem cair para o segredo do ambiente (que é de outro app).
   */
  secret: string | null;
  /** App ID que acompanha o segredo (o da conexão ou META_APP_ID). */
  appId: string | null;
};

/**
 * Resolvedor central: segredo da conexão > META_APP_SECRET do ambiente >
 * nenhum. Use em toda conferência de assinatura e em toda chamada que
 * precise do app token.
 */
export function resolveMetaCloudAppSecret(
  connection: MetaCloudAppSecretConnection | null,
  env: RuntimeEnv,
): ResolvedMetaCloudAppSecret {
  if (connection && hasConnectionSecret(connection)) {
    let secret: string | null = null;
    try {
      secret = decryptMetaCloudAppSecret(
        connection.metaAppSecretEncrypted as string,
        { workspaceId: connection.workspaceId, connectionId: connection.id },
        env,
      );
    } catch {
      secret = null;
    }
    return {
      source: "connection",
      secret,
      appId: connection.metaAppId?.trim() || null,
    };
  }

  const secret = environmentSecret(env);
  return secret
    ? { source: "environment", secret, appId: env.META_APP_ID?.trim() || null }
    : { source: "none", secret: null, appId: null };
}
