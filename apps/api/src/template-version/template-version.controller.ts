import { Controller, Get } from "@nestjs/common";
import type { TemplateVersionDto } from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { PlatformAdminService } from "../auth/platform-admin.service";
import { TemplateVersionService } from "./template-version.service";

@Controller("backoffice/template-version")
export class TemplateVersionController {
  constructor(
    private readonly platformAdmin: PlatformAdminService,
    private readonly templateVersion: TemplateVersionService,
  ) {}

  @Get()
  async get(@AuthToken() refreshToken: string): Promise<TemplateVersionDto> {
    await this.platformAdmin.assertPlatformOwner(refreshToken);
    return this.templateVersion.getVersion();
  }
}
