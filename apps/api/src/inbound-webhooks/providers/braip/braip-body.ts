/**
 * Braip postback body normalization (URL unica da Braip).
 *
 * Fontes publicas nao confirmam o formato do corpo (JSON ou
 * application/x-www-form-urlencoded). PENDENTE: confirmar com um postback
 * real. Por isso o endereco da Braip aceita os dois e converte tudo para um
 * JSON canonico ANTES de guardar/rotear: o resto do pipeline (entrega da
 * regra, decisao, producao, reprocessamento) so le JSON.
 *
 * A chave `basic_authentication` ("Chave unica" da Braip) e descartada: a
 * autenticacao do endereco e o token da URL, e a chave da conta Braip nunca
 * fica guardada (nem cifrada) junto do payload.
 */

const MAX_FORM_FIELDS = 500;
const MAX_FORM_DEPTH = 5;
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
const redactedKeys = new Set(["basic_authentication"]);

export type BraipBodyResult =
  | { ok: true; body: Buffer; format: "json" | "form" }
  | { ok: false; errorCode: "braip_body_invalid" | "braip_body_unsupported" };

type FormNode = { [key: string]: FormValue };
type FormValue = string | FormNode | FormValue[];

function mediaTypeOf(contentType: string | undefined): string | null {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() || null;
}

/** `a[b][c]` -> ["a", "b", "c"]; `a[]` -> ["a", ""]. Null when malformed. */
function keyPath(key: string): string[] | null {
  const match = /^([^[\]]+)((?:\[[^[\]]*\])*)$/u.exec(key);
  if (!match) return null;
  const path = [match[1]!];
  const rest = match[2] ?? "";
  for (const part of rest.matchAll(/\[([^[\]]*)\]/gu)) path.push(part[1]!);
  if (path.length > MAX_FORM_DEPTH) return null;
  return path.some((segment) => forbiddenKeys.has(segment)) ? null : path;
}

function assign(target: FormNode, path: string[], value: string): void {
  let node: FormNode | FormValue[] = target;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]!;
    const last = index === path.length - 1;
    if (Array.isArray(node)) {
      if (last) {
        node.push(value);
        return;
      }
      const child: FormNode = {};
      node.push(child);
      node = child;
      continue;
    }
    if (last) {
      node[segment] = value;
      return;
    }
    const nextIsArray = path[index + 1] === "";
    const existing: FormValue | undefined = node[segment];
    if (
      existing === undefined ||
      typeof existing === "string" ||
      Array.isArray(existing) !== nextIsArray
    ) {
      const created: FormNode | FormValue[] = nextIsArray ? [] : {};
      node[segment] = created;
      node = created;
    } else {
      node = existing;
    }
  }
}

export function parseFormBody(text: string): FormNode | null {
  const params = new URLSearchParams(text);
  const result: FormNode = {};
  let count = 0;
  for (const [key, value] of params) {
    count += 1;
    if (count > MAX_FORM_FIELDS) return null;
    const path = keyPath(key);
    if (!path) continue;
    assign(result, path, value);
  }
  return count > 0 ? result : null;
}

function looksLikeForm(text: string): boolean {
  return /^[A-Za-z0-9_[\]%.-]+=/u.test(text.trim());
}

/** Drops the account key at any depth (also inside a `data` wrapper). */
function redact(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !redactedKeys.has(key))
      .map(([key, entry]) => [key, redact(entry, depth + 1)]),
  );
}

/** Canonical JSON body of a Braip postback (JSON or form-urlencoded). */
export function normalizeBraipBody(
  contentType: string | undefined,
  rawBody: Buffer,
): BraipBodyResult {
  const text = rawBody.toString("utf8");
  const mediaType = mediaTypeOf(contentType);
  if (mediaType === "multipart/form-data") {
    return { ok: false, errorCode: "braip_body_unsupported" };
  }

  const tryJson = (): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  };

  let parsed: unknown;
  let format: "json" | "form";
  if (mediaType === "application/x-www-form-urlencoded") {
    parsed = parseFormBody(text);
    format = "form";
  } else if (mediaType === "application/json") {
    parsed = tryJson();
    format = "json";
  } else {
    // Missing/other content type: JSON first, then a form body.
    parsed = tryJson();
    format = "json";
    if (parsed === undefined && looksLikeForm(text)) {
      parsed = parseFormBody(text);
      format = "form";
    }
  }

  const isObject =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  const isEnvelope = Array.isArray(parsed) && parsed.length === 1;
  if (!isObject && !isEnvelope) {
    return { ok: false, errorCode: "braip_body_invalid" };
  }
  const canonical = isEnvelope
    ? (parsed as unknown[]).map((entry) => {
        const record =
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? (entry as Record<string, unknown>)
            : null;
        return record && "body" in record
          ? { ...record, body: redact(record.body) }
          : entry;
      })
    : redact(parsed);
  return {
    ok: true,
    body: Buffer.from(JSON.stringify(canonical), "utf8"),
    format,
  };
}
