import { normalizeCurrencyCode } from "@wpptrack/shared";
import { boundedString } from "../inbound-webhook-delivery-identity";
import {
  capAtReceived,
  normalizeProductCode,
  paytPhoneCandidates,
  type ParsedPaytAutomationV1,
  type PaytParseOptions,
  type PaytSaleAutomation,
  type PaytSaleEventName,
  type PaytSaleProduct,
} from "../payt/payt-automation-v1.parser";
import { saoPauloTimestamp } from "../sao-paulo-timestamp";

/**
 * Braip postback -> evento padrao (URL unica da Braip, mesma base da Payt).
 *
 * Nomes de campo CONFIRMADOS pelo exemplo oficial de postback da area de
 * membros da Braip (2026-10-23, dados de exemplo; fixtures sanitizados
 * `official-*.sanitized.json`): type "STATUS_ALTERADO", trans_key,
 * trans_status, trans_status_code, trans_value / trans_total_value (inteiros
 * em centavos, como string), currency, product_key, plan_key, trans_items
 * (item `main`), client_cel, trans_createdate / trans_updatedate /
 * trans_payment_date ("YYYY-MM-DD HH:mm:ss"). O que ainda depende de uma
 * compra REAL esta marcado PENDENTE em docs/setup/braip.md (porte do design
 * do SaaS). Por isso cada campo aceita varios nomes candidatos (parser
 * tolerante).
 *
 * Fase 6.5 (nod, producao direta): o release `braip/automation-v1` entra
 * CERTIFICADO por migration (validado no SaaS com o postback oficial, #168);
 * o aluno nao libera nem certifica nada.
 * Nenhum campo e inventado silenciosamente: sem o dado, o postback e
 * `invalid` (recibo guardado), nunca um envio adivinhado.
 */

export const BRAIP_AUTOMATION_V1_PARSER_VERSION = "automation-v1";

export type ParsedBraipAutomationV1 = Omit<ParsedPaytAutomationV1, "provider"> & {
  provider: "braip";
};

export type BraipSaleEventV1ParseResult =
  | { ok: true; value: ParsedBraipAutomationV1 }
  | {
      ok: false;
      errorCode:
        | "braip_sale_v1_status_not_supported"
        | "braip_automation_v1_invalid_payload"
        | "braip_purchase_identity_missing";
      providerStatus?: string | null;
    };

export type BraipAutomationV1ParseResult =
  | { ok: true; value: ParsedBraipAutomationV1 }
  | {
      ok: false;
      errorCode:
        | "braip_automation_v1_not_purchase"
        | "braip_automation_v1_invalid_payload"
        | "braip_purchase_identity_missing";
    };

const automationByEvent: Record<PaytSaleEventName, PaytSaleAutomation> = {
  Purchase: "purchase_paid",
  InitiateCheckout: "checkout_waiting_payment",
  CartAbandoned: "cart_abandoned",
};

/**
 * Account of the identity. Braip transaction keys are unique on the Braip
 * side and the identity is already scoped by workspace and provider, so a
 * constant keeps resends with/without producer fields on the same key.
 */
const BRAIP_ACCOUNT_REF = "braip";

// Candidate field names (first present wins). See the design doc table.
const STATUS_TEXT_FIELDS = ["trans_status", "transaction_status", "status"];
const STATUS_CODE_FIELDS = ["trans_status_code", "status_code"];
const TYPE_FIELDS = ["type", "event", "event_type"];
const TRANSACTION_FIELDS = [
  "trans_key",
  "transaction_key",
  "trans_code",
  "transaction_id",
  "trans_id",
];
/** PENDENTE: abandoned checkouts may have no trans_key. */
const CART_FIELDS = ["cart_key", "checkout_key", "abandonment_key", "abandoned_key"];
/**
 * Sale value: `trans_value` (the order's sale value, order bump included;
 * one Purchase per trans_key). The official sample sends `trans_value`,
 * `trans_total_value`, `trans_discount_value` and `trans_freight` as separate
 * integer-cent strings; `trans_total_value` is the total charged (presumably
 * with installment interest and/or freight), so it is only a fallback.
 * `trans_freight` is NOT subtracted from `trans_value`: the sample's example
 * numbers are not consistent with each other, so it is not provable whether
 * `trans_value` already excludes freight (subtracting could undercount).
 * PENDENTE: confirm with a real installment (parcelado) sale and a real sale
 * with freight.
 */
