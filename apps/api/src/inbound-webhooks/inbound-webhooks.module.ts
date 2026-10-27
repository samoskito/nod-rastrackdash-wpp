import { BullModule } from "@nestjs/bullmq";
import { forwardRef, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../common/prisma/prisma.module";
import {
  INBOUND_WEBHOOK_PRODUCTION_QUEUE,
  INBOUND_WEBHOOK_QUEUE,
} from "../common/queue/queue.constants";
import { RuntimeModule } from "../common/runtime/runtime.module";
import { ConversionRulesModule } from "../conversion-rules/conversion-rules.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { InboundWebhookChannelRoutesService } from "./inbound-webhook-channel-routes.service";
import { InboundConversionAutomationIngestionService } from "./inbound-conversion-automation-ingestion.service";
import { InboundWebhookConnectionsController } from "./inbound-webhook-connections.controller";
import { InboundWebhookConnectionsService } from "./inbound-webhook-connections.service";
import { IntegrationEndpointsController } from "./integration-endpoints.controller";
import { IntegrationEndpointsService } from "./integration-endpoints.service";
import { InboundWebhookDiagnosticsService } from "./inbound-webhook-diagnostics.service";
import { InboundWebhookIngestionService } from "./inbound-webhook-ingestion.service";
import { InboundWebhookMaintenanceService } from "./inbound-webhook-maintenance.service";
import { InboundWebhookMetaCloudVerificationService } from "./inbound-webhook-meta-cloud-verification.service";
import { InboundWebhookMetaRouteReaderService } from "./inbound-webhook-meta-route-reader.service";
import { InboundWebhookObservationService } from "./inbound-webhook-observation.service";
import { InboundWebhookPayloadEncryptionService } from "./inbound-webhook-payload-encryption.service";
import { InboundWebhookProductionIntakeService } from "./inbound-webhook-production-intake.service";
import { InboundWebhookProductionQueueService } from "./inbound-webhook-production-queue.service";
import { InboundWebhookProcessor } from "./inbound-webhook.processor";
import { InboundWebhookPublicController } from "./inbound-webhook-public.controller";
import { InboundWebhookQueueService } from "./inbound-webhook-queue.service";
import { MetaCloudWabaSubscriptionController } from "./meta-cloud-waba-subscription.controller";
import { MetaCloudWabaRateLimiter } from "./meta-cloud-waba-rate-limiter";
import { MetaCloudWabaSubscriptionService } from "./meta-cloud-waba-subscription.service";
import { ProviderRuleBlockedReprocessController } from "./provider-rule-blocked-reprocess.controller";
import { ProviderRuleBlockedReprocessService } from "./provider-rule-blocked-reprocess.service";
import { InboundWebhookParserRegistry } from "./providers/inbound-webhook-parser.registry";
import { RoichatPurchaseIngressService } from "./roichat-purchase-ingress.service";
import { ROICHAT_PURCHASE_INGRESS } from "./roichat-purchase-ingress.token";
import { UazapiConversionBridgeService } from "./uazapi-conversion-bridge.service";
import { UazapiProviderConversionService } from "./uazapi-provider-conversion.service";
import { MetaTokenEncryptionService } from "../integrations/meta/meta-token-encryption.service";
import { INTEGRATION_ENV } from "../integrations/integration.types";
import { BackofficeIntegrationEventsController } from "./backoffice-integration-events.controller";
import { BackofficeParserReleasesController } from "./backoffice-parser-releases.controller";
import { BackofficeIntegrationEventsService } from "./backoffice-integration-events.service";
import { WhatsappProvidersModule } from "../integrations/whatsapp-providers/whatsapp-providers.module";

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    RuntimeModule,
    ConversionRulesModule,
    WorkspacesModule,
    forwardRef(() => WhatsappProvidersModule),
    BullModule.registerQueue({
      name: INBOUND_WEBHOOK_QUEUE,
    }),
    BullModule.registerQueue({
      name: INBOUND_WEBHOOK_PRODUCTION_QUEUE,
    }),
  ],
  controllers: [
    BackofficeIntegrationEventsController,
    BackofficeParserReleasesController,
    InboundWebhookConnectionsController,
    InboundWebhookPublicController,
    IntegrationEndpointsController,
    MetaCloudWabaSubscriptionController,
    ProviderRuleBlockedReprocessController,
  ],
  providers: [
    BackofficeIntegrationEventsService,
    InboundConversionAutomationIngestionService,
    InboundWebhookChannelRoutesService,
    InboundWebhookConnectionsService,
    InboundWebhookDiagnosticsService,
    InboundWebhookIngestionService,
    InboundWebhookMaintenanceService,
    InboundWebhookMetaCloudVerificationService,
    InboundWebhookMetaRouteReaderService,
    InboundWebhookObservationService,
    InboundWebhookPayloadEncryptionService,
    InboundWebhookProductionIntakeService,
    InboundWebhookProductionQueueService,
    InboundWebhookProcessor,
    InboundWebhookQueueService,
    InboundWebhookParserRegistry,
    IntegrationEndpointsService,
    MetaCloudWabaRateLimiter,
    MetaCloudWabaSubscriptionService,
    ProviderRuleBlockedReprocessService,
    // Fase 6.8: the ROI Chat purchase received on the number URL.
    RoichatPurchaseIngressService,
    {
      provide: ROICHAT_PURCHASE_INGRESS,
      useExisting: RoichatPurchaseIngressService,
    },
    UazapiConversionBridgeService,
    UazapiProviderConversionService,
    MetaTokenEncryptionService,
    { provide: INTEGRATION_ENV, useValue: process.env },
  ],
  exports: [
    InboundWebhookChannelRoutesService,
    InboundWebhookConnectionsService,
    InboundWebhookMetaRouteReaderService,
    InboundWebhookPayloadEncryptionService,
    InboundWebhookProductionIntakeService,
    InboundWebhookProductionQueueService,
    InboundWebhookParserRegistry,
    UazapiConversionBridgeService,
    UazapiProviderConversionService,
  ],
})
export class InboundWebhooksModule {}
