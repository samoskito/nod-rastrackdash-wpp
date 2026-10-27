import { normalizePhoneIdentity } from "../../../common/phone/phone-identity";
import { boundedString } from "../inbound-webhook-delivery-identity";
import {
  normalizeProductCode,
  PAYT_FUTURE_SKEW_MS,
  type ParsedPaytAutomationV1,
  type PaytParseOptions,
  type PaytSaleAutomation,
  type PaytSaleEventName,
  type PaytSaleProduct,
} from "../payt/payt-automation-v1.parser";
import { saoPauloTimestamp } from "../sao-paulo-timestamp";

/**
 * Yampi webhook -> evento padrao (URL unica da Yampi, mesma base da Payt, da
 * Braip). Fase 6.7 do nod (porte do SaaS #186, #187 e #188): no nod a Yampi e
 * LIBERADA para todos os workspaces (sem gate de integracao privada).
 *
 * Envelope (docs.yampi.com.br, introduction-webhook):
 *   { event, time ("2026-10-22 09:30:12", sem fuso = Brasilia),
 *     merchant{id, alias}, resource }
 *
 * Pedido (order.*): resource{ id, number, status_id, status{data{alias}},
 *   value_products, value_total, value_shipment, value_tax, value_discount,
 *   created_at/updated_at {date, timezone_type, timezone},
 *   customer{data{name, email, cpf, phone{full_number, area_code, number}}},
 *   items{data[{product_id, sku_id, item_sku, quantity, price,
 *               sku{data{title}}}]},
 *   transactions{data[...]}, utm_*, cart_token, metadata{data[]} }
 * Carrinho (cart.reminder): resource{ id, token, totalizers{subtotal, discount,
 *   shipment, total}, customer{data{phone}}, created_at/updated_at, utm_*,
 *   tracking_data }
 *
 * Producao direta (nod): o release `yampi/automation-v1` entra CERTIFICADO
 * pela migration 20261027160100_yampi_parser_release (validado no SaaS com
 * payloads reais recebidos e lidos corretamente; o #187 e o #188 foram
 * feitos sobre o formato real). Nada e adivinhado: sem pedido, telefone,
 * valor ou data o recibo fica `invalid`, nunca um envio. Detalhes e
 * PENDENTES em docs/setup/yampi.md.
 */

export const YAMPI_AUTOMATION_V1_PARSER_VERSION = "automation-v1";

export type ParsedYampiAutomationV1 = Omit<
  ParsedPaytAutomationV1,
  "provider"
> & {
  provider: "yampi";
};

export type YampiSaleEventV1ParseResult =
  | { ok: true; value: ParsedYampiAutomationV1 }
  | {
      ok: false;
      errorCode:
        | "yampi_sale_v1_status_not_supported"
        | "yampi_automation_v1_invalid_payload"
        | "yampi_purchase_identity_missing";
      providerStatus?: string | null;
    };

export type YampiAutomationV1ParseResult =
  | { ok: true; value: ParsedYampiAutomationV1 }
  | {
      ok: false;
      errorCode:
        | "yampi_automation_v1_not_purchase"
        | "yampi_automation_v1_invalid_payload"
        | "yampi_purchase_identity_missing";
    };

const automationByEvent: Record<PaytSaleEventName, PaytSaleAutomation> = {
  Purchase: "purchase_paid",
  InitiateCheckout: "checkout_waiting_payment",
  CartAbandoned: "cart_abandoned",
};

/**
 * Account of the identity. The Yampi order id is the id of the order in the
 * Yampi API (unique there) and the identity is already scoped by workspace
 * and provider. A constant keeps `order.paid` and a later
 * `order.status.updated` (alias paid) on the SAME identity even when one of
 * them omits `merchant`.
 */
const YAMPI_ACCOUNT_REF = "yampi";

/** Yampi sells in reais: the webhook has no currency field. */
const YAMPI_CURRENCY = "BRL" as const;

/** Status alias of a paid order (`status_id` 4 in the real payload). */
const PAID_ALIASES = new Set(["paid"]);
const PAID_STATUS_IDS = new Set(["4"]);

