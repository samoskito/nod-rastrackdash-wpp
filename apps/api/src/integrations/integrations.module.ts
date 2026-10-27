import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../common/prisma/prisma.module";
import { InboundWebhooksModule } from "../inbound-webhooks/inbound-webhooks.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { INTEGRATION_ENV } from "./integration.types";
import { IntegrationsController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";
import { MetaAdDestinationRoutingService } from "./meta/meta-ad-destination-routing.service";
import { MetaAdapter } from "./meta/meta.adapter";
import { MetaGraphUsageMonitor } from "./meta/meta-graph-usage";
import { MetaAssetsService } from "./meta/meta-assets.service";
import { MetaConnectionResolverService } from "./meta/meta-connection-resolver.service";
import { MetaConnectionsService } from "./meta/meta-connections.service";
import { MetaCreativeThumbnailService } from "./meta/meta-creative-thumbnail.service";
import { MetaManualConnectionsService } from "./meta/meta-manual-connections.service";
import { MetaPalmupConnectService } from "./meta/meta-palmup-connect.service";
import { MetaPalmupPairingStore } from "./meta/meta-palmup-pairing.store";
import { MetaTokenEncryptionService } from "./meta/meta-token-encryption.service";
import { WhatsappProvidersModule } from "./whatsapp-providers/whatsapp-providers.module";

export { INTEGRATION_ENV } from "./integration.types";

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    InboundWebhooksModule,
    WorkspacesModule,
    WhatsappProvidersModule,
  ],
  providers: [
    {
      provide: INTEGRATION_ENV,
      useValue: process.env,
    },
    MetaAdDestinationRoutingService,
    MetaAdapter,
    MetaGraphUsageMonitor,
    MetaAssetsService,
    MetaConnectionResolverService,
    MetaTokenEncryptionService,
    MetaConnectionsService,
    MetaCreativeThumbnailService,
    MetaManualConnectionsService,
    MetaPalmupConnectService,
    MetaPalmupPairingStore,
    IntegrationsService,
  ],
  controllers: [IntegrationsController],
  exports: [
    MetaAdDestinationRoutingService,
    MetaAdapter,
    MetaGraphUsageMonitor,
    MetaAssetsService,
    MetaConnectionResolverService,
    MetaTokenEncryptionService,
    MetaConnectionsService,
    MetaCreativeThumbnailService,
    MetaManualConnectionsService,
    IntegrationsService,
    WhatsappProvidersModule,
  ],
})
export class IntegrationsModule {}
