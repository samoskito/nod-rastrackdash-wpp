import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import {
  platformUserInvitationReissueInputSchema,
  platformUserProvisionInputSchema,
  platformUserRoleUpdateInputSchema,
} from "@wpptrack/shared";
import { AuthToken } from "./auth-user.decorator";
import { PlatformAdminService } from "./platform-admin.service";

@Controller("backoffice/platform-users")
export class BackofficePlatformUsersController {
  constructor(private readonly platformAdmin: PlatformAdminService) {}

  @Get()
  async list(@AuthToken() refreshToken: string) {
    await this.platformAdmin.assertPlatformAdmin(refreshToken);
    return this.platformAdmin.listPlatformUsers();
  }

  @Post()
  async invite(@AuthToken() refreshToken: string, @Body() body: unknown) {
    const owner = await this.platformAdmin.assertPlatformOwner(refreshToken);
    const parsed = platformUserProvisionInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException("Payload invalido");
    }

    return this.platformAdmin.invitePlatformOperator(parsed.data, owner);
  }

  @Patch(":userId")
  async updateRole(
    @AuthToken() refreshToken: string,
    @Param("userId") userId: string,
    @Body() body: unknown,
  ) {
    const owner = await this.platformAdmin.assertPlatformOwner(refreshToken);
    const parsed = platformUserRoleUpdateInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException("Payload invalido");
    }

    return this.platformAdmin.updatePlatformUserRole(
      userId,
      parsed.data,
      owner,
    );
  }

  @Post(":userId/invitation/reissue")
  async reissueInvitation(
    @AuthToken() refreshToken: string,
    @Param("userId") userId: string,
    @Body() body: unknown,
  ) {
    const owner = await this.platformAdmin.assertPlatformOwner(refreshToken);
    const parsed = platformUserInvitationReissueInputSchema.safeParse(
      body ?? {},
    );

    if (!parsed.success) {
      throw new BadRequestException("Payload invalido");
    }

    return this.platformAdmin.reissuePlatformOperatorInvitation(userId, owner);
  }
}
