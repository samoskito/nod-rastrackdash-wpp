import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { ProviderConversionRulesService } from "../../src/conversion-rules/provider-conversion-rules.service";

/**
 * Rule creation only checks that a channelId belongs to the workspace +
 * connection (see assertChannelsBelongToConnection) — it never requires the
 * channel to have observed a webhook yet. A provisional channel created via
 * InboundWebhookChannelRoutesService.createProvisionalChannel (status
 * "discovered", no routes) is a normal InboundWebhookChannel row, so it
 * satisfies this check exactly like a real one. This is what lets a student
 * create tag/keyword/catalog rules before the first webhook arrives (P0.2).
 */
type ChannelRow = {
  id: string;
  workspaceId: string;
  connectionId: string;
  status: string;
};

function fakeTransaction(channels: ChannelRow[]) {
  return {
    inboundWebhookChannel: {
      count: async ({
        where,
      }: {
        where: {
          workspaceId: string;
          connectionId: string;
          id: { in: string[] };
        };
      }) =>
        channels.filter(
          (channel) =>
            channel.workspaceId === where.workspaceId &&
            channel.connectionId === where.connectionId &&
            where.id.in.includes(channel.id),
        ).length,
    },
  };
}

function invokeAssertChannelsBelongToConnection(
  service: ProviderConversionRulesService,
  transaction: unknown,
  workspaceId: string,
  connectionId: string,
  channelIds: string[],
): Promise<void> {
  return (
    service as unknown as {
      assertChannelsBelongToConnection: (
        transaction: unknown,
        workspaceId: string,
        connectionId: string,
        channelIds: string[],
      ) => Promise<void>;
    }
  ).assertChannelsBelongToConnection(
    transaction,
    workspaceId,
    connectionId,
    channelIds,
  );
}

describe("ProviderConversionRulesService channel scope for provisional channels (P0.2)", () => {
  it("accepts a provisional (status discovered, no routes yet) channel for rule creation", async () => {
    const service = new ProviderConversionRulesService(
      {} as never,
      {} as never,
    );
    const transaction = fakeTransaction([
      {
        id: "channel_provisional",
        workspaceId: "workspace_1",
        connectionId: "connection_1",
        status: "discovered",
      },
    ]);

    await expect(
      invokeAssertChannelsBelongToConnection(
        service,
        transaction,
        "workspace_1",
        "connection_1",
        ["channel_provisional"],
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a channel that belongs to a different workspace or connection", async () => {
    const service = new ProviderConversionRulesService(
      {} as never,
      {} as never,
    );
    const transaction = fakeTransaction([
      {
        id: "channel_other",
        workspaceId: "other_workspace",
        connectionId: "connection_1",
        status: "discovered",
      },
    ]);

    await expect(
      invokeAssertChannelsBelongToConnection(
        service,
        transaction,
        "workspace_1",
        "connection_1",
        ["channel_other"],
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
