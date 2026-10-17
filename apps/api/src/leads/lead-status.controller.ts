import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Param,
  Patch,
} from "@nestjs/common";
import { leadStatusUpdateInputSchema } from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { LeadStatusService } from "./lead-status.service";

@Controller("leads")
export class LeadStatusController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(WorkspacesService)
    private readonly workspacesService: WorkspacesService,
    @Inject(LeadStatusService)
    private readonly leadStatusService: LeadStatusService,
  ) {}

  /** Operator status change; "qualified" also sends QualifiedLead to Meta. */
  @Patch(":leadId/status")
  async updateStatus(
    @AuthToken() refreshToken: string,
    @Param("leadId") leadId: string,
    @Body() body: unknown,
  ) {
    const parsed = leadStatusUpdateInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException("Status invalido");
    }

    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);

    return this.leadStatusService.updateStatus({
      workspaceId: workspace.id,
      leadId,
      status: parsed.data.status,
      actorUserId: authenticated.user.id,
    });
  }
}
