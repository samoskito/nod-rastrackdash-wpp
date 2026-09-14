import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { InboundWebhookObservationService } from "../../src/inbound-webhooks/inbound-webhook-observation.service";
import {
  provisionalChannelOrganizationId,
  provisionalChannelProviderChannelId,
} from "../../src/inbound-webhooks/inbound-webhook-provisional-channel";

type ChannelRow = {
  id: string;
  workspaceId: string;
  connectionId: string;
  organizationId: string;
  providerChannelId: string;
  connectedPhone: string;
  channelName: string | null;
  lastSeenAt: Date;
};

type CompositeKey = {
  connectionId: string;
  organizationId: string;
  providerChannelId: string;
};

function matchesKey(row: ChannelRow, key: CompositeKey): boolean {
  return (
    row.connectionId === key.connectionId &&
    row.organizationId === key.organizationId &&
    row.providerChannelId === key.providerChannelId
  );
}

function pick<T extends object>(
  row: T,
  select?: Partial<Record<keyof T, boolean>>,
): Partial<T> {
  if (!select) {
    return { ...row };
  }

  const result: Partial<T> = {};
  for (const key of Object.keys(select) as (keyof T)[]) {
    if (select[key]) {
      result[key] = row[key];
    }
  }
  return result;
}

function fakeChannelStore(initial: ChannelRow[]) {
  const rows = [...initial];

  const tx = {
    inboundWebhookChannel: {
      findUnique: async ({
        where,
        select,
      }: {
        where: {
          connectionId_organizationId_providerChannelId: CompositeKey;
        };
        select?: Partial<Record<keyof ChannelRow, boolean>>;
      }) => {
        const row = rows.find((candidate) =>
          matchesKey(
            candidate,
            where.connectionId_organizationId_providerChannelId,
          ),
        );
        return row ? pick(row, select) : null;
      },
      update: async ({
        where,
        data,
        select,
      }: {
        where: { id: string };
        data: Partial<ChannelRow>;
        select?: Partial<Record<keyof ChannelRow, boolean>>;
      }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (!row) {
          throw new Error("channel not found");
        }
        Object.assign(row, data);
        return pick(row, select);
      },
      upsert: async ({
        where,
        create,
        update,
        select,
      }: {
        where: {
          connectionId_organizationId_providerChannelId: CompositeKey;
        };
        create: Omit<ChannelRow, "id">;
        update: Partial<ChannelRow>;
        select?: Partial<Record<keyof ChannelRow, boolean>>;
      }) => {
        const key = where.connectionId_organizationId_providerChannelId;
        const existing = rows.find((candidate) => matchesKey(candidate, key));

        if (existing) {
          Object.assign(existing, update);
          return pick(existing, select);
        }

        const row: ChannelRow = { id: `channel_${rows.length + 1}`, ...create };
        rows.push(row);
        return pick(row, select);
      },
    },
  };

  return { rows, tx };
}

