import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import {
  inboundWebhookChannelCreateInputSchema,
  inboundWebhookChannelRoutesUpdateInputSchema,
  inboundWebhookChannelStatusUpdateInputSchema,
  inboundWebhookConnectionCreateInputSchema,
  inboundWebhookConnectionStatusUpdateInputSchema,
  providerConversionAutomationReprocessBatchInputSchema,
} from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { InboundConversionAutomationIngestionService } from "./inbound-conversion-automation-ingestion.service";
import { InboundWebhookConnectionsService } from "./inbound-webhook-connections.service";
import { InboundWebhookChannelRoutesService } from "./inbound-webhook-channel-routes.service";

@Controller("integrations/inbound-webhooks")
export class InboundWebhookConnectionsController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(WorkspacesService)
    private readonly workspacesService: WorkspacesService,
    @Inject(InboundWebhookConnectionsService)
    private readonly connectionsService: InboundWebhookConnectionsService,
    @Inject(InboundWebhookChannelRoutesService)
    private readonly channelRoutesService: InboundWebhookChannelRoutesService,
    @Inject(InboundConversionAutomationIngestionService)
    private readonly conversionAutomation: InboundConversionAutomationIngestionService,
  ) {}

  @Get()
  async listConnections(@AuthToken() refreshToken: string) {
    const { workspaceId } = await this.getCurrentWorkspaceContext(refreshToken);

    return this.connectionsService.listConnections(workspaceId);
  }

  @Get("capabilities")
  async getCapabilities(@AuthToken() refreshToken: string) {
    await this.getCurrentWorkspaceContext(refreshToken);

    return this.connectionsService.getCapabilities();
  }

  @Post()
  async createConnection(
    @AuthToken() refreshToken: string,
    @Body() body: unknown,
  ) {
    const context = await this.requireManager(refreshToken);
    const parsed = inboundWebhookConnectionCreateInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.connectionsService.createConnection(
      context.workspaceId,
      parsed.data,
      context.userId,
    );
  }

  @Get(":connectionId")
  async getConnection(
    @AuthToken() refreshToken: string,
    @Param("connectionId") connectionId: string,
  ) {
    const { workspaceId } = await this.getCurrentWorkspaceContext(refreshToken);

    return this.connectionsService.getConnection(workspaceId, connectionId);
  }

  @Get(":connectionId/overview")
  async getOverview(
    @AuthToken() refreshToken: string,
    @Param("connectionId") connectionId: string,
  ) {
    const { workspaceId } = await this.getCurrentWorkspaceContext(refreshToken);

    return this.connectionsService.getOverview(workspaceId, connectionId);
  }

  @Get(":connectionId/channels")
  async listChannels(
    @AuthToken() refreshToken: string,
    @Param("connectionId") connectionId: string,
  ) {
    const { workspaceId } = await this.getCurrentWorkspaceContext(refreshToken);

    return this.channelRoutesService.listChannels(workspaceId, connectionId);
  }

  @Post(":connectionId/channels")
  async createChannel(
    @AuthToken() refreshToken: string,
    @Param("connectionId") connectionId: string,
    @Body() body: unknown,
  ) {
    const context = await this.requireManager(refreshToken);
    const parsed = inboundWebhookChannelCreateInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.channelRoutesService.createProvisionalChannel(
      context.workspaceId,
      connectionId,
      parsed.data,
      context.userId,
    );
  }

  @Post(":connectionId/rotate-secret")
  @HttpCode(200)
  async rotateSecret(
    @AuthToken() refreshToken: string,
    @Param("connectionId") connectionId: string,
  ) {
    const context = await this.requireManager(refreshToken);

    return this.connectionsService.rotateSecret(
      context.workspaceId,
      connectionId,
      context.userId,
    );
  }

  @Post("provider-rules/:ruleId/reprocess-latest")
  @HttpCode(200)
  async reprocessLatestObservedAutomation(
    @AuthToken() refreshToken: string,
    @Param("ruleId") ruleId: string,
    @Body() body: unknown,
  ) {
    const context = await this.requireManager(refreshToken);
    if (
      !body ||
      typeof body !== "object" ||
      (body as Record<string, unknown>).confirmation !==
        "REPROCESSAR_CALLBACK_OBSERVADO"
    ) {
      throw new BadRequestException("Confirmacao invalida");
    }

    return this.conversionAutomation.reprocessLatestObserved(
      context.workspaceId,
      ruleId,
      context.userId,
    );
  }

  @Get("provider-rules/:ruleId/callbacks")
  async listProviderRuleCallbacks(
    @AuthToken() refreshToken: string,
    @Param("ruleId") ruleId: string,
  ) {
    const context = await this.requireManager(refreshToken);

    return this.conversionAutomation.listAutomationCallbacks(
      context.workspaceId,
      ruleId,
    );
  }

  @Get("provider-rules/:ruleId/callbacks/:deliveryId/payload")
  async getProviderRuleCallbackPayload(
    @AuthToken() refreshToken: string,
    @Param("ruleId") ruleId: string,
    @Param("deliveryId") deliveryId: string,
  ) {
    const context = await this.requireManager(refreshToken);

    return this.conversionAutomation.readAutomationPayload(
      context.workspaceId,
      ruleId,
      deliveryId,
      context.userId,
    );
  }

  @Post("provider-rules/:ruleId/callbacks/reprocess")
  @HttpCode(200)
  async reprocessProviderRuleCallbacks(
    @AuthToken() refreshToken: string,
    @Param("ruleId") ruleId: string,
    @Body() body: unknown,
  ) {
    const context = await this.requireManager(refreshToken);
    const parsed =
      providerConversionAutomationReprocessBatchInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.conversionAutomation.reprocessSelectedCallbacks(
      context.workspaceId,
      ruleId,
      parsed.data.deliveryIds,
      context.userId,
    );
  }

  @Put(":connectionId/status")
  async updateStatus(
    @AuthToken() refreshToken: string,
    @Param("connectionId") connectionId: string,
    @Body() body: unknown,
  ) {
    const context = await this.requireManager(refreshToken);

    const parsed =
      inboundWebhookConnectionStatusUpdateInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.connectionsService.updateStatus(
      context.workspaceId,
      connectionId,
      parsed.data,
      context.userId,
    );
  }

  @Put("channels/:channelId/routes")
  async replaceChannelRoutes(
    @AuthToken() refreshToken: string,
    @Param("channelId") channelId: string,
    @Body() body: unknown,
  ) {
    const context = await this.requireManager(refreshToken);
    const parsed = inboundWebhookChannelRoutesUpdateInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.channelRoutesService.replaceRoutes(
      context.workspaceId,
      channelId,
      parsed.data,
      context.userId,
    );
  }

  @Delete("channels/:channelId/routes/:routeId")
  @HttpCode(204)
  async removeChannelRoute(
    @AuthToken() refreshToken: string,
    @Param("channelId") channelId: string,
    @Param("routeId") routeId: string,
  ): Promise<void> {
    const context = await this.requireManager(refreshToken);

    await this.channelRoutesService.removeRoute(
      context.workspaceId,
      channelId,
      routeId,
      context.userId,
    );
  }

  @Put("channels/:channelId/status")
  async updateChannelStatus(
    @AuthToken() refreshToken: string,
    @Param("channelId") channelId: string,
    @Body() body: unknown,
  ) {
    const context = await this.requireManager(refreshToken);
    const parsed = inboundWebhookChannelStatusUpdateInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.channelRoutesService.updateChannelStatus(
      context.workspaceId,
      channelId,
      parsed.data,
      context.userId,
    );
  }

  @Delete(":connectionId")
  @HttpCode(204)
  async removeConnection(
    @AuthToken() refreshToken: string,
    @Param("connectionId") connectionId: string,
  ): Promise<void> {
    const context = await this.requireManager(refreshToken);

    await this.connectionsService.removeConnection(
      context.workspaceId,
      connectionId,
      context.userId,
    );
  }

  private async requireManager(refreshToken: string): Promise<{
    userId: string;
    workspaceId: string;
  }> {
    const context = await this.getCurrentWorkspaceContext(refreshToken);

    if (!context.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return {
      userId: context.userId,
      workspaceId: context.workspaceId,
    };
  }

  private async getCurrentWorkspaceContext(refreshToken: string): Promise<{
    canManageIntegrations: boolean;
    userId: string;
    workspaceId: string;
  }> {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);

    return {
      canManageIntegrations: workspace.permissions.canManageIntegrations,
      userId: authenticated.user.id,
      workspaceId: workspace.id,
    };
  }
}
