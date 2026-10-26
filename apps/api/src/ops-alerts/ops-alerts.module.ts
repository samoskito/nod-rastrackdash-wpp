import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../common/prisma/prisma.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { LicenseClientModule } from "../licensing-client/license-client.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { OpsAlertNotifier } from "./ops-alert.notifier";
import { OpsAlertsController } from "./ops-alerts.controller";
import { OpsAlertService } from "./ops-alerts.service";
import { WhatsappDisconnectAlertsService } from "./whatsapp-disconnect-alerts.service";

// WhatsappDisconnectAlertsService (F5.7) only needs WhatsappProviderRegistry,
// which IntegrationsModule already re-exports (via WhatsappProvidersModule).
// Fase 6.1c: OpsAlertService also reads each Uazapi BYO/WAHA connection status
// (WhatsappConnectionsService, same re-export) and the installation license
// (nothing is sent while it is locked).
@Module({ imports: [AuthModule, PrismaModule, IntegrationsModule, WorkspacesModule, LicenseClientModule], controllers: [OpsAlertsController], providers: [OpsAlertNotifier, OpsAlertService, WhatsappDisconnectAlertsService], exports: [OpsAlertService] })
export class OpsAlertsModule {}
