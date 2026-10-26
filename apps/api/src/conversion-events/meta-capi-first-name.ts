import { createHash } from "node:crypto";

/**
 * Primeiro nome do lead (`fn`) no `user_data` da Conversions API para
 * Business Messaging.
 *
 * Regra da Meta (Customer Information Parameters, linha "fn"): hash SHA-256
 * obrigatório; somente minúsculas, sem pontuação; caracteres especiais em
 * UTF-8 (o exemplo "Valéry" -> "valéry" mantém o acento). Por isso os acentos
 * são preservados (em NFC) e não removidos.
 *
 * Só o primeiro nome é enviado. Nomes vazios, só emoji/símbolos, que parecem
 * telefone ou genéricos ("cliente", "lead") não são enviados.
 */

const META_CAPI_SEND_FIRST_NAME = "META_CAPI_SEND_FIRST_NAME";

/** Pronomes de tratamento ignorados antes do primeiro nome ("Dr. João"). */
const honorifics = new Set([
  "sr",
  "sra",
  "srta",
  "dr",
  "dra",
  "prof",
  "profa",
  "mr",
  "mrs",
  "ms",
]);

/** Nomes que não identificam uma pessoa e nunca são enviados. */
const genericNames = new Set([
  "cliente",
  "clientes",
  "lead",
  "leads",
  "contato",
  "contact",
  "customer",
  "usuario",
  "usuário",
  "user",
  "teste",
  "test",
  "nome",
  "name",
  "desconhecido",
  "unknown",
  "anonimo",
  "anônimo",
  "anonymous",
  "whatsapp",
  "null",
  "undefined",
  "sem",
  "na",
]);

/** A partir de 6 dígitos o texto é tratado como telefone/documento. */
const PHONE_LIKE_MIN_DIGITS = 6;

export function normalizeMetaFirstName(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.normalize("NFC").trim();
  if (!text) return null;

  const digits = text.replace(/\D/gu, "").length;
  if (digits >= PHONE_LIKE_MIN_DIGITS) return null;

  for (const piece of text.split(/\s+/u)) {
    // Sem pontuação, dígitos, símbolos/emoji, seletores de variação e
    // caracteres de controle; letras (com acento) e marcas combinantes ficam.
    const token = piece
      .replace(/[︀-️]/gu, "")
      .replace(/[^\p{L}\p{M}]/gu, "")
      .toLocaleLowerCase("pt-BR");
    if (!/\p{L}/u.test(token)) continue;
    if (honorifics.has(token)) continue;
    if (genericNames.has(token)) return null;
    // Uma única letra é inicial, não primeiro nome.
    if ([...token].length < 2) return null;
    return token;
  }

  return null;
}

/** SHA-256 em hexadecimal (minúsculas) do primeiro nome já normalizado. */
export function hashMetaFirstName(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Interruptor: desligado por padrão, porque o nome do perfil do WhatsApp não é
 * confiável (apelidos, frases). "true", "1", "on" ou "yes" ligam.
 */
export function metaCapiFirstNameEnabled(
  env: Record<string, string | undefined>,
): boolean {
  const value = env[META_CAPI_SEND_FIRST_NAME]?.trim().toLowerCase();
  if (!value) return false;
  return ["true", "1", "on", "yes"].includes(value);
}

/** Hash do `fn` a enviar, ou null quando desligado ou o nome não serve. */
export function metaCapiFirstNameHash(
  raw: string | null | undefined,
  env: Record<string, string | undefined>,
): string | null {
  if (!metaCapiFirstNameEnabled(env)) return null;
  const normalized = normalizeMetaFirstName(raw);
  return normalized ? hashMetaFirstName(normalized) : null;
}
