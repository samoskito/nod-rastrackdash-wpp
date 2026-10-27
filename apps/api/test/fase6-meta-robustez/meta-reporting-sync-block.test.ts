import { describe, expect, it, vi } from "vitest";
import { resolveCtwaDestination } from "../../src/inbound-webhooks/authorized-ctwa-destination";
import {
  blockMetaReportingSync,
  clearMetaReportingSyncBlocks,
} from "../../src/integrations/meta/meta-reporting-sync-block";
import { pagePixelHarness } from "../helpers/ctwa-harness";

function routingSnapshot(h: ReturnType<typeof pagePixelHarness>) {
  return JSON.stringify({
    credential: {
      status: h.credential.status,
      validationError: h.credential.validationError,
      lastValidatedAt: h.credential.lastValidatedAt,
    },
    businesses: h.businesses.map((business) => ({
      status: business.status,
      validationError: business.validationError,
      lastValidatedAt: business.lastValidatedAt,
    })),
  });
}

function withAccountWrites(h: ReturnType<typeof pagePixelHarness>) {
  const updateMany = vi.fn(
    async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const matches = h.accounts.filter(
        (account) =>
          account.workspaceId === where.workspaceId &&
          (where.id === undefined || account.id === where.id),
      );
      matches.forEach((account) => Object.assign(account, data));

      return { count: matches.length };
    },
  );
  Object.assign(h.prisma.metaReportingAccount, { updateMany });

  return updateMany;
}

describe("reporting-only sync block", () => {
  it.each([
    ["confirmed dead token (190)", { workspaceId: "w", active: true }],
    [
      "missing ad account permission (10)",
      { workspaceId: "w", id: "account0_1" },
    ],
  ])(
    "keeps CTWA page/pixel routing authorized after a %s",
    async (_label, where) => {
      const h = pagePixelHarness();
      const updateMany = withAccountWrites(h);
      const before = routingSnapshot(h);

      await blockMetaReportingSync(h.prisma as never, where, {
        reason: "meta_graph code=190 subcode=460 http=400",
        message: "Reconecte a conta Meta",
      });

      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(
        h.accounts.some((account) =>
          Boolean((account as Record<string, unknown>).reportingSyncBlockedAt),
        ),
      ).toBe(true);
      expect(routingSnapshot(h)).toBe(before);
      await expect(
        resolveCtwaDestination(h.prisma, h.channel),
      ).resolves.toMatchObject({
        kind: "authorized_ctwa_destination",
        deliveryKind: "page_pixel",
        destinationId: "dest",
        pixelId: "synthetic_pixel",
        pageId: "synthetic_page",
      });
    },
  );

  it("is cleared by revalidation flows without touching routing state", async () => {
    const h = pagePixelHarness();
    const updateMany = withAccountWrites(h);
    const before = routingSnapshot(h);

    await blockMetaReportingSync(
      h.prisma as never,
      { workspaceId: "w", active: true },
      { reason: "token_confirmed_dead", message: "Reconecte a conta Meta" },
    );
    await clearMetaReportingSyncBlocks(h.prisma, { workspaceId: "w" });

    expect(updateMany).toHaveBeenLastCalledWith({
      where: { workspaceId: "w", reportingSyncBlockedAt: { not: null } },
      data: {
        reportingSyncBlockedAt: null,
        reportingSyncBlockReason: null,
        syncStatus: "pending",
        syncError: null,
      },
    });
    expect(
      h.accounts.every(
        (account) =>
          (account as Record<string, unknown>).reportingSyncBlockedAt === null,
      ),
    ).toBe(true);
    expect(routingSnapshot(h)).toBe(before);
  });

  it("never fails a revalidation when clearing the block fails", async () => {
    await expect(
      clearMetaReportingSyncBlocks(
        {
          metaReportingAccount: {
            updateMany: vi.fn(async () => {
              throw new Error("database unavailable");
            }),
          },
        },
        { workspaceId: "w" },
      ),
    ).resolves.toBeUndefined();
  });
});
