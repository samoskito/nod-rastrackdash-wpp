import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildCrmEventBody,
  crmIneligibility,
  postCrmEvent,
} from "../../src/meta-lead-forms/meta-crm-capi";
import {
  leadContact,
  parseLeadgenPayload,
  routeLeadForm,
} from "../../src/meta-lead-forms/meta-leadgen";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const LEAD_ID = "1234567890123456789".slice(0, 17);

describe("parseLeadgenPayload", () => {
  it("keeps only valid leadgen changes of a Page payload", () => {
    const parsed = parseLeadgenPayload({
      object: "page",
      entry: [
        {
          id: "page1",
          changes: [
            {
              field: "leadgen",
              value: { leadgen_id: 123, page_id: "999", form_id: "55" },
            },
            { field: "feed", value: {} },
            { field: "leadgen", value: { page_id: "999" } },
          ],
        },
      ],
    });

    expect(parsed).toEqual({
      changes: [{ leadgen_id: "123", page_id: "999", form_id: "55" }],
      invalid: 1,
    });
  });

  it("is not a Page payload for WhatsApp deliveries", () => {
    expect(
      parseLeadgenPayload({ object: "whatsapp_business_account", entry: [] }),
    ).toBeNull();
  });
});

describe("routeLeadForm", () => {
  const a = { id: "a", pageId: "p1", formIds: ["f1"] };
  const b = { id: "b", pageId: "p1", formIds: [] as string[] };
  const c = { id: "c", pageId: "p2", formIds: [] as string[] };

  it("a single connection of the Page takes every form", () => {
    expect(routeLeadForm([a, c], "p1", "other")).toMatchObject({
      connection: a,
      reason: "page_match",
    });
  });

  it("a shared Page routes by form, then to the catch-all", () => {
    expect(routeLeadForm([a, b], "p1", "f1").connection).toBe(a);
    expect(routeLeadForm([a, b], "p1", "f2")).toMatchObject({
      connection: b,
      reason: "page_default",
    });
  });

  it("an unknown Page or two catch-alls are unrouted", () => {
    expect(routeLeadForm([a], "p9").reason).toBe("no_page_match");
    expect(routeLeadForm([b, { ...b, id: "d" }], "p1").reason).toBe(
      "ambiguous",
    );
  });
});

describe("leadContact", () => {
  it("reads the standard questions and falls back to first + last name", () => {
    expect(
      leadContact({
        id: "1",
        field_data: [
          { name: "first_name", values: ["Ana"] },
          { name: "last_name", values: ["Souza"] },
          { name: "EMAIL", values: [" ana@x.com "] },
          { name: "phone_number", values: ["+55 47 99783-1903"] },
        ],
      }),
    ).toEqual({
      fullName: "Ana Souza",
      email: "ana@x.com",
      phone: "+55 47 99783-1903",
    });
  });
});

describe("CRM event", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  const lead = {
    metaLeadId: LEAD_ID,
    email: " Ana@X.com ",
    phone: "+55 (47) 99783-1903",
    createdAt: new Date("2026-10-10T12:00:00Z"),
  };

  it("matches the Dashboard Leads CRM payload, lead_id as a number", () => {
    const body = buildCrmEventBody({
      lead,
      eventName: "LeadQualificado",
      eventId: `${LEAD_ID}:LeadQualificado`,
      qualifiedAt: new Date("2026-10-17T11:00:00Z"),
      now,
      testEventCode: "TEST1",
    });

    expect(body).toContain(`"lead_id":${LEAD_ID}`);
    expect(JSON.parse(body)).toEqual({
      data: [
        {
          event_name: "LeadQualificado",
          event_time: Math.floor(Date.parse("2026-10-17T11:00:00Z") / 1000),
          action_source: "system_generated",
          event_id: `${LEAD_ID}:LeadQualificado`,
          user_data: {
            lead_id: Number(LEAD_ID),
            em: [sha("ana@x.com")],
            ph: [sha("5547997831903")],
          },
          custom_data: { event_source: "crm", lead_event_source: "RastrackDash" },
        },
      ],
      test_event_code: "TEST1",
    });
  });

  it("a qualification older than 6 days is sent with the current time", () => {
    const body = JSON.parse(
      buildCrmEventBody({
        lead,
        eventName: "LeadQualificado",
        eventId: "x",
        qualifiedAt: new Date("2026-10-01T00:00:00Z"),
        now,
      }),
    );

    expect(body.data[0].event_time).toBe(Math.floor(now.getTime() / 1000));
  });

  it("refuses what Meta would reject", () => {
    const base = {
      metaLeadId: LEAD_ID,
      createdAt: lead.createdAt,
      datasetId: "777",
      eventName: "LeadQualificado",
    };

    expect(crmIneligibility(base, now)).toBeNull();
    expect(crmIneligibility({ ...base, datasetId: null }, now)).toMatch(/dataset/);
    expect(crmIneligibility({ ...base, eventName: "Lead" }, now)).toMatch(/ja recebe/);
    expect(crmIneligibility({ ...base, metaLeadId: "12" }, now)).toMatch(/invalido/);
    expect(
      crmIneligibility(
        { ...base, createdAt: new Date("2026-09-01T00:00:00Z") },
        now,
      ),
    ).toMatch(/28 dias/);
  });

  it("posts with a bearer token and requires events_received", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ events_received: 1, fbtrace_id: "trace" }),
    );

    const result = await postCrmEvent({
      datasetId: "777",
      token: "secret-token",
      body: '{"data":[]}',
      version: "v21.0",
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ status: "sent", errorCode: null });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/777/events");
    expect(url).not.toContain("secret-token");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-token",
    );
  });

  it("reports a Meta rejection with its message", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { error: { message: "Invalid parameter", code: 100 } },
        { status: 400 },
      ),
    );

    const result = await postCrmEvent({
      datasetId: "777",
      token: "t",
      body: "{}",
      version: "v21.0",
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "error",
      errorCode: "MetaCapiRejected",
      errorMessage: "A Meta recusou o evento (codigo 100): Invalid parameter",
    });
  });
});
