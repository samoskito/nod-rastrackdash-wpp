import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { manualConversionInputSchema } from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import {
  ManualConversionService,
  type ManualConversionActor,
} from "./manual-conversion.service";

/**
 * Manual lead conversion (tarefa 21). Same "leads" prefix as LeadsController;
 * POST-only routes, so they never collide with GET /leads/:leadId. Owner and
 * admin only (canManageIntegrations), like the purchase reviews.
 */
@Controller("leads")
export class ManualConversionsController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(WorkspacesService)
    private readonly workspacesService: WorkspacesService,
    @Inject(ManualConversionService)
    private readonly manualConversions: ManualConversionService,
  ) {}

  @Post(":leadId/manual-conversions/preview")
  @HttpCode(200)
  async preview(
    @AuthToken() refreshToken: string,
    @Param("leadId") leadId: string,
    @Body() body: unknown,
  ) {
    const context = await this.requireIntegrationManager(refreshToken);
    return this.manualConversions.preview(
      context.workspaceId,
      leadId,
      this.parse(body),
    );
  }

  @Post(":leadId/manual-conversions")
  async create(
    @AuthToken() refreshToken: string,
    @Param("leadId") leadId: string,
    @Body() body: unknown,
  ) {
    const context = await this.requireIntegrationManager(refreshToken);
    return this.manualConversions.create(
      context.workspaceId,
      leadId,
      this.parse(body),
      context.actor,
    );
  }

  @Post(":leadId/manual-conversions/:logId/cancel")
  @HttpCode(200)
  async cancel(
    @AuthToken() refreshToken: string,
    @Param("leadId") leadId: string,
    @Param("logId") logId: string,
  ) {
    const context = await this.requireIntegrationManager(refreshToken);
    return this.manualConversions.cancel(
      context.workspaceId,
      leadId,
      logId,
      context.actor,
    );
  }

  private parse(body: unknown) {
    const parsed = manualConversionInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return parsed.data;
  }

  private async requireIntegrationManager(refreshToken: string): Promise<{
    workspaceId: string;
    actor: ManualConversionActor;
  }> {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException(
        "Sem permissão para registrar conversões manuais",
      );
    }
    return {
      workspaceId: workspace.id,
      actor: {
        userId: authenticated.user.id,
        name: authenticated.user.name ?? authenticated.user.email,
      },
    };
  }
}
