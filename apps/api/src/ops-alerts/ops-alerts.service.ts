import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import {
  workspaceOpsAlertSettingsSchema,
  type WorkspaceOpsAlertSettingsInput,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { WhatsappConnectionsService } from "../integrations/whatsapp-providers/whatsapp-connections.service";
import { LicenseClientService } from "../licensing-client/license-client.service";
import { OpsAlertNotifier } from "./ops-alert.notifier";
import {
  CONNECTED_OBSERVED_DETAIL,
  classifyDisconnectReading,
  DISCONNECT_ALERT_PROVIDERS,
  DISCONNECT_CONFIRMATIONS,
  DISCONNECT_CONFIRMED_DETAIL,
  DISCONNECT_OBSERVED_DETAIL,
  disconnectAlertKey,
  disconnectStreakFromDetail,
  isConfirmedDisconnectDetail,
} from "./instance-disconnect-streak";

type ScanResult = { checked: number; notified: number; skipped: number };

type AlertSetting = {
  workspaceId: string;
  enabled: boolean;
  alertPhonesE164: string[];
  disconnectAlerts: boolean;
  debounceHours: number;
  workspace: { name: string };
};

@Injectable()
export class OpsAlertService {
  private readonly logger = new Logger(OpsAlertService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OpsAlertNotifier) private readonly notifier: OpsAlertNotifier,
    @Optional()
    @Inject(WhatsappConnectionsService)
    private readonly whatsappConnections?: WhatsappConnectionsService,
    @Optional()
    @Inject(LicenseClientService)
    private readonly license?: LicenseClientService,
  ) {}

  async getSettings(workspaceId: string) {
    const settings = await this.prisma.workspaceOpsAlertSettings.findUnique({
      where: { workspaceId },
    });
    return this.toSettingsResponse(workspaceId, settings);
  }

  async upsertSettings(workspaceId: string, input: WorkspaceOpsAlertSettingsInput, _actorUserId: string) {
    const alertPhonesE164 = [...new Set(input.alertPhones.map((phone) => phone.replace(/\D/g, "")).filter(Boolean))].slice(0, 10);
    const alertPhoneE164 = alertPhonesE164[0] ?? null;
    const settings = await this.prisma.workspaceOpsAlertSettings.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        enabled: input.enabled,
        alertPhonesE164,
        alertPhoneE164,
        disconnectAlerts: input.disconnectAlerts,
        webhookSilenceAlerts: input.webhookSilenceAlerts,
        silenceThresholdHours: input.silenceThresholdHours,
        debounceHours: input.debounceHours,
      },
      update: {
        enabled: input.enabled,
        alertPhonesE164,
        alertPhoneE164,
        disconnectAlerts: input.disconnectAlerts,
        webhookSilenceAlerts: input.webhookSilenceAlerts,
        silenceThresholdHours: input.silenceThresholdHours,
        debounceHours: input.debounceHours,
      },
    });
    return this.toSettingsResponse(workspaceId, settings);
  }

  private toSettingsResponse(
    workspaceId: string,
    settings: {
      id: string;
      workspaceId: string;
      enabled: boolean;
      alertPhonesE164: string[];
      alertPhoneE164: string | null;
      disconnectAlerts: boolean;
      webhookSilenceAlerts: boolean;
      silenceThresholdHours: number;
      debounceHours: number;
      createdAt: Date;
      updatedAt: Date;
    } | null,
  ) {
    return workspaceOpsAlertSettingsSchema.parse(
      settings
        ? {
            ...settings,
            alertPhoneE164: settings.alertPhonesE164[0] ?? null,
            createdAt: settings.createdAt.toISOString(),
            updatedAt: settings.updatedAt.toISOString(),
          }
        : {
            id: null,
            workspaceId,
            enabled: false,
            alertPhonesE164: [],
            alertPhoneE164: null,
            disconnectAlerts: true,
            webhookSilenceAlerts: true,
            silenceThresholdHours: 24,
            debounceHours: 6,
            createdAt: null,
            updatedAt: null,
          },
    );
  }

  async runScan(now = new Date()): Promise<ScanResult> {
    const result: ScanResult = { checked: 0, notified: 0, skipped: 0 };
    await this.scanInstanceDisconnects(result, now);
    const settings = await this.prisma.workspaceOpsAlertSettings.findMany({
      where: { enabled: true, alertPhonesE164: { isEmpty: false } },
      include: { workspace: { select: { name: true } }, },
    });

    for (const setting of settings) {
      if (setting.alertPhonesE164.length === 0) continue;
      const connections = await this.prisma.inboundWebhookConnection.findMany({
        where: { workspaceId: setting.workspaceId, removedAt: null, status: { in: ["production", "observation"] } },
        select: { id: true, displayName: true, status: true, createdAt: true, lastDeliveryAt: true },
      });
      for (const connection of connections) {
        result.checked += 1;
        const lastAt = connection.lastDeliveryAt;
        const thresholdAt = new Date(now.getTime() - setting.silenceThresholdHours * 3_600_000);
        const isSilent = lastAt ? lastAt < thresholdAt : connection.createdAt < thresholdAt;
        // Observation connections are relevant only after receiving at least one webhook.
        if (!isSilent || (connection.status === "observation" && !lastAt)) continue;
        if (!setting.webhookSilenceAlerts) {
          result.skipped += 1;
          await this.record(setting.workspaceId, `silence:${connection.id}`, "skipped", "silence_alert_disabled");
          continue;
        }
        const reference = lastAt ?? connection.createdAt;
        const hours = Math.max(1, Math.floor((now.getTime() - reference.getTime()) / 3_600_000));
        await this.notify(setting, `silence:${connection.id}`, `[WppTrack] Sem webhook ha ${hours}h no workspace "${setting.workspace.name}" (conexão "${connection.displayName}"). Verifique o provedor.`, result, now);
      }
    }
    return result;
  }

  /**
   * Fase 6.1c (porte do SaaS #63): confere o status de cada conexão Uazapi
   * BYO e WAHA ativa pela API de status do próprio provedor (URL do servidor
   * + token do aluno). O alerta só vale depois de DISCONNECT_CONFIRMATIONS
   * leituras seguidas de "desconectado"; ele aparece na tela de Integrações
   * mesmo sem telefone de alerta. A mensagem no WhatsApp só sai com os
   * alertas ligados no workspace, telefone cadastrado e licença utilizável.
   */
  private async scanInstanceDisconnects(
    result: ScanResult,
    now: Date,
  ): Promise<void> {
    if (!this.whatsappConnections) return;
    const instances = await this.prisma.whatsappInstance.findMany({
      where: {
        status: "active",
        provider: { in: [...DISCONNECT_ALERT_PROVIDERS] },
        configEncrypted: { not: null },
        workspace: { operationalStatus: "active" },
      },
      select: {
        id: true,
        name: true,
        displayName: true,
        workspaceId: true,
      },
      orderBy: [{ workspaceId: "asc" }, { id: "asc" }],
    });
    if (instances.length === 0) return;
    const settings = new Map<string, AlertSetting>(
      (
        await this.prisma.workspaceOpsAlertSettings.findMany({
          where: {
            workspaceId: {
              in: [...new Set(instances.map((item) => item.workspaceId))],
            },
          },
          include: { workspace: { select: { name: true } } },
        })
      ).map((setting) => [setting.workspaceId, setting]),
    );
    let licenseLocked: boolean | null = null;

    for (const instance of instances) {
      result.checked += 1;
      const alertKey = disconnectAlertKey(instance.id);
      let reading: {
        provider: string;
        status: string;
        providerStatus: string | null;
      };
      try {
        reading = await this.whatsappConnections.readConnectionStatusForAlert(
          instance.workspaceId,
          instance.id,
        );
      } catch {
        // Erro ao ler o status não é prova de desconexão: nunca alerta.
        this.logger.warn(
          `ops_alert_disconnect_status_failed workspace=${instance.workspaceId} instance=${instance.id}`,
        );
        continue;
      }
      const observation = classifyDisconnectReading(reading);
      const last = await this.lastDelivery(instance.workspaceId, alertKey);
      if (observation === "connected") {
        if (disconnectStreakFromDetail(last?.detail) > 0) {
          await this.record(
            instance.workspaceId,
            alertKey,
            "skipped",
            CONNECTED_OBSERVED_DETAIL,
          );
        }
        continue;
      }
      // Estados passageiros ou desconhecidos não alertam e não quebram a
      // sequência de leituras de desconectado.
      if (observation === "ambiguous") continue;

      const streak = disconnectStreakFromDetail(last?.detail) + 1;
      if (streak < DISCONNECT_CONFIRMATIONS) {
        result.skipped += 1;
        await this.record(
          instance.workspaceId,
          alertKey,
          "skipped",
          `${DISCONNECT_OBSERVED_DETAIL}${streak}`,
        );
        continue;
      }

      const setting = settings.get(instance.workspaceId);
      let blockedReason: string | null = null;
      if (
        !setting?.enabled ||
        setting.alertPhonesE164.length === 0 ||
        !setting.disconnectAlerts
      ) {
        blockedReason = "notify_disabled";
      } else {
        licenseLocked ??= await this.licenseLocked();
        if (licenseLocked) blockedReason = "license_locked";
      }
      if (blockedReason !== null || !setting) {
        result.skipped += 1;
        // Já confirmado e sem envio: uma linha basta para a tela.
        if (!isConfirmedDisconnectDetail(last?.detail)) {
          await this.record(
            instance.workspaceId,
            alertKey,
            "skipped",
            `${DISCONNECT_CONFIRMED_DETAIL}${streak} ${blockedReason ?? "notify_disabled"}`,
          );
        }
        continue;
      }
      const label = instance.displayName?.trim() || instance.name;
      await this.notify(
        setting,
        alertKey,
        `[WppTrack] WhatsApp desconectado no workspace "${setting.workspace.name}" (conexão "${label}"). Reconecte no painel do seu provedor e confira em Integrações.`,
        result,
        now,
      );
    }
  }

  private async lastDelivery(workspaceId: string, alertKey: string) {
    return this.prisma.workspaceOpsAlertDelivery.findFirst({
      where: { workspaceId, alertKey },
      orderBy: { createdAt: "desc" },
      select: { detail: true, createdAt: true },
    });
  }

  /** Licença bloqueada, desconhecida ou sem cliente de licença: nada é enviado. */
  private async licenseLocked(): Promise<boolean> {
    if (!this.license) return true;
    try {
      return (await this.license.getLockState()).locked;
    } catch {
      return true;
    }
  }

  private async notify(setting: { workspaceId: string; alertPhonesE164: string[]; debounceHours: number }, alertKey: string, message: string, result: ScanResult, now: Date) {
    const after = new Date(now.getTime() - setting.debounceHours * 3_600_000);
    const recent = await this.prisma.workspaceOpsAlertDelivery.findFirst({
      where: { workspaceId: setting.workspaceId, alertKey, status: "sent", createdAt: { gte: after } },
      orderBy: { createdAt: "desc" },
    });
    if (recent) {
      result.skipped += 1;
      await this.record(setting.workspaceId, alertKey, "skipped", "debounced");
      return;
    }
    const outcomes = await Promise.all(
      setting.alertPhonesE164.map(async (phone) => {
        try {
          return await this.notifier.sendText(phone, message);
        } catch {
          return false;
        }
      }),
    );
    const sent = outcomes.filter(Boolean).length;
    const failed = outcomes.length - sent;
    await this.record(
      setting.workspaceId,
      alertKey,
      sent > 0 ? "sent" : "failed",
      `sent=${sent} failed=${failed}`,
    );
    if (sent > 0) result.notified += 1;
    else result.skipped += 1;
  }

  private async record(workspaceId: string, alertKey: string, status: "sent" | "skipped" | "failed", detail: string | null) {
    try {
      await this.prisma.workspaceOpsAlertDelivery.create({ data: { workspaceId, alertKey, channel: "whatsapp", status, detail } });
    } catch {
      this.logger.warn(`ops_alert_delivery_record_failed workspace=${workspaceId}`);
    }
  }
}
