import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import type { ZodError } from "zod";
import {
  metaCloudWabaSubscriptionLookupInputSchema,
  metaCloudWabaSubscriptionSubscribeInputSchema,
} from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { MetaCloudWabaRateLimiter } from "./meta-cloud-waba-rate-limiter";
import { MetaCloudWabaSubscriptionService } from "./meta-cloud-waba-subscription.service";

/**
 * Inscrição do app Meta da instalação na WABA do aluno. As duas rotas são
 * POST para o token do aluno nunca ir na URL; só dono/admin do workspace
 * (canManageIntegrations), com limite de chamadas por usuário e por
 * workspace (MetaCloudWabaRateLimiter). O guard global de licença responde 423 a ambas
 * enquanto a licença estiver bloqueada.
 */
@Controller("integrations/inbound-webhooks")
export class MetaCloudWabaSubscriptionController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(WorkspacesService)
    private readonly workspacesService: WorkspacesService,
    @Inject(MetaCloudWabaSubscriptionService)
    private readonly service: MetaCloudWabaSubscriptionService,
    @Inject(MetaCloudWabaRateLimiter)
    private readonly rateLimiter: MetaCloudWabaRateLimiter,
  ) {}

  @Post(":connectionId/meta-cloud/waba-subscription/lookup")
  @HttpCode(200)
  async lookup(
    @AuthToken() refreshToken: string,
    @Param("connectionId") connectionId: string,
    @Body() body: unknown,
    @Req() request: { ip?: string },
  ) {
    const context = await this.requireManager(refreshToken);
    const parsed = metaCloudWabaSubscriptionLookupInputSchema.safeParse(body);
    if (!parsed.success) throw invalidInput(parsed.error);
    this.rateLimiter.enforce(context.userId, context.workspaceId);

    return this.service.lookup({
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      connectionId,
      wabaId: parsed.data.wabaId,
      accessToken: parsed.data.accessToken,
      sourceIp: request.ip ?? null,
    });
  }

  @Post(":connectionId/meta-cloud/waba-subscription")
  @HttpCode(200)
  async subscribe(
    @AuthToken() refreshToken: string,
    @Param("connectionId") connectionId: string,
    @Body() body: unknown,
    @Req() request: { ip?: string },
  ) {
    const context = await this.requireManager(refreshToken);
    const parsed = metaCloudWabaSubscriptionSubscribeInputSchema.safeParse(body);
    if (!parsed.success) throw invalidInput(parsed.error);
    this.rateLimiter.enforce(context.userId, context.workspaceId);

    return this.service.subscribe({
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      connectionId,
      wabaId: parsed.data.wabaId,
      accessToken: parsed.data.accessToken,
      sourceIp: request.ip ?? null,
    });
  }

  private async requireManager(
    refreshToken: string,
  ): Promise<{ userId: string; workspaceId: string }> {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException(
        "Só o dono ou um admin do workspace pode consultar ou inscrever a WABA.",
      );
    }

    return { userId: authenticated.user.id, workspaceId: workspace.id };
  }
}

/**
 * Erro de validação sem eco do corpo: o flatten do Zod não inclui valores,
 * só mensagens por campo, então o token nunca volta na resposta.
 */
function invalidInput(error: ZodError): BadRequestException {
  const fields = error.flatten().fieldErrors as Record<string, string[] | undefined>;
  const first =
    fields.confirm?.[0] ?? fields.wabaId?.[0] ?? fields.accessToken?.[0];
  return new BadRequestException({
    statusCode: 400,
    message: first ?? "Dados inválidos para a consulta da WABA.",
    code: "invalid_input",
  });
}
