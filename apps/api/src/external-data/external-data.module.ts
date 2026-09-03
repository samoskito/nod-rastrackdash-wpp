import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../common/prisma/prisma.module";
import { EXTERNAL_DATA_SYNC_QUEUE } from "../common/queue/queue.constants";
import { QueueModule } from "../common/queue/queue.module";
import { ConversionEventsModule } from "../conversion-events/conversion-events.module";
import { LeadsModule } from "../leads/leads.module";
import { ExternalAutoSyncService } from "./external-auto-sync.service";
import { ExternalCredentialEncryptionService } from "./external-credential-encryption.service";
import { BackofficeExternalDataController } from "./backoffice-external-data.controller";
import { ExternalConnectorEgressPolicyService } from "./external-connector-egress-policy.service";
import { ExternalDataService } from "./external-data.service";
import { ExternalEventIngestionService } from "./external-event-ingestion.service";
import { ExternalMysqlAdapter } from "./external-mysql.adapter";
import { ExternalSyncQueueService } from "./external-sync-queue.service";
import { ExternalSyncProcessor } from "./external-sync.processor";
import { ExternalSyncService } from "./external-sync.service";

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    QueueModule,
    ConversionEventsModule,
    LeadsModule,
    BullModule.registerQueue({ name: EXTERNAL_DATA_SYNC_QUEUE }),
  ],
  controllers: [BackofficeExternalDataController],
  providers: [
    ExternalCredentialEncryptionService,
    ExternalConnectorEgressPolicyService,
    ExternalMysqlAdapter,
    ExternalEventIngestionService,
    ExternalSyncService,
    ExternalSyncQueueService,
    ExternalSyncProcessor,
    ExternalAutoSyncService,
    ExternalDataService,
  ],
  exports: [ExternalDataService, ExternalSyncQueueService],
})
export class ExternalDataModule {}
