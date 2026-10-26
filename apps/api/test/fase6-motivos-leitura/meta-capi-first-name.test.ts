import { describe, expect, it, vi } from "vitest";
import {
  hashMetaFirstName,
  metaCapiFirstNameEnabled,
  metaCapiFirstNameHash,
  normalizeMetaFirstName,
} from "../../src/conversion-events/meta-capi-first-name";
import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";
import { buildMetaCapiPayload } from "../../src/conversion-events/meta-capi-payload.builder";
import {
  MetaCapiAdapter,
  type MetaCapiSendEventInput,
} from "../../src/conversion-events/meta-capi.adapter";

// Exemplos oficiais da Meta (Customer Information Parameters, linha "fn").
const META_MARY_HASH =
  "6915771be1c5aa0c886870b6951b03d7eafc121fea0e80a5ea83beb7c449f4ec";
const META_VALERY_HASH =
  "08e1996b5dd49e62a4b4c010d44e4345592a863bb9f8e3976219bac29417149c";

describe("normalizeMetaFirstName", () => {
  it("lowercases and trims, as in the Meta example", () => {
    expect(normalizeMetaFirstName("  Mary  ")).toBe("mary");
  });

  it("keeps accents (UTF-8), as in the Meta example Valéry -> valéry", () => {
    expect(normalizeMetaFirstName("Valéry")).toBe("valéry");
    expect(normalizeMetaFirstName("JOÃO")).toBe("joão");
    expect(normalizeMetaFirstName("Ícaro")).toBe("ícaro");
    // Decomposed input (NFD) ends up in the same NFC form.
    expect(normalizeMetaFirstName("Valéry")).toBe("valéry");
  });

  it("sends only the first name of a compound name", () => {
    expect(normalizeMetaFirstName("Maria Clara Souza")).toBe("maria");
    expect(normalizeMetaFirstName("Dr. João Pedro")).toBe("joão");
    // No punctuation, per Meta.
    expect(normalizeMetaFirstName("Ana-Clara")).toBe("anaclara");
    expect(normalizeMetaFirstName("D'Ávila")).toBe("dávila");
  });

  it("strips emoji around a real name", () => {
    expect(normalizeMetaFirstName("🌸 Fernanda ✨")).toBe("fernanda");
    expect(normalizeMetaFirstName("Bia❤️")).toBe("bia");
  });

  it("does not send emoji or symbols only", () => {
    expect(normalizeMetaFirstName("😀😀")).toBeNull();
    expect(normalizeMetaFirstName("❤️")).toBeNull();
    expect(normalizeMetaFirstName("...")).toBeNull();
    expect(normalizeMetaFirstName("👨‍👩‍👧")).toBeNull();
  });

  it("does not send something that looks like a phone", () => {
    expect(normalizeMetaFirstName("+55 11 99999-0000")).toBeNull();
    expect(normalizeMetaFirstName("5511999990000")).toBeNull();
    expect(normalizeMetaFirstName("(11) 99999-0000 Maria")).toBeNull();
  });

  it("does not send empty or missing names", () => {
    expect(normalizeMetaFirstName("")).toBeNull();
    expect(normalizeMetaFirstName("   ")).toBeNull();
    expect(normalizeMetaFirstName(null)).toBeNull();
    expect(normalizeMetaFirstName(undefined)).toBeNull();
  });

  it("does not send generic names or a lone initial", () => {
    expect(normalizeMetaFirstName("Cliente")).toBeNull();
    expect(normalizeMetaFirstName("LEAD")).toBeNull();
    expect(normalizeMetaFirstName("Cliente WhatsApp")).toBeNull();
    expect(normalizeMetaFirstName("Usuário")).toBeNull();
    expect(normalizeMetaFirstName("Sem nome")).toBeNull();
    expect(normalizeMetaFirstName("J.")).toBeNull();
  });
});

const ON = { META_CAPI_SEND_FIRST_NAME: "true" };

