import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
} from "@nestjs/common";
import { backofficeWorkspaceCreateInputSchema } from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { PlatformAdminService } from "../auth/platform-admin.service";
import { PlatformWorkspaceAccessService } from "./platform-workspace-access.service";

@Controller("backoffice/workspaces")
export class BackofficeWorkspacesController {
  constructor(
    private readonly platformAdmin: PlatformAdminService,
    private readonly workspaceAccess: PlatformWorkspaceAccessService,
  ) {}

  @Get()
  async list(@AuthToken() refreshToken: string) {
    await this.platformAdmin.assertPlatformAdmin(refreshToken);
    return this.workspaceAccess.listWorkspaces();
  }

  @Post()
  async create(@AuthToken() refreshToken: string, @Body() body: unknown) {
    const owner = await this.platformAdmin.assertPlatformOwner(refreshToken);
    const parsed = backofficeWorkspaceCreateInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException("Payload invalido");
    }

    return this.workspaceAccess.createWorkspace(parsed.data, owner);
  }

  @Post(":workspaceId/owners/:ownerUserId/activation-link")
  async createActivationLink(
    @AuthToken() refreshToken: string,
    @Param("workspaceId") workspaceId: string,
    @Param("ownerUserId") ownerUserId: string,
  ) {
    const owner = await this.platformAdmin.assertPlatformOwner(refreshToken);
    return this.workspaceAccess.createClientOwnerActivationLink(
      workspaceId,
      ownerUserId,
      owner,
    );
  }

  @Post(":workspaceId/owners/:ownerUserId/activation/resend")
  async resendActivationEmail(
    @AuthToken() refreshToken: string,
    @Param("workspaceId") workspaceId: string,
    @Param("ownerUserId") ownerUserId: string,
  ) {
    const owner = await this.platformAdmin.assertPlatformOwner(refreshToken);
    return this.workspaceAccess.reissueClientOwnerActivation(
      workspaceId,
      ownerUserId,
      owner,
    );
  }
}
