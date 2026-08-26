import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { PasswordService } from "./password.service";
import { PlatformAdminEnvBootstrapService } from "./platform-admin-env-bootstrap.service";
import { PlatformAdminService } from "./platform-admin.service";
import { BackofficePlatformUsersController } from "./backoffice-platform-users.controller";

@Module({
  imports: [PrismaModule],
  controllers: [AuthController, BackofficePlatformUsersController],
  providers: [
    AuthService,
    PasswordService,
    PlatformAdminService,
    PlatformAdminEnvBootstrapService,
  ],
  exports: [AuthService, PasswordService, PlatformAdminService],
})
export class AuthModule {}
