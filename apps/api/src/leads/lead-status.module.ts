import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../common/prisma/prisma.module";
import { QueueModule } from "../common/queue/queue.module";
import { ConversionEventsModule } from "../conversion-events/conversion-events.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { LeadStatusController } from "./lead-status.controller";
import { LeadStatusService } from "./lead-status.service";

/**
 * Kept apart from LeadsModule (imported by the webhook pipelines) so the read
 * side does not depend on the conversion sender.
 */
@Module({
  imports: [
    AuthModule,
    PrismaModule,
    WorkspacesModule,
    ConversionEventsModule,
    QueueModule,
  ],
  controllers: [LeadStatusController],
  providers: [LeadStatusService],
})
export class LeadStatusModule {}