const VALUE_FIELDS = [
  "trans_value",
  "trans_total_value",
  "transaction_value",
  "total_value",
  "value",
  // NOT plan_amount: on Braip it may be a quantity (PENDENTE), never a price.
];
const CURRENCY_FIELDS = ["trans_currency", "currency"];
const PHONE_FIELDS = [
  "client_cel",
  "client_cellphone",
  "client_phone",
  "client_tel",
  "customer_phone",
  "phone",
];
const PRODUCT_CODE_FIELDS = ["product_key", "product_code", "product_id"];
const PRODUCT_NAME_FIELDS = ["product_name"];
const PLAN_CODE_FIELDS = ["plan_key", "plan_code", "plan_id", "offer_key"];
const PLAN_NAME_FIELDS = ["plan_name", "offer_name"];
const PAID_DATE_FIELDS = [
  "trans_payment_date",
  "trans_paid_date",
  "trans_updatedate",
  "trans_update_date",
  "updated_at",
  "trans_createdate",
  "trans_create_date",
  "created_at",
];
const CREATED_DATE_FIELDS = [
  "trans_createdate",
  "trans_create_date",
  "created_at",
  "trans_updatedate",
  "trans_update_date",
  "updated_at",
];
const TEST_FIELDS = ["test", "trans_test", "is_test"];

/**
 * Status text -> event (accents/case/spaces ignored). Names from the Braip
 * postback event list ("Pagamento Aprovado", "Aguardando Pagamento", ...).
 */
const purchaseStatuses = new Set([
  "pagamento aprovado",
  "aprovado",
  "aprovada",
  "approved",
  "paid",
  "pago",
]);
const checkoutStatuses = new Set([
  "aguardando pagamento",
  "waiting payment",
  "waiting_payment",
  "boleto gerado",
  "pix gerado",
]);
/**
 * PENDENTE: numeric codes are NOT confirmed by any public source. Used only
 * when the status text is absent; the text always wins.
 */
