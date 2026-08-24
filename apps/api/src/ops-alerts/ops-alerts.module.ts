import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../common/prisma/prisma.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { OpsAlertNotifier } from "./ops-alert.notifier";
import { OpsAlertsController } from "./ops-alerts.controller";
import { OpsAlertService } from "./ops-alerts.service";
import { WhatsappDisconnectAlertsService } from "./whatsapp-disconnect-alerts.service";

// WhatsappDisconnectAlertsService (F5.7) only needs WhatsappProviderRegistry,
// which IntegrationsModule already re-exports (via WhatsappProvidersModule)
// — no extra import required here.
@Module({ imports: [AuthModule, PrismaModule, IntegrationsModule, WorkspacesModule], controllers: [OpsAlertsController], providers: [OpsAlertNotifier, OpsAlertService, WhatsappDisconnectAlertsService], exports: [OpsAlertService] })
export class OpsAlertsModule {}
