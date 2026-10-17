import { z } from "zod";

// Ported from Dashboard Leads (lib/meta/webhook.ts, lib/routing.ts): Meta Page
// webhooks with field "leadgen" announce an instant-form submission; the lead
// itself is read afterwards from the Graph API.

// IDs arrive as strings, but sometimes as numbers in test payloads.
const id = z.union([z.string().min(1), z.number()]).transform(String);

const leadgenValue = z.object({
  leadgen_id: id,
  page_id: id,
  form_id: id.optional(),
  ad_id: id.optional(),
  adgroup_id: id.optional(),
  created_time: z.number().optional(),
});

export type LeadgenChange = z.infer<typeof leadgenValue>;

const pagePayload = z.object({
  object: z.literal("page"),
  entry: z.array(
    z.object({
      changes: z
        .array(z.object({ field: z.string(), value: z.unknown() }))
        .default([]),
    }),
  ),
});

/** Valid leadgen changes of a Page payload; null when it is not a Page payload. */
export function parseLeadgenPayload(
  body: unknown,
): { changes: LeadgenChange[]; invalid: number } | null {
  const parsed = pagePayload.safeParse(body);
  if (!parsed.success) return null;

  const changes: LeadgenChange[] = [];
  let invalid = 0;
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== "leadgen") continue;
      const value = leadgenValue.safeParse(change.value);
      if (value.success) changes.push(value.data);
      else invalid++;
    }
  }

  return { changes, invalid };
}

export type LeadFormRouteCandidate = {
  id: string;
  pageId: string;
  formIds: string[];
};

export type LeadFormRoute<T extends LeadFormRouteCandidate> =
  | { connection: T; reason: "page_match" | "form_match" | "page_default" }
  | { connection: null; reason: "no_page_match" | "ambiguous" };

/**
 * 1. Active connections of the page.
 * 2. Only one: that one.
 * 3. Several (shared Page): the one listing the form; when none lists it, the
 *    single connection without forms (the Page catch-all).
 * 4. Otherwise unrouted.
 */
export function routeLeadForm<T extends LeadFormRouteCandidate>(
  connections: T[],
  pageId: string,
  formId?: string | null,
): LeadFormRoute<T> {
  const byPage = connections.filter((item) => item.pageId === pageId);
  if (byPage.length === 0) return { connection: null, reason: "no_page_match" };
  if (byPage.length === 1)
    return { connection: byPage[0]!, reason: "page_match" };

  if (formId) {
    const byForm = byPage.filter((item) => item.formIds.includes(formId));
    if (byForm.length === 1)
      return { connection: byForm[0]!, reason: "form_match" };
    if (byForm.length > 1) return { connection: null, reason: "ambiguous" };
  }

  const catchAll = byPage.filter((item) => item.formIds.length === 0);
  if (catchAll.length === 1)
    return { connection: catchAll[0]!, reason: "page_default" };
  return { connection: null, reason: "ambiguous" };
}

export type GraphLeadField = { name: string; values: string[] };

export type GraphLead = {
  id: string;
  created_time?: string;
  field_data?: GraphLeadField[];
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  form_id?: string;
};

function fieldValue(
  fields: GraphLeadField[] | undefined,
  names: string[],
): string | null {
  for (const field of fields ?? []) {
    if (names.includes(field.name.toLowerCase())) {
      const value = field.values?.find((item) => item?.trim())?.trim();
      if (value) return value;
    }
  }
  return null;
}

/** Contact fields of the standard Meta form questions. */
export function leadContact(lead: GraphLead): {
  fullName: string | null;
  email: string | null;
  phone: string | null;
} {
  const fields = lead.field_data;
  const first = fieldValue(fields, ["first_name"]);
  const last = fieldValue(fields, ["last_name"]);

  return {
    fullName:
      fieldValue(fields, ["full_name", "nome_completo", "nome"]) ??
      ([first, last].filter(Boolean).join(" ") || null),
    email: fieldValue(fields, ["email", "e-mail"]),
    phone: fieldValue(fields, ["phone_number", "phone", "telefone", "whatsapp"]),
  };
}

/** Meta lead ids are 15-17 digit numbers. */
export function isMetaLeadId(value: string | null | undefined): value is string {
  return /^\d{15,17}$/.test(value ?? "");
}