describe("hashMetaFirstName", () => {
  it("matches the SHA-256 published by Meta", () => {
    expect(hashMetaFirstName("mary")).toBe(META_MARY_HASH);
    expect(hashMetaFirstName("valéry")).toBe(META_VALERY_HASH);
    expect(metaCapiFirstNameHash("Valéry Dupont", ON)).toBe(META_VALERY_HASH);
  });

  it("returns 64 lowercase hex chars and never the plain name", () => {
    const hash = metaCapiFirstNameHash("Fernanda", ON)!;
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hash).not.toContain("fernanda");
  });
});

describe("META_CAPI_SEND_FIRST_NAME switch", () => {
  it("is off by default", () => {
    expect(metaCapiFirstNameEnabled({})).toBe(false);
    expect(metaCapiFirstNameEnabled({ META_CAPI_SEND_FIRST_NAME: "" })).toBe(
      false,
    );
    expect(metaCapiFirstNameHash("Mary", {})).toBeNull();
  });

  it("turns on only with true/1/on/yes", () => {
    for (const value of ["true", "TRUE", " 1 ", "on", "yes"]) {
      expect(
        metaCapiFirstNameEnabled({ META_CAPI_SEND_FIRST_NAME: value }),
      ).toBe(true);
    }
  });

  it("stays off with false/0/off/no or anything else", () => {
    for (const value of ["false", "FALSE", " 0 ", "off", "no", "maybe"]) {
      expect(
        metaCapiFirstNameEnabled({ META_CAPI_SEND_FIRST_NAME: value }),
      ).toBe(false);
      expect(
        metaCapiFirstNameHash("Mary", { META_CAPI_SEND_FIRST_NAME: value }),
      ).toBeNull();
    }
  });
});

describe("fn in the CAPI payload", () => {
  const base = {
    eventName: "QualifiedLead" as const,
    eventTime: new Date("2026-10-20T12:00:00.000Z"),
    eventId: "workspace_1:lead_1:rule_1:QualifiedLead:ad_1",
    phoneHash: "phone_hash",
    ctwaClid: "ctwa_1",
    pageId: "page_1",
    adId: "ad_1",
  };

  it("adds fn next to ph without touching event_id", () => {
    const payload = buildMetaCapiPayload({
      ...base,
      firstNameHash: META_MARY_HASH,
    });
    expect(payload.data[0]!.user_data).toEqual({
      ph: ["phone_hash"],
      fn: [META_MARY_HASH],
      ctwa_clid: "ctwa_1",
      page_id: "page_1",
    });
    expect(payload.data[0]!.event_id).toBe(base.eventId);
  });

  it("omits fn when there is no usable first name", () => {
    const payload = buildMetaCapiPayload({ ...base, firstNameHash: null });
    expect(payload.data[0]!.user_data).not.toHaveProperty("fn");
  });
});

