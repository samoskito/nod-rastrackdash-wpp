import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import {
  studentInboundReplayAuthorizeSchema,
  studentInboundReplayRetrySchema,
} from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { InboundWebhookReplayService } from "./inbound-webhook-replay.service";
import type { StudentReplayActor } from "./student-replay-context";

@Controller(
  "integrations/inbound-webhooks/:connectionId/channels/:channelId/recovery",
)
export class StudentInboundReplayController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
    @Inject(InboundWebhookReplayService)
    private readonly replay: InboundWebhookReplayService,
  ) {}

  @Get("preview")
  async preview(
    @AuthToken() token: string,
    @Param("connectionId") connectionId: string,
    @Param("channelId") channelId: string,
  ) {
    return this.replay.previewStudentReplay(
      await this.owner(token),
      connectionId,
      channelId,
    );
  }

  @Post("authorize")
  @HttpCode(200)
  async authorize(
    @AuthToken() token: string,
    @Param("connectionId") connectionId: string,
    @Param("channelId") channelId: string,
    @Body() body: unknown,
  ) {
    const actor = await this.owner(token);
    const parsed = studentInboundReplayAuthorizeSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("Revise a confirmação da recuperação");
    return this.replay.authorizeStudentReplay(
      actor,
      connectionId,
      channelId,
      parsed.data,
    );
  }

  @Get("batches/:batchId")
  async result(
    @AuthToken() token: string,
    @Param("connectionId") connectionId: string,
    @Param("channelId") channelId: string,
    @Param("batchId") batchId: string,
  ) {
    return this.replay.getStudentReplayResult(
      await this.owner(token),
      connectionId,
      channelId,
      batchId,
    );
  }

  /**
   * Fase 6.1c (porte do SaaS #91): reenvia os itens que falharam do lote,
   * com o payload ainda retido. Escrita: 423 com a licença bloqueada (guard
   * global) e de novo no serviço.
   */
  @Post("batches/:batchId/retry")
  @HttpCode(200)
  async retry(
    @AuthToken() token: string,
    @Param("connectionId") connectionId: string,
    @Param("channelId") channelId: string,
    @Param("batchId") batchId: string,
    @Body() body: unknown,
  ) {
    const actor = await this.owner(token);
    const parsed = studentInboundReplayRetrySchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("Digite o nome da conexão para confirmar");
    return this.replay.retryStudentFailedItems(
      actor,
      connectionId,
      channelId,
      batchId,
      parsed.data.confirmation,
    );
  }

  private async owner(token: string): Promise<StudentReplayActor> {
    const session = await this.auth.getSession(token);
    const workspace = this.workspaces.getCurrentWorkspace(session);
    if (
      workspace.role !== "owner" ||
      workspace.accessMode !== "member" ||
      !workspace.permissions.canManageIntegrations
    )
      throw new ForbiddenException(
        "Somente o owner do workspace pode recuperar CTWAs anteriores",
      );
    return { id: session.user.id, role: "owner", workspaceId: workspace.id };
  }
}
