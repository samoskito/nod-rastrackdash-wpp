import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Put } from "@nestjs/common";
import { workspaceOpsAlertSettingsInputSchema } from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { OpsAlertService } from "./ops-alerts.service";

@Controller("workspaces/:workspaceId/ops-alerts")
export class OpsAlertsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(WorkspacesService) private readonly workspaces: WorkspacesService, @Inject(OpsAlertService) private readonly opsAlerts: OpsAlertService) {}

  @Get("settings")
  async getSettings(@AuthToken() token: string, @Param("workspaceId") workspaceId: string) {
    await this.requireManager(token, workspaceId);
    return this.opsAlerts.getSettings(workspaceId);
  }

  @Put("settings")
  async putSettings(@AuthToken() token: string, @Param("workspaceId") workspaceId: string, @Body() body: unknown) {
    const context = await this.requireManager(token, workspaceId);
    const parsed = workspaceOpsAlertSettingsInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.opsAlerts.upsertSettings(workspaceId, parsed.data, context.userId);
  }

  private async requireManager(token: string, workspaceId: string) {
    const session = await this.auth.getSession(token);
    const workspace = this.workspaces.getCurrentWorkspace(session);
    if (workspace.id !== workspaceId || !workspace.permissions.canManageWorkspaceSettings) throw new ForbiddenException("Sem permissão para gerenciar alertas operacionais");
    return { userId: session.user.id };
  }
}