/**
 * Status aliases of an order created and still waiting for payment (boleto
 * or Pix generated). PENDENTE: the Yampi docs publish no status list; confirm
 * the alias of a real `order.created` with boleto/Pix.
 */
const WAITING_PAYMENT_ALIASES = new Set([
  "waiting_payment",
  "pending",
  "pending_payment",
  "awaiting_payment",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Root object, also from an n8n test/export envelope (`[{ body }]`). */
function unwrap(payload: unknown): Record<string, unknown> | null {
  const direct = asRecord(payload);
  if (direct) return direct;
  if (!Array.isArray(payload) || payload.length !== 1) return null;
  return asRecord(asRecord(payload[0])?.body);
}

function scalar(value: unknown, max: number): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return boundedString(value, max);
}

function lower(value: unknown, max: number): string | null {
  return scalar(value, max)?.trim().toLowerCase() || null;
}

/** Yampi wraps relations in `{ data: ... }` (Fractal transformer). */
function dataOf(value: unknown): unknown {
  const record = asRecord(value);
  return record && "data" in record ? record.data : value;
}

function listOf(value: unknown): Record<string, unknown>[] {
  const data = dataOf(value);
  return Array.isArray(data)
    ? data.map(asRecord).filter((entry): entry is Record<string, unknown> =>
        Boolean(entry),
      )
    : [];
}

function statusAlias(resource: Record<string, unknown> | null): string | null {
  if (!resource) return null;
  const status = asRecord(dataOf(resource.status));
  return lower(status?.alias, 60) ?? lower(resource.status_alias, 60);
}

function orderIsPaid(resource: Record<string, unknown> | null): boolean {
  const alias = statusAlias(resource);
  if (alias) return PAID_ALIASES.has(alias);
  const statusId = scalar(resource?.status_id, 10);
  return statusId !== null && PAID_STATUS_IDS.has(statusId);
}

function orderIsWaitingPayment(
  resource: Record<string, unknown> | null,
): boolean {
  const alias = statusAlias(resource);
  return alias !== null && WAITING_PAYMENT_ALIASES.has(alias);
}

/**
 * Webhook event -> standard event.
 * - `order.paid` -> Purchase.
 * - `order.status.updated` with alias `paid` -> Purchase with the SAME
 *   identity as `order.paid` (order id + Purchase): whichever arrives first is
 *   the one Purchase, the other is a duplicate receipt. Every other status
 *   (cancelado, reembolsado, enviado, entregue...) is received and ignored.
 * - `order.created` waiting for payment (boleto/Pix gerado) ->
 *   InitiateCheckout; created already paid (or any other status) is ignored
 *   (the `order.paid` of the same order is the Purchase).
 * - `cart.reminder` -> CartAbandoned (like Payt/Braip/Hotmart).
 * - `transaction.payment.refused` and anything else -> ignored, like Braip:
 *   there is no standard event to undo a conversion already sent.
 */
function eventNameOf(
  record: Record<string, unknown>,
): PaytSaleEventName | null {
  const event = lower(record.event, 80);
  const resource = asRecord(record.resource);
  switch (event) {
    case "order.paid":
      return "Purchase";
    case "order.status.updated":
      return orderIsPaid(resource) ? "Purchase" : null;
    case "order.created":
      return orderIsWaitingPayment(resource) ? "InitiateCheckout" : null;
    case "cart.reminder":
      return "CartAbandoned";
    default:
      return null;
  }
}

/** Event of a Yampi webhook without judging identity/phone/value. */
export function yampiSaleEventNameOf(
  payload: unknown,
): PaytSaleEventName | null {
  try {
    const record = unwrap(payload);
    return record ? eventNameOf(record) : null;
  } catch {
    return null;
  }
}

/**
 * Yampi money: decimal amount in reais (`594` = R$ 594,00; `197.9` =
 * R$ 197,90), as in the real payloads. A numeric string ("197.90", "197,90")
 * is accepted too. Returns cents.
 */
export function yampiValueCents(value: unknown): number | null {
  let amount: number | null = null;
  if (typeof value === "number") amount = value;
  else {
    const text = boundedString(value, 40)?.trim();
    if (text && /^\d+(?:[.,]\d{1,6})?$/u.test(text)) {
      amount = Number(text.replace(",", "."));
    }
  }
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

const utcZones = new Set(["utc", "z", "gmt", "etc/utc", "+00:00", "+0000"]);

/**
 * Yampi dates.
 * - Resource dates: `{ date: "2026-10-22 09:29:52.000000", timezone_type: 3,
 *   timezone: "America/Sao_Paulo" }` (PHP DateTime). America/Sao_Paulo (or no
 *   zone) is Brasilia wall-clock time; UTC and a numeric offset are honoured;
 *   any other zone is not guessed (null).
 * - Envelope `time`: "2026-10-22 09:30:12", no zone, Brasilia time in
 *   practice (same rule as Payt, PR #173).
 */
export function yampiTimestamp(value: unknown): Date | null {
  const object = asRecord(value);
  if (!object) return saoPauloTimestamp(value);
  const text = boundedString(object.date, 80);
  if (!text) return null;
  const zone = boundedString(object.timezone, 64)?.toLowerCase() ?? null;
  if (!zone || zone === "america/sao_paulo" || zone === "-03:00") {
    return saoPauloTimestamp(text);
  }
  const naive =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,6}))?$/u.exec(
      text,
    );
  if (!naive) return null;
  const fraction = (naive[3] ?? "0").slice(0, 3).padEnd(3, "0");
  const base = `${naive[1]}T${naive[2]}.${fraction}`;
  if (utcZones.has(zone)) return isoDate(`${base}Z`);
  if (/^[+-]\d{2}:\d{2}$/u.test(zone)) return isoDate(`${base}${zone}`);
  return null;
}

