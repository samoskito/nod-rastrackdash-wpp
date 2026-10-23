import {
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { ProviderRuleBlockedReprocessService } from "./provider-rule-blocked-reprocess.service";

/**
 * Lives in the inbound webhooks module (it needs the UAZAPI recovery path),
 * under the same /conversion-rules prefix and the same permission as every
 * other rule write (canManageIntegrations). A POST: the license soft-lock
 * answers 423 before this controller while the license is locked.
 */
@Controller("conversion-rules")
export class ProviderRuleBlockedReprocessController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(WorkspacesService)
    private readonly workspacesService: WorkspacesService,
    @Inject(ProviderRuleBlockedReprocessService)
    private readonly reprocessService: ProviderRuleBlockedReprocessService,
  ) {}

  @Post("providers/:id/reprocess-blocked")
  @HttpCode(200)
  async reprocessBlocked(
    @AuthToken() refreshToken: string,
    @Param("id") providerRuleId: string,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.reprocessService.reprocess(
      workspace.id,
      providerRuleId,
      authenticated.user.id,
    );
  }
}
