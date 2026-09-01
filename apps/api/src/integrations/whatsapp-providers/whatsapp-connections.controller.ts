import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import {
  whatsappConnectionCreateInputSchema,
  whatsappConnectionCredentialsUpdateSchema,
  whatsappConnectionEditInputSchema,
  whatsappConnectionUpdateInputSchema,
} from "@wpptrack/shared";
import { z } from "zod";
import { AuthToken } from "../../auth/auth-user.decorator";
import { AuthService } from "../../auth/auth.service";
import { WorkspacesService } from "../../workspaces/workspaces.service";
import { WhatsappConnectionsService } from "./whatsapp-connections.service";

const CONNECTION_MUTATION_MIN_INTERVAL_MS = 1_000;
const connectionIdSchema = z.string().trim().min(1).max(191);

@Controller("integrations/whatsapp-connections")
export class WhatsappConnectionsController {
  private readonly lastMutationAtByUser = new Map<string, number>();

  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(WorkspacesService)
    private readonly workspacesService: WorkspacesService,
    private readonly connections: WhatsappConnectionsService,
  ) {}

  @Get()
  async list(@AuthToken() refreshToken: string) {
    const context = await this.getContext(refreshToken);
    return this.connections.listConnections(context.workspaceId);
  }

  @Get(":id/edit")
  async editMetadata(
    @AuthToken() refreshToken: string,
    @Param("id") id: string,
  ) {
    const context = await this.getContext(refreshToken);
    const connectionId = this.parse(connectionIdSchema.safeParse(id));
    return this.connections.getEditableConnection(context, connectionId);
  }

  @Post()
  async create(@AuthToken() refreshToken: string, @Body() body: unknown) {
    const context = await this.getContext(refreshToken);
    this.enforceMutationRateLimit(context.userId);
    const input = this.parse(
      whatsappConnectionCreateInputSchema.safeParse(body),
    );
    return this.connections.createConnection(context, input);
  }

  @Patch(":id")
  async update(
    @AuthToken() refreshToken: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const context = await this.getContext(refreshToken);
    this.enforceMutationRateLimit(context.userId);
    const connectionId = this.parse(connectionIdSchema.safeParse(id));
    const input = this.parse(
      whatsappConnectionUpdateInputSchema.safeParse(body),
    );
    return this.connections.updateConnection(context, connectionId, input);
  }

  @Patch(":id/credentials")
  async updateCredentials(
    @AuthToken() refreshToken: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const context = await this.getContext(refreshToken);
    this.enforceMutationRateLimit(context.userId);
    const connectionId = this.parse(connectionIdSchema.safeParse(id));
    const input = this.parse(
      whatsappConnectionCredentialsUpdateSchema.safeParse(body),
    );
    return this.connections.updateCredentials(context, connectionId, input);
  }

  @Patch(":id/edit")
  async edit(
    @AuthToken() refreshToken: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const context = await this.getContext(refreshToken);
    this.enforceMutationRateLimit(context.userId);
    const connectionId = this.parse(connectionIdSchema.safeParse(id));
    const input = this.parse(
      whatsappConnectionEditInputSchema.safeParse(body),
    );
    return this.connections.editConnection(context, connectionId, input);
  }

  @Post(":id/test")
  async test(@AuthToken() refreshToken: string, @Param("id") id: string) {
    const context = await this.getContext(refreshToken);
    this.enforceMutationRateLimit(context.userId);
    const connectionId = this.parse(connectionIdSchema.safeParse(id));
    return this.connections.testConnection(context, connectionId);
  }

  @Post(":id/rotate-webhook-token")
  async rotateWebhookToken(
    @AuthToken() refreshToken: string,
    @Param("id") id: string,
  ) {
    const context = await this.getContext(refreshToken);
    this.enforceMutationRateLimit(context.userId);
    const connectionId = this.parse(connectionIdSchema.safeParse(id));
    return this.connections.rotateWebhookToken(context, connectionId);
  }

  @Delete(":id")
  @HttpCode(204)
  async deactivate(
    @AuthToken() refreshToken: string,
    @Param("id") id: string,
  ): Promise<void> {
    const context = await this.getContext(refreshToken);
    this.enforceMutationRateLimit(context.userId);
    const connectionId = this.parse(connectionIdSchema.safeParse(id));
    await this.connections.deactivateConnection(context, connectionId);
  }

  private async getContext(refreshToken: string) {
    const session = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(session);
    return {
      workspaceId: workspace.id,
      userId: session.user.id,
      role: workspace.role,
      canManageMembers:
        workspace.role === "admin" && workspace.permissions.canManageMembers,
    };
  }

  private parse<T>(
    parsed:
      | { success: true; data: T }
      | { success: false; error: { flatten(): unknown } },
  ): T {
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return parsed.data;
  }

  private enforceMutationRateLimit(userId: string): void {
    const now = Date.now();
    const previous = this.lastMutationAtByUser.get(userId) ?? 0;
    if (now - previous < CONNECTION_MUTATION_MIN_INTERVAL_MS) {
      throw new HttpException(
        "Muitas alteracoes de conexao WhatsApp. Aguarde alguns segundos.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.lastMutationAtByUser.set(userId, now);
  }
}