function newService(): InboundWebhookObservationService {
  return new InboundWebhookObservationService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

type UpsertChannelForEvent = (
  tx: unknown,
  delivery: { connectionId: string; workspaceId: string },
  event: {
    organizationId: string;
    channel: {
      providerChannelId: string;
      connectedPhone: string;
      name: string | null;
    };
  },
  processedAt: Date,
) => Promise<{ id: string }>;

function upsertChannelForEvent(
  service: InboundWebhookObservationService,
): UpsertChannelForEvent {
  return (
    service as unknown as { upsertChannelForEvent: UpsertChannelForEvent }
  ).upsertChannelForEvent.bind(service);
}

const delivery = { connectionId: "connection_1", workspaceId: "workspace_1" };
const processedAt = new Date("2026-09-10T10:00:00.000Z");

describe("InboundWebhookObservationService channel merge (P0.2 anti-duplicate)", () => {
  it("merges the real webhook identity into the existing provisional channel, keeping the same id", async () => {
    const provisional: ChannelRow = {
      id: "channel_1",
      workspaceId: "workspace_1",
      connectionId: "connection_1",
      organizationId: provisionalChannelOrganizationId("connection_1"),
      providerChannelId: provisionalChannelProviderChannelId("11999998888"),
      connectedPhone: "11999998888",
      channelName: "Comercial",
      lastSeenAt: new Date("2026-09-01T00:00:00.000Z"),
    };
    const { rows, tx } = fakeChannelStore([provisional]);
    const upsert = upsertChannelForEvent(newService());

    const result = await upsert(
      tx,
      delivery,
      {
        organizationId: "org_real_1",
        channel: {
          providerChannelId: "umbler_channel_9",
          connectedPhone: "(11) 99999-8888",
          name: null,
        },
      },
      processedAt,
    );

    expect(result.id).toBe("channel_1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "channel_1",
      organizationId: "org_real_1",
      providerChannelId: "umbler_channel_9",
      connectedPhone: "(11) 99999-8888",
      // The student's provisional name is kept when the webhook payload
      // carries no channel name of its own.
      channelName: "Comercial",
      lastSeenAt: processedAt,
    });
  });

  it("prefers the webhook payload name over the provisional one when both exist", async () => {
    const provisional: ChannelRow = {
      id: "channel_1",
      workspaceId: "workspace_1",
      connectionId: "connection_1",
      organizationId: provisionalChannelOrganizationId("connection_1"),
      providerChannelId: provisionalChannelProviderChannelId("11999998888"),
      connectedPhone: "11999998888",
      channelName: "Comercial (provisorio)",
      lastSeenAt: new Date("2026-09-01T00:00:00.000Z"),
    };
    const { rows, tx } = fakeChannelStore([provisional]);
    const upsert = upsertChannelForEvent(newService());

    await upsert(
      tx,
      delivery,
      {
        organizationId: "org_real_1",
        channel: {
          providerChannelId: "umbler_channel_9",
          connectedPhone: "(11) 99999-8888",
          name: "Comercial - Umbler",
        },
      },
      processedAt,
    );

    expect(rows[0].channelName).toBe("Comercial - Umbler");
  });

  it("does not insert a second channel once the provisional row has already been merged", async () => {
    const merged: ChannelRow = {
      id: "channel_1",
      workspaceId: "workspace_1",
      connectionId: "connection_1",
      organizationId: "org_real_1",
      providerChannelId: "umbler_channel_9",
      connectedPhone: "(11) 99999-8888",
      channelName: "Comercial",
      lastSeenAt: new Date("2026-09-10T09:00:00.000Z"),
    };
    const { rows, tx } = fakeChannelStore([merged]);
    const upsert = upsertChannelForEvent(newService());

    const result = await upsert(
      tx,
      delivery,
      {
        organizationId: "org_real_1",
        channel: {
          providerChannelId: "umbler_channel_9",
          connectedPhone: "(11) 99999-8888",
          name: null,
        },
      },
      processedAt,
    );

    expect(result.id).toBe("channel_1");
    expect(rows).toHaveLength(1);
    expect(rows[0].lastSeenAt).toEqual(processedAt);
  });

  it("creates a fresh channel via the normal identity path when there is no provisional match", async () => {
    const { rows, tx } = fakeChannelStore([]);
    const upsert = upsertChannelForEvent(newService());

    const result = await upsert(
      tx,
      delivery,
      {
        organizationId: "org_real_2",
        channel: {
          providerChannelId: "umbler_channel_42",
          connectedPhone: "(21) 98888-7777",
          name: "Suporte",
        },
      },
      processedAt,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.id);
    expect(rows[0]).toMatchObject({
      organizationId: "org_real_2",
      providerChannelId: "umbler_channel_42",
      connectedPhone: "(21) 98888-7777",
      channelName: "Suporte",
    });
  });

  it("ignores the provisional lookup when the connected phone cannot be normalized", async () => {
    const { rows, tx } = fakeChannelStore([]);
    const upsert = upsertChannelForEvent(newService());

    const result = await upsert(
      tx,
      delivery,
      {
        organizationId: "org_real_3",
        channel: {
          providerChannelId: "umbler_channel_1",
          connectedPhone: "n/a",
          name: null,
        },
      },
      processedAt,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.id);
    expect(rows[0].providerChannelId).toBe("umbler_channel_1");
  });
});
