import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../common/prisma/prisma.module";
import { RuntimeModule } from "../common/runtime/runtime.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { ConversionCatalogService } from "./conversion-catalog.service";
import { ConversionRulesController } from "./conversion-rules.controller";
import { ConversionRulesService } from "./conversion-rules.service";
import { FunnelConfigurationService } from "./funnel-configuration.service";
import { ProviderConversionRulesService } from "./provider-conversion-rules.service";
import { ProviderConversionObservationService } from "./provider-conversion-observation.service";
import { ProviderConversionDecisionEngine } from "./provider-conversion-decision.engine";
import { ProviderConversionDecisionRepository } from "./provider-conversion-decision.repository";
import { ProviderConversionEngineRolloutService } from "./provider-conversion-engine-rollout.service";
import { ProviderConversionLegacyDecisionEngine } from "./provider-conversion-legacy-decision.engine";
import { ProviderConversionOrchestrator } from "./provider-conversion-orchestrator.service";
import { ProviderConversionPaidLeadResolver } from "./provider-conversion-paid-lead-resolver.service";
import { ProviderConversionReviewApprovalService } from "./provider-conversion-review-approval.service";
import { ProviderConversionShadowComparisonService } from "./provider-conversion-shadow-comparison.service";
import { ProviderConversionTraceService } from "./provider-conversion-trace.service";
import { GlobalRuleAutoActivationService } from "./provider-rule-global-auto-activation.service";
import { LicenseClientModule } from "../licensing-client/license-client.module";

@Module({
  imports: [
    AuthModule,
    // ProviderConversionRulesService promotes the inbound connection when a
    // rule goes "Envio ativo", which bills external channel seats.
    PrismaModule,
    RuntimeModule,
    WorkspacesModule,
    // The automatic activation of "Todos os números" skips its run while the
    // installation license is locked (same rule as the 423 of every write).
    LicenseClientModule,
  ],
  controllers: [ConversionRulesController],
  providers: [
    ConversionRulesService,
    ConversionCatalogService,
    FunnelConfigurationService,
    ProviderConversionRulesService,
    ProviderConversionObservationService,
    ProviderConversionDecisionEngine,
    ProviderConversionDecisionRepository,
    ProviderConversionEngineRolloutService,
    ProviderConversionLegacyDecisionEngine,
    ProviderConversionPaidLeadResolver,
    ProviderConversionReviewApprovalService,
    ProviderConversionOrchestrator,
    ProviderConversionShadowComparisonService,
    ProviderConversionTraceService,
    GlobalRuleAutoActivationService,
  ],
  exports: [
    ConversionRulesService,
    ConversionCatalogService,
    FunnelConfigurationService,
    ProviderConversionRulesService,
    ProviderConversionObservationService,
    ProviderConversionDecisionEngine,
    ProviderConversionDecisionRepository,
    ProviderConversionEngineRolloutService,
    ProviderConversionLegacyDecisionEngine,
    ProviderConversionPaidLeadResolver,
    ProviderConversionReviewApprovalService,
    ProviderConversionOrchestrator,
    ProviderConversionShadowComparisonService,
    ProviderConversionTraceService,
  ],
})
export class ConversionRulesModule {}
