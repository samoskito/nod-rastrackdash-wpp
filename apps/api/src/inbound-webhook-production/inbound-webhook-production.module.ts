import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../common/prisma/prisma.module";
import { INBOUND_WEBHOOK_PRODUCTION_QUEUE } from "../common/queue/queue.constants";
import { QueueModule } from "../common/queue/queue.module";
import { RuntimeModule } from "../common/runtime/runtime.module";
import { ConversionEventsModule } from "../conversion-events/conversion-events.module";
import { ConversionRulesModule } from "../conversion-rules/conversion-rules.module";
import { InboundWebhooksModule } from "../inbound-webhooks/inbound-webhooks.module";
import { LeadsModule } from "../leads/leads.module";
import { LicenseClientModule } from "../licensing-client/license-client.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { InboundWebhookProductionProcessor } from "./inbound-webhook-production.processor";
import { InboundWebhookProductionService } from "./inbound-webhook-production.service";
import { ProviderConversionProductionService } from "./provider-conversion-production.service";
import { PurchaseReviewsController } from "./purchase-reviews.controller";
import { PurchaseReviewsService } from "./purchase-reviews.service";

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    RuntimeModule,
    QueueModule,
    LeadsModule,
    LicenseClientModule,
    ConversionEventsModule,
    ConversionRulesModule,
    InboundWebhooksModule,
    WorkspacesModule,
    BullModule.registerQueue({
      name: INBOUND_WEBHOOK_PRODUCTION_QUEUE,
    }),
  ],
  providers: [
    InboundWebhookProductionProcessor,
    InboundWebhookProductionService,
    ProviderConversionProductionService,
    PurchaseReviewsService,
  ],
  controllers: [PurchaseReviewsController],
})
export class InboundWebhookProductionModule {}
