import { describe, expect, it, vi } from "vitest";
import { MetaAdapter } from "../../src/integrations/meta/meta.adapter";

describe("meta adapter: ad accounts shared with the BM as a partner", () => {
  it("merges partner-shared client_ad_accounts after owned, deduplicated by id", async () => {
    const account = (id: string, name: string) => ({
      id,
      name,
      account_status: 1,
      currency: "BRL",
      timezone_name: "America/Sao_Paulo",
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes("/business_1/owned_ad_accounts")) {
        return new Response(
          JSON.stringify({ data: [account("act_1", "Propria")] }),
          { status: 200 },
        );
      }

      if (url.includes("/business_1/client_ad_accounts")) {
        return new Response(
          JSON.stringify({
            data: [account("act_1", "Propria"), account("act_9", "Cliente")],
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new MetaAdapter(
      { META_GRAPH_API_VERSION: "v25.0" },
      fetchMock,
    );

    const result = await adapter.listOwnedAdAccounts({
      accessToken: "EAAB-secret-token",
      businessId: "business_1",
    });

    expect(result.map((item) => item.id)).toEqual(["act_1", "act_9"]);
    expect(result[1]).toMatchObject({
      businessId: "business_1",
      name: "Cliente",
      currency: "BRL",
    });
  });

  it.each(["owned_ad_accounts", "client_ad_accounts"])(
    "keeps the other ad account edge when %s fails",
    async (failingEdge) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);

        if (url.includes(`/business_1/${failingEdge}`)) {
          return new Response(
            JSON.stringify({
              error: {
                message: "(#200) sem permissao",
                type: "OAuthException",
                code: 200,
              },
            }),
            { status: 403 },
          );
        }

        return new Response(
          JSON.stringify({
            data: [
              {
                id: "act_ok",
                name: "Conta ok",
                account_status: 1,
                currency: "BRL",
                timezone_name: "America/Sao_Paulo",
              },
            ],
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;
      const adapter = new MetaAdapter(
        { META_GRAPH_API_VERSION: "v25.0" },
        fetchMock,
      );

      await expect(
        adapter.listOwnedAdAccounts({
          accessToken: "EAAB-secret-token",
          businessId: "business_1",
        }),
      ).resolves.toEqual([expect.objectContaining({ id: "act_ok" })]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("ad account edge failed"),
        expect.objectContaining({ edge: failingEdge }),
      );
      warn.mockRestore();
    },
  );

  it("throws when both ad account edges fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "boom", code: 1 } }), {
          status: 500,
        }),
    ) as unknown as typeof fetch;
    const adapter = new MetaAdapter(
      { META_GRAPH_API_VERSION: "v25.0" },
      fetchMock,
    );

    await expect(
      adapter.listOwnedAdAccounts({
        accessToken: "EAAB-secret-token",
        businessId: "business_1",
      }),
    ).rejects.toThrow();
    warn.mockRestore();
  });
});
