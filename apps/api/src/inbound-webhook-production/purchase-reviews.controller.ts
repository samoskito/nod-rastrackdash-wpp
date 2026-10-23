import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import {
  purchaseReviewDecisionInputSchema,
  purchaseReviewItemsUpdateInputSchema,
  purchaseReviewListQuerySchema,
} from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { ProviderConversionProductionService } from "./provider-conversion-production.service";
import { PurchaseReviewsService } from "./purchase-reviews.service";

@Controller("purchase-reviews")
export class PurchaseReviewsController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(WorkspacesService)
    private readonly workspacesService: WorkspacesService,
    @Inject(PurchaseReviewsService)
    private readonly reviews: PurchaseReviewsService,
    @Inject(ProviderConversionProductionService)
    private readonly production: ProviderConversionProductionService,
  ) {}

  @Get()
  async list(
    @AuthToken() refreshToken: string,
    @Query() query: Record<string, unknown>,
  ) {
    const context = await this.getWorkspaceContext(refreshToken);
    const parsed = purchaseReviewListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.reviews.list(context.workspaceId, parsed.data);
  }

  @Get(":id")
  async get(@AuthToken() refreshToken: string, @Param("id") reviewId: string) {
    const context = await this.getWorkspaceContext(refreshToken);
    return this.reviews.get(context.workspaceId, reviewId);
  }

  @Put(":id/items")
  async updateItems(
    @AuthToken() refreshToken: string,
    @Param("id") reviewId: string,
    @Body() body: unknown,
  ) {
    const context = await this.requireIntegrationManager(refreshToken);
    const parsed = purchaseReviewItemsUpdateInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.reviews.updateItems(
      context.workspaceId,
      reviewId,
      parsed.data,
      context.userId,
    );
  }

  @Post(":id/approve")
  async approve(
    @AuthToken() refreshToken: string,
    @Param("id") reviewId: string,
    @Body() body: unknown,
  ) {
    const context = await this.requireIntegrationManager(refreshToken);
    const parsed = purchaseReviewDecisionInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    const approval = await this.reviews.prepareApproval(
      context.workspaceId,
      reviewId,
      parsed.data,
      context.userId,
    );
    await this.production.processExecution({
      workspaceId: context.workspaceId,
      providerConversionExecutionId: approval.providerConversionExecutionId,
    });

    return this.reviews.get(context.workspaceId, reviewId);
  }

  @Post(":id/resolve-and-approve")
  async resolveAndApprove(
    @AuthToken() refreshToken: string,
    @Param("id") reviewId: string,
    @Body() body: unknown,
  ) {
    const context = await this.requireIntegrationManager(refreshToken);
    const parsed = purchaseReviewItemsUpdateInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    await this.reviews.updateItems(
      context.workspaceId,
      reviewId,
      parsed.data,
      context.userId,
    );
    const approval = await this.reviews.prepareApproval(
      context.workspaceId,
      reviewId,
      { reason: parsed.data.reason },
      context.userId,
    );
    await this.production.processExecution({
      workspaceId: context.workspaceId,
      providerConversionExecutionId: approval.providerConversionExecutionId,
    });

    return this.reviews.get(context.workspaceId, reviewId);
  }

  @Post(":id/reject")
  async reject(
    @AuthToken() refreshToken: string,
    @Param("id") reviewId: string,
    @Body() body: unknown,
  ) {
    const context = await this.requireIntegrationManager(refreshToken);
    const parsed = purchaseReviewDecisionInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.reviews.reject(
      context.workspaceId,
      reviewId,
      parsed.data,
      context.userId,
    );
  }

  private async getWorkspaceContext(refreshToken: string): Promise<{
    userId: string;
    workspaceId: string;
    canManageIntegrations: boolean;
  }> {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    return {
      userId: authenticated.user.id,
      workspaceId: workspace.id,
      canManageIntegrations: workspace.permissions.canManageIntegrations,
    };
  }

  private async requireIntegrationManager(refreshToken: string): Promise<{
    userId: string;
    workspaceId: string;
  }> {
    const context = await this.getWorkspaceContext(refreshToken);
    if (!context.canManageIntegrations) {
      throw new ForbiddenException("Sem permissão para revisar compras");
    }
    return context;
  }
}
