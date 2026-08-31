import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../common/prisma/prisma.module";
import { BackofficeWhatsappWebhooksController } from "./backoffice-whatsapp-webhooks.controller";
import { BackofficeWhatsappWebhooksService } from "./backoffice-whatsapp-webhooks.service";

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [BackofficeWhatsappWebhooksController],
  providers: [BackofficeWhatsappWebhooksService],
})
export class BackofficeWhatsappWebhooksModule {}
