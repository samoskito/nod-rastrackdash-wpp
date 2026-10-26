import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { OpsAlertService } from "../../src/ops-alerts/ops-alerts.service";
import {
  classifyDisconnectReading,
  disconnectStreakFromDetail,
  readDisconnectAlertStates,
} from "../../src/ops-alerts/instance-disconnect-streak";

/**
 * Fase 6.1c — alerta de desconexão do WhatsApp por conexão (porte do SaaS #63,
 * 86aaac21) para a Uazapi BYO e a WAHA do aluno. Só alerta depois de 2
 * leituras seguidas de "desconectado"; ambíguo não conta nem quebra a
 * sequência; "conectado" zera; erro de leitura nunca alerta. Dados fictícios.
 */

type Row = Record<string, any>;
type Reading = { status: string; providerStatus: string | null } | Error;

function world(input: {
  provider?: "uazapi_byo" | "waha";
  readings: Reading[];
  settings?: Row | null;
  locked?: boolean;
  instances?: number;
}) {
  const deliveries: Row[] = [];
  let tick = 0;
  const provider = input.provider ?? "waha";
  const instances = Array.from({ length: input.instances ?? 1 }, (_, index) => ({
    id: `instance_${index + 1}`,
    name: `Loja ${index + 1}`,
    displayName: null,
    workspaceId: "workspace_1",
    provider,
  }));
  const settings =
    input.settings === null
      ? []
      : [
          {
            workspaceId: "workspace_1",
            enabled: true,
            alertPhonesE164: ["5511999990000"],
            disconnectAlerts: true,
            webhookSilenceAlerts: false,
            silenceThresholdHours: 24,
            debounceHours: 6,
            workspace: { name: "Cliente Fictício" },
            ...(input.settings ?? {}),
          },
        ];
  const latest = (where: Row) =>
    [...deliveries]
      .reverse()
      .find(
        (row) =>
          row.workspaceId === where.workspaceId &&
          row.alertKey === where.alertKey &&
          (where.status === undefined || row.status === where.status) &&
          (where.detail === undefined || row.detail === where.detail) &&
          (where.createdAt?.gte === undefined ||
            row.createdAt >= where.createdAt.gte),
      ) ?? null;
  const prisma = {
    whatsappInstance: { findMany: vi.fn(async () => instances) },
    workspaceOpsAlertSettings: {
      findMany: vi.fn(async ({ where }: Row) =>
        where?.enabled ? settings.filter((s) => s.enabled) : settings,
      ),
    },
    workspaceOpsAlertDelivery: {
      findFirst: vi.fn(async ({ where }: Row) => latest(where)),
      create: vi.fn(async ({ data }: Row) => {
        const row = {
          ...data,
          createdAt: new Date(Date.UTC(2026, 9, 26, 12, 0, tick++)),
        };
        deliveries.push(row);
        return row;
      }),
    },
    inboundWebhookConnection: { findMany: vi.fn(async () => []) },
  };
  const readings = [...input.readings];
  const connections = {
    readConnectionStatusForAlert: vi.fn(async () => {
      const next = readings.shift();
      if (!next) throw new Error("sem leitura");
      if (next instanceof Error) throw next;
      return { provider, ...next };
    }),
  };
  const notifier = { sendText: vi.fn(async () => true) };
  const license = {
    getLockState: vi.fn(async () => ({ locked: Boolean(input.locked) })),
  };
  const service = new OpsAlertService(
    prisma as never,
    notifier as never,
    connections as never,
    license as never,
  );
  return { service, prisma, deliveries, notifier, connections, license };
}

const scanAt = new Date(Date.UTC(2026, 9, 26, 12, 5, 0));
const disconnectedWaha = { status: "disconnected", providerStatus: "STOPPED" };
const connectedWaha = { status: "connected", providerStatus: "WORKING" };
const startingWaha = { status: "needs_reconnect", providerStatus: "STARTING" };

