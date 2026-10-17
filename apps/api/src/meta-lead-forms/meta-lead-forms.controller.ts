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
        parsed.error.issues[0]?.message ?? "Dados invalidos",
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
        parsed.error.issues[0]?.message ?? "Dados invalidos",
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
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return { userId: authenticated.user.id, workspaceId: workspace.id };
  }
}