const purchaseCodes = new Set(["2"]);
const checkoutCodes = new Set(["1"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Root object, also from an n8n test/export envelope or a `data` wrapper. */
function unwrap(payload: unknown): Record<string, unknown> | null {
  let record = asRecord(payload);
  if (!record && Array.isArray(payload) && payload.length === 1) {
    record = asRecord(asRecord(payload[0])?.body);
  }
  if (!record) return null;
  const data = asRecord(record.data);
  const hasOwnFields = [...STATUS_TEXT_FIELDS, ...TRANSACTION_FIELDS].some(
    (field) => field in record!,
  );
  return !hasOwnFields && data ? data : record;
}

function scalar(value: unknown, max: number): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return boundedString(value, max);
}

function pick(
  record: Record<string, unknown>,
  fields: readonly string[],
  max = 255,
): string | null {
  for (const field of fields) {
    const value = scalar(record[field], max);
    if (value) return value;
  }
  return null;
}

function normalizeText(value: string | null): string | null {
  if (!value) return null;
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}

function isAbandoned(text: string | null): boolean {
  return Boolean(text && /abandon/u.test(text));
}

function saleEventName(record: Record<string, unknown>): PaytSaleEventName | null {
  const statusText = normalizeText(pick(record, STATUS_TEXT_FIELDS, 120));
  const statusCode = pick(record, STATUS_CODE_FIELDS, 20);
  const type = normalizeText(pick(record, TYPE_FIELDS, 120));

  // Paid always wins, whatever the type says (an abandoned checkout later
  // paid is a Purchase).
  if (statusText) {
    if (purchaseStatuses.has(statusText)) return "Purchase";
    if (isAbandoned(statusText)) return "CartAbandoned";
    if (checkoutStatuses.has(statusText)) {
      return isAbandoned(type) ? "CartAbandoned" : "InitiateCheckout";
    }
    // Any other text (Cancelada, Chargeback, Devolvida, Em Analise, ...)
    // is not mapped, even if a numeric code is also sent.
    return null;
  }
  if (statusCode && purchaseCodes.has(statusCode)) return "Purchase";
  if (isAbandoned(type)) return "CartAbandoned";
  if (statusCode && checkoutCodes.has(statusCode)) return "InitiateCheckout";
  return null;
}

/**
 * Braip money. PENDENTE: cents vs reais is not confirmed. An integer (or a
 * digits-only string) is read as cents; a decimal ("197.00", "197,00",
 * "1.297,90") as reais.
 */
export function braipValueCents(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Number.isInteger(value)
      ? Number.isSafeInteger(value)
        ? value
        : null
      : Math.round(value * 100);
  }
  const text = boundedString(value, 40)?.replace(/^R\$\s*/u, "");
  if (!text) return null;
  if (/^\d+$/u.test(text)) {
    const cents = Number(text);
    return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
  }
  let normalized: string | null = null;
  if (/^\d{1,3}(?:\.\d{3})*,\d{1,2}$/u.test(text) || /^\d+,\d{1,2}$/u.test(text)) {
    normalized = text.replace(/\./gu, "").replace(",", ".");
  } else if (/^\d{1,3}(?:,\d{3})*\.\d{1,2}$/u.test(text) || /^\d+\.\d{1,2}$/u.test(text)) {
    normalized = text.replace(/,/gu, "");
  }
  if (!normalized) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/**
 * Braip dates. Format "YYYY-MM-DD HH:mm:ss" (no offset) confirmed by the
 * official sample; read as America/Sao_Paulo wall-clock time by the shared
 * sale-time reader of fase 6.0 (sao-paulo-timestamp.ts, same as the Payt).
 * PENDENTE: confirm the timezone with a real sale. ISO with offset is kept;
 * "DD/MM/YYYY HH:mm:ss" and a date alone are also accepted.
 */
export function braipTimestamp(value: unknown): Date | null {
  const shared = saoPauloTimestamp(value);
  if (shared) return shared;
  const text = boundedString(value, 80);
  if (!text) return null;
  // Any other format keeps the SaaS parse (never seen in the official sample).
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

function truthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["true", "1", "sim", "yes"].includes(text);
}

/**
 * Main item of `trans_items` (order bump: the bump is `main: false`). Only the
 * main item routes the sale / matches a product filter; a bump product never
 * takes the sale for a rule filtered on the bump.
 */
function mainItemOf(record: Record<string, unknown>): Record<string, unknown> | null {
  const items = record.trans_items;
  const itemsRecord = asRecord(items);
  // Form body: trans_items[0][...] arrives as an object keyed by index.
  const list: unknown[] = Array.isArray(items)
    ? items
    : itemsRecord
      ? Object.values(itemsRecord)
      : [];
  for (const entry of list) {
    const item = asRecord(entry);
    if (item && truthy(item.main)) return item;
  }
  return null;
}

function productOf(
  record: Record<string, unknown>,
  codeFields: readonly string[],
  nameFields: readonly string[],
  nested: string,
  mainItem: Record<string, unknown> | null = null,
): PaytSaleProduct | null {
  const nestedRecord = asRecord(record[nested]);
  const code =
    normalizeProductCode(pick(record, codeFields, 80)) ??
    (nestedRecord
      ? normalizeProductCode(pick(nestedRecord, ["key", "code", "id"], 80))
      : null);
  if (!code) {
    // Top-level codes missing: fall back to the main item of trans_items.
    const itemCode = mainItem
      ? normalizeProductCode(pick(mainItem, codeFields, 80))
      : null;
    return itemCode && mainItem
      ? { code: itemCode, name: pick(mainItem, nameFields, 200) }
      : null;
  }
  const name =
    pick(record, nameFields, 200) ??
    (nestedRecord ? pick(nestedRecord, ["name", "title"], 200) : null);
  return { code, name };
}

/** Event of a Braip postback without judging identity/phone/value. */
export function braipSaleEventNameOf(payload: unknown): PaytSaleEventName | null {
  try {
    const record = unwrap(payload);
    return record ? saleEventName(record) : null;
  } catch {
    return null;
  }
}

/**
 * Approved payment -> Purchase; awaiting payment (boleto/pix generated) ->
 * InitiateCheckout; abandoned checkout -> CartAbandoned. Every other Braip
 * status (Cancelada, Chargeback, Devolvida, Estorno Pendente, Em Analise,
 * Em Processamento, Parcialmente Pago, Pagamento Atrasado, Alteracao de
 * Vencimento de Boleto, Codigo de rastreio adicionado) is ignored.
 */
export function parseBraipSaleEventV1(
  payload: unknown,
  options: PaytParseOptions = {},
): BraipSaleEventV1ParseResult {
  try {
    const record = unwrap(payload);
    if (!record) {
      return { ok: false, errorCode: "braip_automation_v1_invalid_payload" };
    }
    const providerStatus =
      normalizeText(pick(record, STATUS_TEXT_FIELDS, 120))?.slice(0, 40) ??
      pick(record, STATUS_CODE_FIELDS, 20) ??
      normalizeText(pick(record, TYPE_FIELDS, 120))?.slice(0, 80) ??
      null;
    const eventName = saleEventName(record);
    if (!eventName) {
      return {
        ok: false,
        errorCode: "braip_sale_v1_status_not_supported",
        providerStatus,
      };
    }

    const transactionRef = pick(record, TRANSACTION_FIELDS);
    const cartRef = pick(record, CART_FIELDS);
    const orderRef =
      eventName === "Purchase" ? transactionRef : (transactionRef ?? cartRef);
    if (!orderRef || orderRef.includes("\0")) {
      return { ok: false, errorCode: "braip_purchase_identity_missing" };
    }

    // A declared currency must be one we support (BRL/USD/EUR); none means
    // the rule / workspace currency decides downstream.
    const declaredCurrency = pick(record, CURRENCY_FIELDS, 10);
    const currency = normalizeCurrencyCode(declaredCurrency);
    const valueCents = (() => {
      for (const field of VALUE_FIELDS) {
        const cents = braipValueCents(record[field]);
        if (cents !== null) return cents;
      }
      return null;
    })();
    const parsedOccurredAt = (() => {
      for (const field of eventName === "Purchase"
        ? PAID_DATE_FIELDS
        : CREATED_DATE_FIELDS) {
        const date = braipTimestamp(record[field]);
        if (date) return date;
      }
      return null;
    })();
    // Fase 6.0 (#173): an event never happens after it arrived; Meta never
    // gets a future event_time.
    const occurredAt = parsedOccurredAt
      ? capAtReceived(parsedOccurredAt, options.receivedAt)
      : null;
    const phoneCandidates = paytPhoneCandidates(pick(record, PHONE_FIELDS, 40));
    if (
      (declaredCurrency && !currency) ||
      phoneCandidates.length === 0 ||
      !occurredAt ||
      (eventName !== "CartAbandoned" && valueCents === null)
    ) {
      return { ok: false, errorCode: "braip_automation_v1_invalid_payload" };
    }

    // Order bump: only the main item routes (top-level product_key/plan_key
    // are the main item in the official sample; trans_items main is the
    // fallback). Bump items (main: false) never enter productCodes.
    const mainItem = mainItemOf(record);
    const product = productOf(
      record,
      PRODUCT_CODE_FIELDS,
      PRODUCT_NAME_FIELDS,
      "product",
      mainItem,
    );
    const offer = productOf(
      record,
      PLAN_CODE_FIELDS,
      PLAN_NAME_FIELDS,
      "plan",
      mainItem,
    );
    const productCodes = [
      ...new Set(
        [product?.code, offer?.code].filter((code): code is string =>
          Boolean(code),
        ),
      ),
    ];

    return {
      ok: true,
      value: {
        provider: "braip",
        automation: automationByEvent[eventName],
        eventName,
        providerStatus,
        phone: phoneCandidates[0]!,
        phoneCandidates,
        occurredAt,
        externalExecutionKey: orderRef,
        orderRef,
        accountRef: BRAIP_ACCOUNT_REF,
        valueCents,
        currency,
        test: TEST_FIELDS.some((field) => truthy(record[field])),
        product,
        offer,
        productCodes,
      },
    };
  } catch {
    return { ok: false, errorCode: "braip_automation_v1_invalid_payload" };
  }
}

/** Purchase-only view (rules whose event is Purchase), like the Payt contract. */
export function parseBraipAutomationV1(
  payload: unknown,
  options: PaytParseOptions = {},
): BraipAutomationV1ParseResult {
  if (braipSaleEventNameOf(payload) !== "Purchase") {
    return unwrap(payload)
      ? { ok: false, errorCode: "braip_automation_v1_not_purchase" }
      : { ok: false, errorCode: "braip_automation_v1_invalid_payload" };
  }
  const parsed = parseBraipSaleEventV1(payload, options);
  if (!parsed.ok) {
    return parsed.errorCode === "braip_sale_v1_status_not_supported"
      ? { ok: false, errorCode: "braip_automation_v1_not_purchase" }
      : { ok: false, errorCode: parsed.errorCode };
  }
  return parsed;
}
