import { describe, expect, it } from "vitest";
import { FunnelConfigurationService } from "../src/conversion-rules/funnel-configuration.service";

type Stage = {
  workspaceId: string;
  eventName: string;
  label: string;
  position: number;
  visible: boolean;
  defaultValueCents: number | null;
  defaultCurrency: string | null;
  defaultContentName: string | null;
};

function createHarness() {
  const db = {
    stages: [] as Stage[],
    rules: [
      {
        workspaceId: "workspace_1",
        eventName: "OrderDelivered",
        active: true
      },
      {
        workspaceId: "workspace_1",
        eventName: "OrderCanceled",
        active: false
      }
    ],
    auditLogs: [] as Array<Record<string, unknown>>
  };
  const transaction = {
    funnelStageConfiguration: {
      findMany: async ({ where }: { where: { workspaceId: string } }) =>
        db.stages.filter((stage) => stage.workspaceId === where.workspaceId),
      deleteMany: async ({ where }: { where: { workspaceId: string } }) => {
        db.stages = db.stages.filter(
          (stage) => stage.workspaceId !== where.workspaceId
        );
        return { count: 1 };
      },
      createMany: async ({ data }: { data: Stage[] }) => {
        db.stages.push(...data);
        return { count: data.length };
      }
    },
    conversionRule: {
      findMany: async ({ where }: { where: { workspaceId: string; active: boolean } }) =>
        db.rules.filter(
          (rule) =>
            rule.workspaceId === where.workspaceId && rule.active === where.active
        )
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        db.auditLogs.push(data);
        return data;
      }
    }
  };
  const prisma = {
    ...transaction,
    $transaction: async (callback: (client: unknown) => Promise<void>) =>
      callback(transaction)
  };

  return {
    db,
    service: new FunnelConfigurationService(prisma as never)
  };
}

describe("funnel configuration service", () => {
  it("merges the default journey with active rule events", async () => {
    const { service } = createHarness();

    const configuration = await service.getConfiguration("workspace_1");

    expect(configuration.stages).toEqual([
      {
        eventName: "LeadSubmitted",
        label: "Leads novos",
        position: 1,
        visible: true,
        defaultValueCents: null,
        defaultCurrency: null,
        defaultContentName: null
      },
      {
        eventName: "QualifiedLead",
        label: "Lead qualificado",
        position: 2,
        visible: true,
        defaultValueCents: null,
        defaultCurrency: null,
        defaultContentName: null
      },
      {
        eventName: "Purchase",
        label: "Compras",
        position: 3,
        visible: true,
        defaultValueCents: null,
        defaultCurrency: null,
        defaultContentName: null
      },
      {
        eventName: "OrderDelivered",
        label: "Pedido entregue",
        position: 4,
        visible: true,
        defaultValueCents: null,
        defaultCurrency: null,
        defaultContentName: null
      }
    ]);
  });

  it("places a newly activated InitiateCheckout rule before Purchase", async () => {
    const { db, service } = createHarness();

    // Caso Caxias: regra de checkout criada depois de tudo, sem funil persistido.
    db.rules = [
      { workspaceId: "workspace_1", eventName: "InitiateCheckout", active: true }
    ];

    const configuration = await service.getConfiguration("workspace_1");

    expect(configuration.stages.map((stage) => stage.eventName)).toEqual([
      "LeadSubmitted",
      "QualifiedLead",
      "InitiateCheckout",
      "Purchase"
    ]);
  });

  it("anchors new events to the persisted funnel instead of appending them", async () => {
    const { db, service } = createHarness();

    db.stages = [
      {
        workspaceId: "workspace_1",
        eventName: "Purchase",
        label: "Vendas",
        position: 1,
        visible: true,
        defaultValueCents: null,
        defaultCurrency: null,
        defaultContentName: null
      },
      {
        workspaceId: "workspace_1",
        eventName: "LeadSubmitted",
        label: "Conversas",
        position: 2,
        visible: true,
        defaultValueCents: null,
        defaultCurrency: null,
        defaultContentName: null
      }
    ];
    db.rules = [
      { workspaceId: "workspace_1", eventName: "InitiateCheckout", active: true }
    ];

    const configuration = await service.getConfiguration("workspace_1");

    // A ordem manual do cliente manda; os eventos novos entram depois da etapa
    // persistida que os precede no catalogo.
    expect(configuration.stages.map((stage) => stage.eventName)).toEqual([
      "Purchase",
      "LeadSubmitted",
      "QualifiedLead",
      "InitiateCheckout"
    ]);
    expect(configuration.stages.map((stage) => stage.position)).toEqual([
      1, 2, 3, 4
    ]);
  });

  it("persists custom labels, visibility and normalized ordering", async () => {
    const { db, service } = createHarness();

    const configuration = await service.updateConfiguration(
      "workspace_1",
      {
        stages: [
          {
            eventName: "Purchase",
            label: "Vendas",
            position: 20,
            visible: false
          },
          {
            eventName: "QualifiedLead",
            label: "Oportunidades",
            position: 10,
            visible: true
          }
        ]
      },
      "user_1"
    );

    expect(configuration.stages).toEqual([
      {
        eventName: "QualifiedLead",
        label: "Oportunidades",
        position: 1,
        visible: true
      },
      {
        eventName: "Purchase",
        label: "Vendas",
        position: 2,
        visible: false
      }
    ]);
    expect(db.stages).toEqual([
      expect.objectContaining({
        workspaceId: "workspace_1",
        eventName: "QualifiedLead",
        position: 1
      }),
      expect.objectContaining({
        workspaceId: "workspace_1",
        eventName: "Purchase",
        position: 2,
        visible: false
      })
    ]);
    expect(db.auditLogs).toContainEqual(
      expect.objectContaining({
        action: "funnel_configuration.updated",
        actorUserId: "user_1",
        resultStatus: "success"
      })
    );
  });
});
