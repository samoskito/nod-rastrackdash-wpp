import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { PrismaModule } from "../common/prisma/prisma.module";
import { LicenseClientStatusController } from "./license-client-status.controller";
import { LICENSE_HEARTBEAT_QUEUE } from "./license-client.constants";
import { LicenseClientService } from "./license-client.service";
import { LicenseHeartbeatProcessor } from "./license-heartbeat.processor";
import { LicenseHeartbeatScheduler } from "./license-heartbeat.scheduler";
import { LicenseSoftlockGuard } from "./license-softlock.guard";

/**
 * F4.1 delivered the license *client* core. F4.2 adds the global soft-lock
 * guard and the status/activate endpoints — see
 * .claude-task-f4-2-softlock.md. Still no admin endpoints, no server logic.
 */
@Module({
  imports: [PrismaModule, BullModule.registerQueue({ name: LICENSE_HEARTBEAT_QUEUE })],
  controllers: [LicenseClientStatusController],
  providers: [
    LicenseClientService,
    LicenseHeartbeatProcessor,
    LicenseHeartbeatScheduler,
    { provide: APP_GUARD, useClass: LicenseSoftlockGuard },
  ],
  exports: [LicenseClientService],
})
export class LicenseClientModule {}
