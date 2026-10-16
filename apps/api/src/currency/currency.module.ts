import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../common/prisma/prisma.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { CurrencySettingsController } from "./currency-settings.controller";
import { CurrencySettingsService } from "./currency-settings.service";

/** Fase 5.1: moeda das conversões e correção da moeda por conta de anúncio. */
@Module({
  imports: [AuthModule, PrismaModule, WorkspacesModule],
  controllers: [CurrencySettingsController],
  providers: [CurrencySettingsService],
  exports: [CurrencySettingsService],
})
export class CurrencyModule {}
