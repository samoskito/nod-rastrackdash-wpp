import { describe, expect, it, vi } from "vitest";
import { LeadsController } from "../src/leads/leads.controller";
import { LeadsService } from "../src/leads/leads.service";

/**
 * "Excluir lead" (porte do SaaS #292 + correções F2). No aluno não existe
 * lead de observação: só sai o lead SEM NENHUM ENVIO. Dados sintéticos.
 */

const W = "workspace_aluno";

function leads(
  options: {
    linked?: boolean;
    found?: boolean;
    logs?: any[];
    decisions?: any[];
    executions?: any[];
    foreignVersions?: number;
  } = {},
) {
  const calls: string[] = [];
  const logs = options.logs ?? [];
  const tx: any = {
    lead: {
      findFirst: vi.fn(async () =>
        options.found === false ? null : { id: "lead_1" },
      ),
      deleteMany: vi.fn(async () => {
        calls.push("lead.deleteMany");
        return { count: 1 };
      }),
    },
    $queryRaw: vi.fn(async () => [{ linked: options.linked === true }]),
    providerConversionDecisionAudit: {
      findMany: vi.fn(async () => options.decisions ?? []),
      count: vi.fn(async () => options.foreignVersions ?? 0),
      deleteMany: vi.fn(async ({ where }: any) => {
        calls.push(`decision.delete:${where.id}`);
        return { count: 1 };
      }),
    },
    providerConversionRuleExecution: {
      findMany: vi.fn(async () => options.executions ?? []),
      deleteMany: vi.fn(async () => {
        calls.push("execution.deleteMany");
        return { count: 1 };
      }),
    },
    conversionEventLog: {
      findMany: vi.fn(async () => logs),
      deleteMany: vi.fn(async () => {
        calls.push("conversionEventLog.deleteMany");
        return { count: logs.length };
      }),
    },
    diagnosticEvent: {
      updateMany: vi.fn(async () => {
        calls.push("diagnosticEvent.updateMany");
        return { count: 0 };
      }),
    },
    purchaseReview: {
      updateMany: vi.fn(async () => {
        calls.push("purchaseReview.updateMany");
        return { count: 0 };
      }),
    },
    auditLog: {
      create: vi.fn(async () => {
        calls.push("auditLog.create");
      }),
    },
  };
  const prisma: any = { $transaction: vi.fn(async (fn: any) => fn(tx)) };
  return { service: new LeadsService(prisma, {} as any), tx, calls };
}

describe("Excluir lead (aluno: só lead sem nenhum envio)", () => {
  it("deletes a lead with no send at all and audits lead.deleted", async () => {
    const h = leads();
    await expect(h.service.deleteLead(W, "lead_1", "manager")).resolves.toEqual({
      leadId: "lead_1",
      deleted: true,
      conversionsRemoved: 0,
    });
    expect(h.calls).toEqual(["lead.deleteMany", "auditLog.create"]);
    expect(h.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "lead.deleted",
        targetType: "Lead",
        targetId: "lead_1",
        actorUserId: "manager",
      }),
    });
  });

  it("keeps the FK order: unsent rule audit and observed logs go first (newest decision version first)", async () => {
    const h = leads({
      logs: [{ id: "log_1", status: "shadow_observed", sentAt: null }],
      decisions: [
        { id: "dec_v1", decisionVersion: 1, createdAt: new Date("2026-11-23T15:20:00Z") },
        { id: "dec_v2", decisionVersion: 2, createdAt: new Date("2026-11-23T15:25:00Z") },
      ],
      executions: [{ id: "exec_1", status: "observed" }],
    });
    await expect(h.service.deleteLead(W, "lead_1", "manager")).resolves.toMatchObject({
      deleted: true,
      conversionsRemoved: 1,
    });
    expect(h.calls).toEqual([
      "execution.deleteMany",
      "decision.delete:dec_v2",
      "decision.delete:dec_v1",
      "diagnosticEvent.updateMany",
      "purchaseReview.updateMany",
      "conversionEventLog.deleteMany",
      "lead.deleteMany",
      "auditLog.create",
    ]);
  });

  it("refuses (409) a lead with Pipedrive or real purchase links and deletes nothing", async () => {
    const h = leads({ linked: true });
    await expect(h.service.deleteLead(W, "lead_1", "manager")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("vínculo de produção"),
    });
    expect(h.calls).toEqual([]);
  });

  it.each([
    ["sent", new Date()],
    ["ready_to_send", null],
    ["queued", null],
    ["failed", null],
    ["skipped", null],
    ["shadow_observed", new Date()],
  ])("refuses (409) a lead with a conversion log %s and deletes nothing", async (status, sentAt) => {
    const h = leads({ logs: [{ id: "log_1", status, sentAt }] });
    await expect(h.service.deleteLead(W, "lead_1", "manager")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("enviadas ou na fila da Meta"),
    });
    expect(h.calls).toEqual([]);
  });

  it.each(["eligible", "materialized", "failed"])(
    "refuses (409) a lead with a rule execution %s (went to the Meta queue) and deletes nothing",
    async (status) => {
      const h = leads({ executions: [{ id: "exec_1", status }] });
      await expect(h.service.deleteLead(W, "lead_1", "manager")).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("regra enviada ou na fila"),
      });
      expect(h.calls).toEqual([]);
    },
  );

  it("refuses (409) a lead whose rule audit is superseded by another lead's", async () => {
    const h = leads({
      decisions: [{ id: "dec_v1", decisionVersion: 1, createdAt: new Date() }],
      foreignVersions: 1,
    });
    await expect(h.service.deleteLead(W, "lead_1", "manager")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("outro lead"),
    });
    expect(h.calls).toEqual([]);
  });

  it("404 for a lead of another workspace", async () => {
    const h = leads({ found: false });
    await expect(h.service.deleteLead(W, "lead_x", "manager")).rejects.toMatchObject({ status: 404 });
    expect(h.calls).toEqual([]);
  });

  function controller(canManageWorkspaceSettings: boolean) {
    const service: any = { deleteLead: vi.fn(async () => ({ deleted: true })) };
    const auth: any = { getSession: vi.fn(async () => ({ user: { id: "user_1" } })) };
    const workspaces: any = {
      getCurrentWorkspace: vi.fn(() => ({ id: W, permissions: { canManageWorkspaceSettings } })),
    };
    return { controller: new LeadsController(auth, workspaces, service), service };
  }

  it("DELETE only for workspace managers, with the explicit confirmation", async () => {
    const member = controller(false);
    await expect(
      member.controller.remove("session", "lead_1", { confirmation: "EXCLUIR_LEAD" }),
    ).rejects.toMatchObject({ status: 403 });
    const manager = controller(true);
    await expect(manager.controller.remove("session", "lead_1", {})).rejects.toThrow("Confirmacao invalida");
    await expect(
      manager.controller.remove("session", "lead/../x", { confirmation: "EXCLUIR_LEAD" }),
    ).rejects.toThrow("Lead invalido");
    await manager.controller.remove("session", "lead_1", { confirmation: "EXCLUIR_LEAD" });
    expect(manager.service.deleteLead).toHaveBeenCalledWith(W, "lead_1", "user_1");
    expect(member.service.deleteLead).not.toHaveBeenCalled();
  });
});

