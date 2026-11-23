import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Put,
} from "@nestjs/common";
import { ghlTokenUpdateInputSchema } from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { GoHighLevelPipelinesService } from "./gohighlevel-pipelines.service";

/** GoHighLevel connection: optional token + the location's pipelines/stages. */
@Controller("integrations/inbound-webhooks")
export class GoHighLevelPipelinesController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(WorkspacesService)
    private readonly workspacesService: WorkspacesService,
    @Inject(GoHighLevelPipelinesService)
    private readonly service: GoHighLevelPipelinesService,
  ) {}

  @Get(":connectionId/gohighlevel-pipelines")
  async listPipelines(
    @AuthToken() refreshToken: string,
    @Param("connectionId") connectionId: string,
  ) {
    const workspace = await this.workspace(refreshToken);
    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }
    return this.service.listPipelines(workspace.id, connectionId);
  }

  @Put(":connectionId/gohighlevel-token")
  async saveToken(
    @AuthToken() refreshToken: string,
    @Param("connectionId") connectionId: string,
    @Body() body: unknown,
  ) {
    const workspace = await this.workspace(refreshToken);
    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }
    const parsed = ghlTokenUpdateInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Token invalido");
    return this.service.saveToken(workspace.id, connectionId, parsed.data.token);
  }

  private async workspace(refreshToken: string) {
    const authenticated = await this.authService.getSession(refreshToken);
    return this.workspacesService.getCurrentWorkspace(authenticated);
  }
}
