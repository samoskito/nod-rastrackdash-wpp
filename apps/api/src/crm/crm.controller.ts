import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
} from "@nestjs/common";
import { crmBoardQuerySchema, crmColumnQuerySchema } from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { CrmBoardService } from "./crm-board.service";

/**
 * CRM Kanban (docs/plans/2026-10-24-crm-kanban-design.md). Every member of
 * the workspace reads the board (same as the Leads page); moving a card is a
 * manual conversion (POST /leads/:leadId/manual-conversions, source
 * "kanban"), so it keeps the owner/admin permission of that route.
 */
@Controller("crm")
export class CrmController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(WorkspacesService)
    private readonly workspacesService: WorkspacesService,
    @Inject(CrmBoardService) private readonly board: CrmBoardService,
  ) {}

  @Get("board")
  async getBoard(@AuthToken() refreshToken: string, @Query() query: unknown) {
    const parsed = crmBoardQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Consulta inválida");
    const workspace = await this.workspace(refreshToken);
    return this.board.getBoard(workspace.id, parsed.data, {
      canMoveCards: workspace.permissions.canManageIntegrations === true,
    });
  }

  @Get("board/columns/:stageKey")
  async getColumn(
    @AuthToken() refreshToken: string,
    @Param("stageKey") stageKey: string,
    @Query() query: unknown,
  ) {
    const parsed = crmColumnQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Consulta inválida");
    const workspace = await this.workspace(refreshToken);
    return this.board.getColumnPage(workspace.id, stageKey, parsed.data);
  }

  private async workspace(refreshToken: string) {
    const authenticated = await this.authService.getSession(refreshToken);
    return this.workspacesService.getCurrentWorkspace(authenticated);
  }
}