describe("Excluir evento de teste (regra em observação)", () => {
  function observed(execution: { id: string; status: string } | null) {
    const calls: string[] = [];
    const tx: any = {
      providerConversionRuleExecution: {
        findFirst: vi.fn(async () =>
          execution ? { ...execution, providerRuleId: "rule_1" } : null,
        ),
        deleteMany: vi.fn(async ({ where }: any) => {
          calls.push(`execution.delete:${where.id}:${where.status}`);
          return { count: 1 };
        }),
      },
      providerPurchaseClaim: {
        deleteMany: vi.fn(async ({ where }: any) => {
          calls.push(`claim.delete:${where.effectMode}:${where.winnerExecutionId}`);
          return { count: 0 };
        }),
      },
      auditLog: {
        create: vi.fn(async () => {
          calls.push("auditLog.create");
        }),
      },
      conversionEventLog: { deleteMany: vi.fn() },
    };
    const prisma: any = { $transaction: vi.fn(async (fn: any) => fn(tx)) };
    return { service: new LeadsService(prisma, {} as any), tx, calls };
  }

  it("deletes only the observed execution (and its observation sale lock) and audits it", async () => {
    const h = observed({ id: "exec_1", status: "observed" });
    await expect(
      h.service.deleteObservedEvent(W, "lead_1", "exec_1", "manager"),
    ).resolves.toEqual({ executionId: "exec_1", deleted: true });
    expect(h.tx.providerConversionRuleExecution.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "exec_1", workspaceId: W, leadId: "lead_1" } }),
    );
    expect(h.calls).toEqual([
      "claim.delete:observation:exec_1",
      "execution.delete:exec_1:observed",
      "auditLog.create",
    ]);
    // Never touches the conversion logs (sent conversions stay).
    expect(h.tx.conversionEventLog.deleteMany).not.toHaveBeenCalled();
  });

  it.each(["eligible", "materialized", "blocked", "failed"])(
    "refuses (409) an execution %s: only test events leave",
    async (status) => {
      const h = observed({ id: "exec_1", status });
      await expect(
        h.service.deleteObservedEvent(W, "lead_1", "exec_1", "manager"),
      ).rejects.toMatchObject({ status: 409 });
      expect(h.calls).toEqual([]);
    },
  );

  it("404 for an execution of another lead or workspace", async () => {
    const h = observed(null);
    await expect(
      h.service.deleteObservedEvent(W, "lead_1", "exec_x", "manager"),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.calls).toEqual([]);
  });

  it("DELETE only for who manages the conversion rules", async () => {
    const service: any = { deleteObservedEvent: vi.fn(async () => ({ deleted: true })) };
    const auth: any = { getSession: vi.fn(async () => ({ user: { id: "user_1" } })) };
    const make = (canManageIntegrations: boolean) =>
      new LeadsController(
        auth,
        { getCurrentWorkspace: vi.fn(() => ({ id: W, permissions: { canManageIntegrations } })) } as any,
        service,
      );
    await expect(
      make(false).removeObservedEvent("session", "lead_1", "exec_1"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      make(true).removeObservedEvent("session", "lead_1", "exec/../x"),
    ).rejects.toThrow("Evento invalido");
    await make(true).removeObservedEvent("session", "lead_1", "exec_1");
    expect(service.deleteObservedEvent).toHaveBeenCalledTimes(1);
    expect(service.deleteObservedEvent).toHaveBeenCalledWith(W, "lead_1", "exec_1", "user_1");
  });
});
