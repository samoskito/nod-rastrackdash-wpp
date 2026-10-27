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
  Patch,
  Post,
} from "@nestjs/common";
import {
  metaLeadFormConnectionCreateInputSchema,
  metaLeadFormConnectionUpdateInputSchema,
} from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { MetaLeadFormsService } from "./meta-lead-forms.service";

@Controller("integrations/meta-lead-forms")
export class MetaLeadFormsController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(WorkspacesService)
    private readonly workspacesService: WorkspacesService,
    @Inject(MetaLeadFormsService)
    private readonly metaLeadForms: MetaLeadFormsService,
  ) {}

  @Get()
  async list(@AuthToken() refreshToken: string) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);

    return this.metaLeadForms.listConnections(workspace.id);
  }

  @Post()
  async create(@AuthToken() refreshToken: string, @Body() body: unknown) {
    const parsed = metaLeadFormConnectionCreateInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? "Dados inválidos",
      );
    }
    const { userId, workspaceId } =
      await this.requireIntegrationManager(refreshToken);

    return this.metaLeadForms.createConnection(workspaceId, userId, parsed.data);
  }

  @Patch(":id")
  async update(
    @AuthToken() refreshToken: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = metaLeadFormConnectionUpdateInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? "Dados inválidos",
      );
    }
    const { workspaceId } = await this.requireIntegrationManager(refreshToken);

    return this.metaLeadForms.updateConnection(workspaceId, id, parsed.data);
  }

  @Post(":id/subscribe")
  async subscribe(@AuthToken() refreshToken: string, @Param("id") id: string) {
    const { workspaceId } = await this.requireIntegrationManager(refreshToken);

    return this.metaLeadForms.subscribePage(workspaceId, id);
  }

  /** Stops receiving the Page's leads; every submission stays. */
  @Post(":id/deactivate")
  @HttpCode(200)
  async deactivate(@AuthToken() refreshToken: string, @Param("id") id: string) {
    const { workspaceId } = await this.requireIntegrationManager(refreshToken);

    return this.metaLeadForms.setConnectionActive(workspaceId, id, false);
  }

  @Post(":id/reactivate")
  @HttpCode(200)
  async reactivate(@AuthToken() refreshToken: string, @Param("id") id: string) {
    const { workspaceId } = await this.requireIntegrationManager(refreshToken);

    return this.metaLeadForms.setConnectionActive(workspaceId, id, true);
  }

  /** 409 when the Page already received submissions: deactivate instead. */
  @Delete(":id")
  @HttpCode(204)
  async remove(@AuthToken() refreshToken: string, @Param("id") id: string) {
    const { workspaceId } = await this.requireIntegrationManager(refreshToken);

    await this.metaLeadForms.deleteConnection(workspaceId, id);
  }

  private async requireIntegrationManager(refreshToken: string) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissão para gerenciar integrações");
    }

    return { userId: authenticated.user.id, workspaceId: workspace.id };
  }
}