describe("classificação das leituras de status", () => {
  it("Uazapi: só sessão encerrada conta; hibernada, offline e pendente são ambíguas", () => {
    for (const raw of ["disconnected", "closed", "logged_out", "loggedout"]) {
      expect(
        classifyDisconnectReading({
          provider: "uazapi_byo",
          status: "disconnected",
          providerStatus: raw,
        }),
      ).toBe("disconnected");
    }
    for (const raw of ["hibernated", "offline", null]) {
      expect(
        classifyDisconnectReading({
          provider: "uazapi_byo",
          status: "disconnected",
          providerStatus: raw,
        }),
      ).toBe("ambiguous");
    }
    for (const status of ["needs_reconnect", "syncing", "error"]) {
      expect(
        classifyDisconnectReading({
          provider: "uazapi_byo",
          status,
          providerStatus: "connecting",
        }),
      ).toBe("ambiguous");
    }
    expect(
      classifyDisconnectReading({
        provider: "uazapi_byo",
        status: "connected",
        providerStatus: "open",
      }),
    ).toBe("connected");
  });

  it("WAHA: sessão parada ou esperando novo pareamento conta; subindo e falha são ambíguas", () => {
    expect(classifyDisconnectReading({ provider: "waha", ...disconnectedWaha })).toBe(
      "disconnected",
    );
    expect(
      classifyDisconnectReading({
        provider: "waha",
        status: "needs_reconnect",
        providerStatus: "PAIRING_REQUIRED",
      }),
    ).toBe("disconnected");
    expect(classifyDisconnectReading({ provider: "waha", ...startingWaha })).toBe(
      "ambiguous",
    );
    expect(
      classifyDisconnectReading({
        provider: "waha",
        status: "error",
        providerStatus: "FAILED",
      }),
    ).toBe("ambiguous");
    expect(
      classifyDisconnectReading({
        provider: "waha",
        status: "needs_reconnect",
        providerStatus: null,
      }),
    ).toBe("ambiguous");
    expect(classifyDisconnectReading({ provider: "waha", ...connectedWaha })).toBe(
      "connected",
    );
  });

  it("a sequência confirmada fica confirmada (a tela não esquece o alerta)", () => {
    expect(disconnectStreakFromDetail("disconnect_observed streak=1")).toBe(1);
    expect(disconnectStreakFromDetail("sent=1 failed=0")).toBe(2);
    expect(disconnectStreakFromDetail("debounced")).toBe(2);
    expect(
      disconnectStreakFromDetail("disconnect_confirmed streak=3 notify_disabled"),
    ).toBe(3);
    expect(disconnectStreakFromDetail("connected_observed")).toBe(0);
    expect(disconnectStreakFromDetail(null)).toBe(0);
  });
});

