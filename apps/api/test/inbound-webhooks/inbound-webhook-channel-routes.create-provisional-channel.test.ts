import "reflect-metadata";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { InboundWebhookChannelRoutesService } from "../../src/inbound-webhooks/inbound-webhook-channel-routes.service";

type ConnectionRow = {
  id: string;
  workspaceId: string;
  provider: string;
  removedAt: Date | null;
};

type ChannelRow = {
  id: string;
  workspaceId: string;
  connectionId: string;
  organizationId: string;
  providerChannelId: string;
  connectedPhone: string;
  channelName: string | null;
  status: string;
  conversionEngineMode: string;
  productionActivatedAt: Date | null;
  whatsappInstanceId: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const now = new Date("2026-09-01T12:00:00.000Z");
let channelSeq = 0;

function makeConnection(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "connection_1",
    workspaceId: "workspace_1",
    provider: "umbler",
    removedAt: null,
    ...overrides,
  };
}

function makeChannelRow(input: {
  workspaceId: string;
  connectionId: string;
  organizationId: string;
  providerChannelId: string;
  connectedPhone: string;
  channelName: string | null;
}): ChannelRow {
  channelSeq += 1;

  return {
    id: `channel_${channelSeq}`,
    status: "discovered",
    conversionEngineMode: "canonical",
    productionActivatedAt: null,
    whatsappInstanceId: null,
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

function withRelations(channel: ChannelRow, connections: ConnectionRow[]) {
  const connection = connections.find((c) => c.id === channel.connectionId);

  return {
    ...channel,
    connection: connection
      ? {
          id: connection.id,
          workspaceId: connection.workspaceId,
          provider: connection.provider,
          status: "observation",
          removedAt: connection.removedAt,
        }
      : null,
    routes: [],
  };
}

function fakePrisma(connections: ConnectionRow[], channels: ChannelRow[] = []) {
  const audits: unknown[] = [];
  const prisma = {
    inboundWebhookConnection: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; workspaceId: string; removedAt: null };
      }) =>
        connections.find(
          (connection) =>
            connection.id === where.id &&
            connection.workspaceId === where.workspaceId &&
            connection.removedAt === where.removedAt,
        ) ?? null,
    },
    inboundWebhookChannel: {
      findFirst: async ({
        where,
      }: {
        where: {
          workspaceId: string;
          connectionId: string;
          connectedPhone: string;
        };
      }) => {
        const match = channels.find(
          (channel) =>
            channel.workspaceId === where.workspaceId &&
            channel.connectionId === where.connectionId &&
            channel.connectedPhone === where.connectedPhone,
        );

        return match ? withRelations(match, connections) : null;
      },
      create: async ({
        data,
      }: {
        data: Parameters<typeof makeChannelRow>[0];
      }) => {
        const row = makeChannelRow(data);
        channels.push(row);
        return withRelations(row, connections);
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<ChannelRow>;
      }) => {
        const row = channels.find((channel) => channel.id === where.id);
        if (!row) {
          throw new Error("channel not found");
        }
        Object.assign(row, data);
        return withRelations(row, connections);
      },
    },
    inboundWebhookEvent: {
      findMany: async () => [],
    },
    inboundWebhookDelivery: {
      findMany: async () => [],
    },
    auditLog: {
      create: async ({ data }: { data: unknown }) => {
        audits.push(data);
        return data;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };

  return { prisma, connections, channels, audits };
}

describe("InboundWebhookChannelRoutesService.createProvisionalChannel (P0.2)", () => {
  it("registers a provisional channel with a stable placeholder identity before any webhook arrives", async () => {
    const { prisma, channels } = fakePrisma([makeConnection()]);
    const service = new InboundWebhookChannelRoutesService(
      prisma as never,
      {} as never,
    );

    const dto = await service.createProvisionalChannel(
      "workspace_1",
      "connection_1",
      { connectedPhone: "(11) 99999-8888", channelName: "Comercial" },
      "user_1",
    );

    expect(channels).toHaveLength(1);
    expect(dto.connectedPhone).toBe("11999998888");
    expect(dto.channelName).toBe("Comercial");
    expect(dto.providerChannelId).toBe("provisional:11999998888");
    expect(dto.organizationId).toBe("provisional:connection_1");
    expect(dto.status).toBe("discovered");
    expect(dto.routes).toEqual([]);
  });

  it("does not create a duplicate channel when the number was already registered on this connection", async () => {
    const { prisma, channels } = fakePrisma([makeConnection()]);
    const service = new InboundWebhookChannelRoutesService(
      prisma as never,
      {} as never,
    );

    const first = await service.createProvisionalChannel(
      "workspace_1",
      "connection_1",
      { connectedPhone: "11999998888" },
      "user_1",
    );
    const second = await service.createProvisionalChannel(
      "workspace_1",
      "connection_1",
      { connectedPhone: "(11) 99999-8888", channelName: "Comercial" },
      "user_1",
    );

    expect(channels).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.channelName).toBe("Comercial");
  });

  it("rejects manual creation for UAZAPI connections, which are bridged automatically", async () => {
    const { prisma } = fakePrisma([
      makeConnection({ id: "connection_2", provider: "uazapi" }),
    ]);
    const service = new InboundWebhookChannelRoutesService(
      prisma as never,
      {} as never,
    );

    await expect(
      service.createProvisionalChannel(
        "workspace_1",
        "connection_2",
        { connectedPhone: "11999998888" },
        "user_1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects an invalid phone number", async () => {
    const { prisma } = fakePrisma([makeConnection()]);
    const service = new InboundWebhookChannelRoutesService(
      prisma as never,
      {} as never,
    );

    await expect(
      service.createProvisionalChannel(
        "workspace_1",
        "connection_1",
        { connectedPhone: "abc" },
        "user_1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("returns not found for a connection outside the caller's workspace (anti-IDOR)", async () => {
    const { prisma } = fakePrisma([
      makeConnection({ workspaceId: "other_workspace" }),
    ]);
    const service = new InboundWebhookChannelRoutesService(
      prisma as never,
      {} as never,
    );

    await expect(
      service.createProvisionalChannel(
        "workspace_1",
        "connection_1",
        { connectedPhone: "11999998888" },
        "user_1",
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
