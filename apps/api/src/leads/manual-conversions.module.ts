import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../common/prisma/prisma.module";
import { QueueModule } from "../common/queue/queue.module";
import { RuntimeModule } from "../common/runtime/runtime.module";
import { CrmModule } from "../crm/crm.module";
import { ConversionEventsModule } from "../conversion-events/conversion-events.module";
import { InboundWebhookMetaRouteReaderService } from "../inbound-webhooks/inbound-webhook-meta-route-reader.service";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { InboundWebhookPayloadEncryptionService } from "../inbound-webhooks/inbound-webhook-payload-encryption.service";
import { ManualConversionDispatchRecoveryService } from "./manual-conversion-dispatch-recovery.service";
import { ManualConversionService } from "./manual-conversion.service";
import { ManualConversionsController } from "./manual-conversions.controller";

/**
 * Manual lead conversion (tarefa 21). Its own module (not LeadsModule) so the
 * conversion/queue dependencies never create an import cycle with
 * the modules that import LeadsModule.
 */
@Module({
  imports: [
    AuthModule,
    ConversionEventsModule,
    CrmModule,
    PrismaModule,
    QueueModule,
    RuntimeModule,
    WorkspacesModule,
  ],
  controllers: [ManualConversionsController],
  providers: [
    ManualConversionService,
    ManualConversionDispatchRecoveryService,
    InboundWebhookMetaRouteReaderService,
    InboundWebhookPayloadEncryptionService,
  ],
  exports: [ManualConversionService],
})
export class ManualConversionsModule {}