describe("alerta de desconexão por conexão (2 leituras seguidas)", () => {
  it("WAHA desconectada duas vezes alerta uma vez", async () => {
    const w = world({ readings: [disconnectedWaha, disconnectedWaha] });
    await w.service.runScan(scanAt);
    expect(w.notifier.sendText).not.toHaveBeenCalled();
    expect(w.deliveries.at(-1)).toMatchObject({
      alertKey: "disconnect:instance_1",
      detail: "disconnect_observed streak=1",
    });
    await w.service.runScan(scanAt);
    expect(w.notifier.sendText).toHaveBeenCalledTimes(1);
    expect(w.notifier.sendText).toHaveBeenCalledWith(
      "5511999990000",
      expect.stringContaining("WhatsApp desconectado"),
    );
    expect(w.deliveries.at(-1)).toMatchObject({ status: "sent" });
  });

  it("uma leitura isolada de desconectado não alerta", async () => {
    const w = world({ readings: [disconnectedWaha, connectedWaha] });
    await w.service.runScan(scanAt);
    await w.service.runScan(scanAt);
    expect(w.notifier.sendText).not.toHaveBeenCalled();
    expect(w.deliveries.at(-1)).toMatchObject({ detail: "connected_observed" });
  });

  it("uma leitura ambígua não alerta nem quebra a sequência", async () => {
    const w = world({
      readings: [disconnectedWaha, startingWaha, disconnectedWaha],
    });
    await w.service.runScan(scanAt);
    await w.service.runScan(scanAt);
    expect(w.notifier.sendText).not.toHaveBeenCalled();
    await w.service.runScan(scanAt);
    expect(w.notifier.sendText).toHaveBeenCalledTimes(1);
  });

  it("só ambíguas nunca alertam", async () => {
    const w = world({ readings: [startingWaha, startingWaha, startingWaha] });
    for (let index = 0; index < 3; index += 1) await w.service.runScan(scanAt);
    expect(w.notifier.sendText).not.toHaveBeenCalled();
    expect(w.deliveries).toHaveLength(0);
  });

  it("erro ao ler o status nunca alerta e não conta", async () => {
    const w = world({
      readings: [disconnectedWaha, new Error("timeout"), disconnectedWaha],
    });
    await w.service.runScan(scanAt);
    await w.service.runScan(scanAt);
    expect(w.notifier.sendText).not.toHaveBeenCalled();
    await w.service.runScan(scanAt);
    expect(w.notifier.sendText).toHaveBeenCalledTimes(1);
  });

  it("depois do alerta, o intervalo de repetição segura novas mensagens", async () => {
    const w = world({
      readings: [disconnectedWaha, disconnectedWaha, disconnectedWaha],
    });
    for (let index = 0; index < 3; index += 1) await w.service.runScan(scanAt);
    expect(w.notifier.sendText).toHaveBeenCalledTimes(1);
    expect(w.deliveries.at(-1)).toMatchObject({ detail: "debounced" });
  });

  it("Uazapi BYO segue a mesma regra pela API de status dela", async () => {
    const off = { status: "disconnected", providerStatus: "logged_out" };
    const w = world({ provider: "uazapi_byo", readings: [off, off] });
    await w.service.runScan(scanAt);
    await w.service.runScan(scanAt);
    expect(w.notifier.sendText).toHaveBeenCalledTimes(1);
  });

  it("com a licença bloqueada nada é enviado, mas o alerta fica na tela", async () => {
    const w = world({
      readings: [disconnectedWaha, disconnectedWaha, disconnectedWaha],
      locked: true,
    });
    for (let index = 0; index < 3; index += 1) await w.service.runScan(scanAt);
    expect(w.notifier.sendText).not.toHaveBeenCalled();
    const confirmed = w.deliveries.filter((row) =>
      String(row.detail).startsWith("disconnect_confirmed"),
    );
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({
      detail: "disconnect_confirmed streak=2 license_locked",
    });
    const states = await readDisconnectAlertStates(
      w.prisma as never,
      "workspace_1",
      ["instance_1"],
    );
    expect(states.get("instance_1")).toMatchObject({
      confirmedAt: confirmed[0]!.createdAt.toISOString(),
    });
  });

  it("sem telefone de alerta configurado, não envia nada e o alerta aparece na tela", async () => {
    const w = world({
      readings: [disconnectedWaha, disconnectedWaha],
      settings: null,
    });
    await w.service.runScan(scanAt);
    await w.service.runScan(scanAt);
    expect(w.notifier.sendText).not.toHaveBeenCalled();
    expect(w.license.getLockState).not.toHaveBeenCalled();
    const states = await readDisconnectAlertStates(
      w.prisma as never,
      "workspace_1",
      ["instance_1"],
    );
    expect(states.has("instance_1")).toBe(true);
  });

  it("uma leitura conectada tira o alerta da tela", async () => {
    const w = world({
      readings: [disconnectedWaha, disconnectedWaha, connectedWaha],
      settings: null,
    });
    await w.service.runScan(scanAt);
    await w.service.runScan(scanAt);
    await w.service.runScan(scanAt);
    const states = await readDisconnectAlertStates(
      w.prisma as never,
      "workspace_1",
      ["instance_1"],
    );
    expect(states.has("instance_1")).toBe(false);
  });

  it("cada conexão tem a própria sequência", async () => {
    const w = world({
      instances: 2,
      readings: [
        disconnectedWaha,
        connectedWaha,
        disconnectedWaha,
        connectedWaha,
      ],
    });
    await w.service.runScan(scanAt);
    await w.service.runScan(scanAt);
    expect(w.notifier.sendText).toHaveBeenCalledTimes(1);
    expect(w.notifier.sendText).toHaveBeenCalledWith(
      "5511999990000",
      expect.stringContaining('conexão "Loja 1"'),
    );
  });
});
