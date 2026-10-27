import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../common/prisma/prisma.module";
import { INTEGRATION_ENV } from "../integrations/integration.types";
import { MetaTokenEncryptionService } from "../integrations/meta/meta-token-encryption.service";
import { LeadsModule } from "../leads/leads.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { MetaLeadFormsController } from "./meta-lead-forms.controller";
import { MetaLeadFormsService } from "./meta-lead-forms.service";

@Module({
  imports: [AuthModule, PrismaModule, WorkspacesModule, LeadsModule],
  controllers: [MetaLeadFormsController],
  providers: [
    { provide: INTEGRATION_ENV, useValue: process.env },
    MetaTokenEncryptionService,
    MetaLeadFormsService,
  ],
  exports: [MetaLeadFormsService],
})
export class MetaLeadFormsModule {}
