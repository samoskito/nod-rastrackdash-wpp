import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
} from "@nestjs/common";
import { backofficeIntegrationEventQuerySchema } from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { PlatformAdminService } from "../auth/platform-admin.service";
import { BackofficeIntegrationEventsService } from "./backoffice-integration-events.service";

/**
 * Backoffice "Recebimentos das URLs únicas" (porte do SaaS #170). Platform
 * admins of the installation only: the listing crosses workspaces, so nobody
 * else may call it, whatever their role in a workspace. Reads only, so they
 * keep working with a blocked license.
 */
@Controller("backoffice/integration-events")
export class BackofficeIntegrationEventsController {
  constructor(
    @Inject(PlatformAdminService)
    private readonly platformAdmin: PlatformAdminService,
    @Inject(BackofficeIntegrationEventsService)
    private readonly events: BackofficeIntegrationEventsService,
  ) {}

  @Get()
  async list(
    @AuthToken() refreshToken: string,
    @Query() query: Record<string, unknown>,
  ) {
    const actor = await this.platformAdmin.assertPlatformAdmin(refreshToken);
    const parsed = backofficeIntegrationEventQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Filtros inválidos");
    return this.events.list(parsed.data, actor);
  }

  @Get(":eventId/payload")
  async payload(
    @AuthToken() refreshToken: string,
    @Param("eventId") eventId: string,
  ) {
    const actor = await this.platformAdmin.assertPlatformAdmin(refreshToken);
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(eventId)) {
      throw new BadRequestException("Recebimento inválido");
    }
    return this.events.readPayload(eventId, actor);
  }
}
