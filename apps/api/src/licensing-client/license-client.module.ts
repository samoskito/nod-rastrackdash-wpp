import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { LICENSE_HEARTBEAT_QUEUE } from "./license-client.constants";
import { LicenseClientService } from "./license-client.service";
import { LicenseHeartbeatProcessor } from "./license-heartbeat.processor";
import { LicenseHeartbeatScheduler } from "./license-heartbeat.scheduler";

/**
 * F4.1 backend core: the license *client* only. No admin endpoints, no
 * server logic — see .claude-task-f4-1-license-client.md. UI/global guard
 * land in a later slice (F4.2+).
 */
@Module({
  imports: [PrismaModule, BullModule.registerQueue({ name: LICENSE_HEARTBEAT_QUEUE })],
  providers: [LicenseClientService, LicenseHeartbeatProcessor, LicenseHeartbeatScheduler],
  exports: [LicenseClientService],
})
export class LicenseClientModule {}
