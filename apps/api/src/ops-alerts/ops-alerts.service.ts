import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  workspaceOpsAlertSettingsSchema,
  type WorkspaceOpsAlertSettingsInput,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { OpsAlertNotifier } from "./ops-alert.notifier";

type ScanResult = { checked: number; notified: number; skipped: number };

@Injectable()
export class OpsAlertService {
  private readonly logger = new Logger(OpsAlertService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OpsAlertNotifier) private readonly notifier: OpsAlertNotifier,
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
    const settings = await this.prisma.workspaceOpsAlertSettings.findMany({
      where: { enabled: true, alertPhonesE164: { isEmpty: false } },
      include: { workspace: { select: { name: true } }, },
    });

    for (const setting of settings) {
      if (setting.alertPhonesE164.length === 0) continue;
      const instances = await this.prisma.whatsappInstance.findMany({
        where: { workspaceId: setting.workspaceId, status: "active", provider: "uazapi", providerTokenEncrypted: { not: null } },
        select: { id: true, name: true },
      });
      for (const instance of instances) {
        result.checked += 1;
        if (!setting.disconnectAlerts) {
          result.skipped += 1;
          await this.record(setting.workspaceId, `disconnect:${instance.id}`, "skipped", "disconnect_alert_disabled");
          continue;
        }
        // rastrackdash sanitize (rewrite_rules.ops-alerts-whatsapp-connections-stub):
        // WhatsappConnectionsService (billing-only instance marketplace) is
        // stripped in this edition. Re-wiring this check directly against
        // UazapiAdapter is a real feature change left for a follow-up slice
        // (F3.3/F4 TODO); skip rather than guess at the replacement call shape.
        result.skipped += 1;
        await this.record(setting.workspaceId, `disconnect:${instance.id}`, "skipped", "disconnect_status_check_unavailable");
      }

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
