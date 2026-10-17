import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { QueueModule } from "../common/queue/queue.module";
import { ConversionEventsModule } from "../conversion-events/conversion-events.module";
import { ConversionRulesModule } from "../conversion-rules/conversion-rules.module";
import { DiagnosticsModule } from "../diagnostics/diagnostics.module";
import { InboundWebhooksModule } from "../inbound-webhooks/inbound-webhooks.module";
import { LeadsModule } from "../leads/leads.module";
import { MetaLeadFormsModule } from "../meta-lead-forms/meta-lead-forms.module";
import { WebhooksController } from "./webhooks.controller";

@Module({
  imports: [
    DiagnosticsModule,
    PrismaModule,
    ConversionRulesModule,
    InboundWebhooksModule,
    LeadsModule,
    MetaLeadFormsModule,
    ConversionEventsModule,
    QueueModule
  ],
  controllers: [WebhooksController]
})
export class WebhooksModule {}
