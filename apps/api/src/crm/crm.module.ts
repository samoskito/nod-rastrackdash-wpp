import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../common/prisma/prisma.module";
import { RuntimeModule } from "../common/runtime/runtime.module";
import { FunnelConfigurationService } from "../conversion-rules/funnel-configuration.service";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { CrmBoardService } from "./crm-board.service";
import { CrmController } from "./crm.controller";

/**
 * CRM Kanban. FunnelConfigurationService (only Prisma) is provided here so
 * the board never imports the whole conversion-rules module; the manual
 * conversion module imports this one for the forward-only kanban check.
 */
@Module({
  imports: [AuthModule, PrismaModule, RuntimeModule, WorkspacesModule],
  controllers: [CrmController],
  providers: [CrmBoardService, FunnelConfigurationService],
  exports: [CrmBoardService],
})
export class CrmModule {}
