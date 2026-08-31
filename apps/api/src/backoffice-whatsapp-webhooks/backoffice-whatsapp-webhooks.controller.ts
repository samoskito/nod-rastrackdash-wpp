import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
} from "@nestjs/common";
import { backofficeWhatsappWebhookHistoryQuerySchema } from "@wpptrack/shared";
import { z } from "zod";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { PlatformAdminService } from "../auth/platform-admin.service";
import { BackofficeWhatsappWebhooksService } from "./backoffice-whatsapp-webhooks.service";

const idSchema = z.string().trim().min(1).max(191);

@Controller("backoffice/whatsapp-webhooks")
export class BackofficeWhatsappWebhooksController {
  constructor(
    @Inject(PlatformAdminService)
    private readonly platformAdmin: PlatformAdminService,
    @Inject(AuthService) private readonly authService: AuthService,
    private readonly webhooks: BackofficeWhatsappWebhooksService,
  ) {}

  @Get("connections")
  async listConnections(@AuthToken() refreshToken: string) {
    return this.webhooks.listConnections(
      await this.getCurrentWorkspaceId(refreshToken),
    );
  }

  @Get("connections/:connectionId/history")
  async listHistory(
    @AuthToken() refreshToken: string,
    @Param("connectionId") connectionId: string,
    @Query() query: unknown,
  ) {
    const parsedConnectionId = this.parse(idSchema.safeParse(connectionId));
    const parsedQuery = this.parse(
      backofficeWhatsappWebhookHistoryQuerySchema.safeParse(query),
    );
    return this.webhooks.listHistory(
      await this.getCurrentWorkspaceId(refreshToken),
      parsedConnectionId,
      parsedQuery,
    );
  }

  @Get("connections/:connectionId/history/:webhookLogId")
  async getDetail(
    @AuthToken() refreshToken: string,
    @Param("connectionId") connectionId: string,
    @Param("webhookLogId") webhookLogId: string,
  ) {
    const [parsedConnectionId, parsedWebhookLogId] = [
      this.parse(idSchema.safeParse(connectionId)),
      this.parse(idSchema.safeParse(webhookLogId)),
    ];
    return this.webhooks.getWebhookDetail(
      await this.getCurrentWorkspaceId(refreshToken),
      parsedConnectionId,
      parsedWebhookLogId,
    );
  }

  private async getCurrentWorkspaceId(refreshToken: string): Promise<string> {
    await this.platformAdmin.assertPlatformAdmin(refreshToken);
    const session = await this.authService.getSession(refreshToken);
    const workspaceId = session.supportContext?.workspaceId ?? session.activeWorkspaceId;
    if (!workspaceId) {
      throw new BadRequestException(
        "Selecione um workspace para consultar os webhooks WhatsApp",
      );
    }
    return workspaceId;
  }

  private parse<T>(
    parsed:
      | { success: true; data: T }
      | { success: false; error: { flatten(): unknown } },
  ): T {
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return parsed.data;
  }
}