describe("MetaCapiAdapter first name", () => {
  function input(
    overrides: Partial<MetaCapiSendEventInput> = {},
  ): MetaCapiSendEventInput {
    return {
      // nod: token explícito (a 6.0 não cai no token do ambiente com null).
      accessToken: "meta-token",
      pixelId: "pixel_1",
      pageId: "page_1",
      eventName: "QualifiedLead",
      dedupeKey: "workspace_1:lead_1:rule_1:QualifiedLead:ad_1",
      phoneHash: "phone_hash",
      leadName: "Mary Jane",
      adId: "ad_1",
      ctwaClid: "ctwa_1",
      ...overrides,
    };
  }

  function fetchOk() {
    return vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ events_received: 1, messages: [], fbtrace_id: "synthetic" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
  }

  it("does not send fn by default", async () => {
    const fetchMock = fetchOk();
    const adapter = new MetaCapiAdapter(
      { META_CAPI_ACCESS_TOKEN: "meta-token" },
      fetchMock as never,
    );

    await adapter.sendEvent(input());

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.data[0].user_data).not.toHaveProperty("fn");
    expect(body.data[0].user_data.ph).toEqual(["phone_hash"]);
  });

  it("sends the hashed first name when switched on and never the raw name", async () => {
    const fetchMock = fetchOk();
    const adapter = new MetaCapiAdapter(
      { META_CAPI_ACCESS_TOKEN: "meta-token", ...ON },
      fetchMock as never,
    );

    const result = await adapter.sendEvent(input());

    expect(result, JSON.stringify(result)).toMatchObject({ status: "sent" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.data[0].user_data.fn).toEqual([META_MARY_HASH]);
    expect(body.data[0].event_id).toBe(
      "workspace_1:lead_1:rule_1:QualifiedLead:ad_1",
    );
    expect(JSON.stringify(body)).not.toMatch(/mary/iu);
  });

  it("does not send fn when the switch is off", async () => {
    const fetchMock = fetchOk();
    const adapter = new MetaCapiAdapter(
      {
        META_CAPI_ACCESS_TOKEN: "meta-token",
        META_CAPI_SEND_FIRST_NAME: "false",
      },
      fetchMock as never,
    );

    await adapter.sendEvent(input());

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.data[0].user_data).not.toHaveProperty("fn");
    expect(body.data[0].user_data.ph).toEqual(["phone_hash"]);
  });

  it("does not send fn for a generic or phone-like name", async () => {
    for (const leadName of ["Cliente", "+55 11 99999-0000", "😀", null]) {
      const fetchMock = fetchOk();
      const adapter = new MetaCapiAdapter(
        { META_CAPI_ACCESS_TOKEN: "meta-token", ...ON },
        fetchMock as never,
      );
      await adapter.sendEvent(input({ leadName }));
      const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
      expect(body.data[0].user_data).not.toHaveProperty("fn");
    }
  });
});

// Fase 6.1b — porte do #179/#180 do SaaS (a7ccdab3, c44dc9fb): o serviço lê
// o nome do lead do próprio workspace; qualquer falha envia sem fn.
describe("ConversionEventsService.leadNameForCapi", () => {
  type Reader = {
    prisma: unknown;
    leadNameForCapi(log: {
      leadId?: string | null;
      workspaceId?: string | null;
    }): Promise<string | null>;
  };
  function reader(prisma: unknown): Reader {
    const service = Object.create(
      ConversionEventsService.prototype,
    ) as Reader;
    service.prisma = prisma;
    return service;
  }

  it("desligado (padrão): nem consulta o lead", async () => {
    const findFirst = vi.fn(async () => ({ name: "Maria Fictícia" }));
    vi.stubEnv("META_CAPI_SEND_FIRST_NAME", "");
    try {
      await expect(
        reader({ lead: { findFirst } }).leadNameForCapi({
          leadId: "lead_1",
          workspaceId: "workspace_1",
        }),
      ).resolves.toBeNull();
      expect(findFirst).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lê o nome do lead no workspace do evento", async () => {
    vi.stubEnv("META_CAPI_SEND_FIRST_NAME", "true");
    const findFirst = vi.fn(async () => ({ name: "Maria Fictícia" }));
    await expect(
      reader({ lead: { findFirst } }).leadNameForCapi({
        leadId: "lead_1",
        workspaceId: "workspace_1",
      }),
    ).resolves.toBe("Maria Fictícia");
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "lead_1", workspaceId: "workspace_1" },
      select: { name: true },
    });
    vi.unstubAllEnvs();
  });

  it("sem lead ou com falha na leitura: envia sem fn (null)", async () => {
    vi.stubEnv("META_CAPI_SEND_FIRST_NAME", "true");
    const findFirst = vi.fn(async () => {
      throw new Error("db down");
    });
    await expect(
      reader({ lead: { findFirst } }).leadNameForCapi({
        leadId: "lead_1",
        workspaceId: "workspace_1",
      }),
    ).resolves.toBeNull();
    await expect(
      reader({ lead: { findFirst } }).leadNameForCapi({
        leadId: null,
        workspaceId: "workspace_1",
      }),
    ).resolves.toBeNull();
    vi.unstubAllEnvs();
  });
});
