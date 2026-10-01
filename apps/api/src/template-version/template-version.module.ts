import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import {
  TEMPLATE_VERSION_DEPLOYED_SHA,
  TEMPLATE_VERSION_GITHUB_FETCH,
} from "./template-version.constants";
import { TemplateVersionController } from "./template-version.controller";
import { TemplateVersionService } from "./template-version.service";

@Module({
  imports: [AuthModule],
  controllers: [TemplateVersionController],
  providers: [
    TemplateVersionService,
    {
      provide: TEMPLATE_VERSION_GITHUB_FETCH,
      useValue: fetch,
    },
    {
      provide: TEMPLATE_VERSION_DEPLOYED_SHA,
      useFactory: () => process.env.GIT_SHA,
    },
  ],
})
export class TemplateVersionModule {}