function isoDate(text: string): Date | null {
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

/** Same rule as Payt (PR #173): never an event time after the arrival. */
function capAtReceived(occurredAt: Date, receivedAt: Date | undefined): Date {
  const reference = receivedAt?.getTime() ?? Date.now();
  if (!Number.isFinite(reference)) return occurredAt;
  return occurredAt.getTime() > reference + PAYT_FUTURE_SKEW_MS
    ? new Date(reference)
    : occurredAt;
}

function digitsOf(value: unknown): string {
  return (scalar(value, 40) ?? "").replace(/\D/gu, "");
}

/** National BR number (DDD + 8/9 digits) -> [with 55, as received]. */
function brazilianCandidates(national: string): string[] {
  const e164 = normalizePhoneIdentity(`55${national}`);
  const received = normalizePhoneIdentity(national);
  return [...new Set([e164, received].filter((v): v is string => Boolean(v)))];
}

/**
 * Buyer phone candidates (`customer.data.phone`).
 * - `area_code` + `number` (DDD apart) -> the national number, then 55 is
 *   added (no ambiguity with DDD 55, Rio Grande do Sul).
 * - `full_number`: the real payload came WITHOUT 55 ("11900000000", 11
 *   digits); the docs show it WITH 55 ("5511900000000"). Both are accepted:
 *   10/11 digits are national (55 added), 12/13 digits starting with 55
 *   already carry the DDI.
 * - `whatsapp_link` is never the primary source.
 * The first candidate always carries the 55 (E.164); the national form stays
 * as a second candidate. The lead resolver also matches with/without the
 * 9th digit (same equivalence as Payt/Braip).
 */
export function yampiPhoneCandidates(
  resource: Record<string, unknown>,
): string[] {
  const customer = asRecord(dataOf(resource.customer));
  const phoneValue = customer?.phone ?? resource.phone;
  const phone = asRecord(dataOf(phoneValue));
  const area = phone ? digitsOf(phone.area_code) : "";
  const number = phone ? digitsOf(phone.number) : "";
  if (area.length === 2 && number.length >= 8 && number.length <= 9) {
    return brazilianCandidates(`${area}${number}`);
  }
  const full = phone
    ? digitsOf(phone.full_number) || digitsOf(phone.formated_number)
    : digitsOf(phoneValue);
  if (!full) return [];
  if (full.length === 10 || full.length === 11) {
    return brazilianCandidates(full);
  }
  if ((full.length === 12 || full.length === 13) && full.startsWith("55")) {
    return brazilianCandidates(full.slice(2));
  }
  // Anything else (foreign number): used as received, never a guessed 55.
  const received = normalizePhoneIdentity(full);
  return received ? [received] : [];
}

/** Items of an order/cart: `items.data[]`. */
function itemsOf(resource: Record<string, unknown>): Record<string, unknown>[] {
  return listOf(resource.items);
}

function itemTitle(item: Record<string, unknown>): string | null {
  const sku = asRecord(dataOf(item.sku));
  const product = asRecord(dataOf(item.product));
  return (
    boundedString(sku?.title, 200) ??
    boundedString(item.name, 200) ??
    boundedString(item.bundle_name, 200) ??
    boundedString(product?.name, 200)
  );
}

/** price x quantity of an item (0 when unreadable). */
function itemTotal(item: Record<string, unknown>): number {
  const price = Number(item.price);
  const quantity = Number(item.quantity ?? 1);
  return Number.isFinite(price) && Number.isFinite(quantity) && price > 0
    ? price * Math.max(quantity, 1)
    : 0;
}

/**
 * Product = Yampi product id; offer = the SKU sold (SKU code, else SKU id).
 * The shown product/offer is the item with the highest total in the order
 * (an order bump such as "Frete Expresso" may come first); ties keep the
 * first. Every item enters the product filter (product id, SKU id and SKU
 * code), so a rule filtered by any of them catches the order.
 */
function productsOf(resource: Record<string, unknown>): {
  product: PaytSaleProduct | null;
  offer: PaytSaleProduct | null;
  productCodes: string[];
} {
  const items = itemsOf(resource);
  const codes: string[] = [];
  let product: PaytSaleProduct | null = null;
  let offer: PaytSaleProduct | null = null;
  let bestTotal = -1;
  for (const item of items) {
    const sku = asRecord(dataOf(item.sku));
    const title = itemTitle(item);
    const productCode = normalizeProductCode(scalar(item.product_id, 80));
    const skuCode = normalizeProductCode(
      scalar(item.item_sku, 80) ?? scalar(sku?.sku, 80),
    );
    const skuId = normalizeProductCode(
      scalar(item.sku_id, 80) ?? scalar(sku?.id, 80),
    );
    const offerCode = skuCode ?? skuId;
    const total = itemTotal(item);
    if ((productCode || offerCode) && total > bestTotal) {
      bestTotal = total;
      product = productCode ? { code: productCode, name: title } : null;
      offer = offerCode ? { code: offerCode, name: title } : null;
    }
    for (const code of [productCode, skuId, skuCode]) {
      if (code) codes.push(code);
    }
  }
  return { product, offer, productCodes: [...new Set(codes)] };
}

/**
 * Sale value (owner decision, lesson of Payt tarefa 18): ONLY the products.
 * - Order: `value_products` (no shipping `value_shipment`, no installment
 *   interest `value_tax`/`buyer_value_tax`). `value_total` and
 *   `buyer_value_total` are NEVER used.
 * - Cart (cart.reminder): `totalizers.subtotal`, same criterion
 *   (`totalizers.total` carries the shipping).
 */
function saleValueCents(
  eventName: PaytSaleEventName,
  resource: Record<string, unknown>,
): number | null {
  if (eventName === "CartAbandoned") {
    const totalizers = asRecord(dataOf(resource.totalizers));
    return yampiValueCents(totalizers?.subtotal);
  }
  return yampiValueCents(resource.value_products);
}

function orderRefOf(
  eventName: PaytSaleEventName,
  resource: Record<string, unknown>,
): string | null {
  if (eventName === "CartAbandoned") {
    // Every reminder of the same cart keeps its id: one CartAbandoned.
    const cartId = scalar(resource.id, 200);
    if (cartId) return `cart:${cartId}`;
    const token = scalar(resource.token, 200);
    return token ? `cart-token:${token}` : null;
  }
  return scalar(resource.id, 255);
}

function occurredAtOf(
  eventName: PaytSaleEventName,
  record: Record<string, unknown>,
  resource: Record<string, unknown>,
): Date | null {
  const candidates =
    eventName === "InitiateCheckout"
      ? [resource.created_at, record.time]
      : [resource.updated_at, record.time, resource.created_at];
  for (const candidate of candidates) {
    const date = yampiTimestamp(candidate);
    if (date) return date;
  }
  return null;
}

function providerStatusOf(record: Record<string, unknown>): string | null {
  const event = lower(record.event, 60);
  const alias = statusAlias(asRecord(record.resource));
  if (!event) return alias;
  return alias ? `${event}:${alias}` : event;
}

/**
 * order.paid / order.status.updated (paid) -> Purchase; order.created
 * waiting for payment -> InitiateCheckout; cart.reminder -> CartAbandoned.
 * Everything else is ignored.
 */
export function parseYampiSaleEventV1(
  payload: unknown,
  options: PaytParseOptions = {},
): YampiSaleEventV1ParseResult {
  try {
    const record = unwrap(payload);
    const resource = asRecord(record?.resource);
    if (!record || !resource) {
      return { ok: false, errorCode: "yampi_automation_v1_invalid_payload" };
    }
    const providerStatus = providerStatusOf(record);
    const eventName = eventNameOf(record);
    if (!eventName) {
      return {
        ok: false,
        errorCode: "yampi_sale_v1_status_not_supported",
        providerStatus,
      };
    }

    const orderRef = orderRefOf(eventName, resource);
    if (!orderRef || orderRef.includes("\0")) {
      return { ok: false, errorCode: "yampi_purchase_identity_missing" };
    }

    const valueCents = saleValueCents(eventName, resource);
    const parsedOccurredAt = occurredAtOf(eventName, record, resource);
    const occurredAt = parsedOccurredAt
      ? capAtReceived(parsedOccurredAt, options.receivedAt)
      : null;
    const phoneCandidates = yampiPhoneCandidates(resource);
    if (
      phoneCandidates.length === 0 ||
      !occurredAt ||
      (eventName !== "CartAbandoned" && valueCents === null)
    ) {
      return { ok: false, errorCode: "yampi_automation_v1_invalid_payload" };
    }

    const { product, offer, productCodes } = productsOf(resource);
    return {
      ok: true,
      value: {
        provider: "yampi",
        automation: automationByEvent[eventName],
        eventName,
        providerStatus,
        phone: phoneCandidates[0]!,
        phoneCandidates,
        occurredAt,
        externalExecutionKey: orderRef,
        orderRef,
        accountRef: YAMPI_ACCOUNT_REF,
        valueCents,
        currency: valueCents === null ? null : YAMPI_CURRENCY,
        // PENDENTE: the Yampi "testar webhook" has no documented marker.
        test: false,
        product,
        offer,
        productCodes,
      },
    };
  } catch {
    return { ok: false, errorCode: "yampi_automation_v1_invalid_payload" };
  }
}

/** At most this many order lines travel to Meta in `contents`. */
export const YAMPI_CAPI_MAX_ITEMS = 50;

/** Tolerance between sum(price x quantity) and the sent value. */
export const YAMPI_CAPI_VALUE_TOLERANCE_CENTS = 5;

/**
 * Real order lines of a Yampi order for the Meta `custom_data`
 * (only order events: Purchase and InitiateCheckout).
 * - `contents`: one entry per `items.data[]` line, order bump included,
 *   `{ id: item_sku | sku_id | product_id, quantity, item_price: price }`.
 *   Only code, quantity and price: never buyer data. At most
 *   YAMPI_CAPI_MAX_ITEMS lines (the first ones of the order).
 * - `num_items`: sum of the quantities of every valid line of the order.
 * - `content_type`: "product".
 * - `content_name`: title of the main product (highest price x quantity,
 *   same rule as the product shown in the panel). The rule's configured
 *   "nome do conteudo", when set, still wins in the payload builder.
 * - `order_id`: the Yampi order id (`resource.id`). The Meta `event_id` and
 *   the dedupe identity are NOT touched.
 *
 * The value is NOT here: it stays `value_products` (decision value). When the
 * items do not add up to it (e.g. a coupon discount), the value and the items
 * are both kept and `itemsTotalCents` lets the caller log the mismatch.
 * Returns null (generic default item) for CartAbandoned (PENDENTE: no real
 * `cart.reminder` with items seen yet), for an unreadable payload or for an
 * order without any readable line.
 */
export type YampiCapiCustomData = {
  customData: {
    contents: Array<{ id: string; quantity: number; item_price?: number }>;
    num_items: number;
    content_type: "product";
    content_name?: string;
    order_id?: string;
  };
  /** sum(price x quantity) of every valid line, in cents. */
  itemsTotalCents: number;
  /** Lines of the order (before the YAMPI_CAPI_MAX_ITEMS limit). */
  itemCount: number;
};

function itemQuantity(item: Record<string, unknown>): number {
  const quantity = Number(item.quantity ?? 1);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 1;
}

function itemPriceCents(item: Record<string, unknown>): number | null {
  return yampiValueCents(item.price);
}

function itemContentId(item: Record<string, unknown>): string | null {
  const sku = asRecord(dataOf(item.sku));
  for (const candidate of [
    item.item_sku,
    sku?.sku,
    item.sku_id,
    sku?.id,
    item.product_id,
  ]) {
    const id = scalar(candidate, 100)?.trim();
    if (id && !id.includes("\0")) return id;
  }
  return null;
}

export function yampiCapiCustomData(
  payload: unknown,
): YampiCapiCustomData | null {
  try {
    const record = unwrap(payload);
    const resource = asRecord(record?.resource);
    if (!record || !resource) return null;
    const eventName = eventNameOf(record);
    if (eventName !== "Purchase" && eventName !== "InitiateCheckout") {
      return null;
    }
    const lines = itemsOf(resource)
      .map((item) => {
        const id = itemContentId(item);
        if (!id) return null;
        const quantity = itemQuantity(item);
        const priceCents = itemPriceCents(item);
        return { item, id, quantity, priceCents };
      })
      .filter((line): line is NonNullable<typeof line> => line !== null);
    if (lines.length === 0) return null;

    let main: (typeof lines)[number] | null = null;
    let bestTotal = -1;
    for (const line of lines) {
      const total = (line.priceCents ?? 0) * line.quantity;
      if (total > bestTotal) {
        bestTotal = total;
        main = line;
      }
    }
    const contentName = main ? itemTitle(main.item)?.trim() : null;
    const orderId = scalar(resource.id, 255)?.trim();

    return {
      customData: {
        contents: lines.slice(0, YAMPI_CAPI_MAX_ITEMS).map((line) => ({
          id: line.id,
          quantity: line.quantity,
          ...(line.priceCents !== null
            ? { item_price: line.priceCents / 100 }
            : {}),
        })),
        num_items: lines.reduce((total, line) => total + line.quantity, 0),
        content_type: "product",
        ...(contentName ? { content_name: contentName } : {}),
        ...(orderId && !orderId.includes("\0") ? { order_id: orderId } : {}),
      },
      itemsTotalCents: lines.reduce(
        (total, line) => total + (line.priceCents ?? 0) * line.quantity,
        0,
      ),
      itemCount: lines.length,
    };
  } catch {
    return null;
  }
}

/** Purchase-only view (rules whose event is Purchase), like Payt/Braip. */
export function parseYampiAutomationV1(
  payload: unknown,
  options: PaytParseOptions = {},
): YampiAutomationV1ParseResult {
  if (yampiSaleEventNameOf(payload) !== "Purchase") {
    return unwrap(payload)
      ? { ok: false, errorCode: "yampi_automation_v1_not_purchase" }
      : { ok: false, errorCode: "yampi_automation_v1_invalid_payload" };
  }
  const parsed = parseYampiSaleEventV1(payload, options);
  if (!parsed.ok) {
    return parsed.errorCode === "yampi_sale_v1_status_not_supported"
      ? { ok: false, errorCode: "yampi_automation_v1_not_purchase" }
      : { ok: false, errorCode: parsed.errorCode };
  }
  return parsed;
}
