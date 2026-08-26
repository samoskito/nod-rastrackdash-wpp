import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  bootstrapPlatformAdminUser,
  validatePlatformAdminBootstrapInput,
} from "./platform-admin-bootstrap";

@Injectable()
export class PlatformAdminEnvBootstrapService {
  private readonly logger = new Logger(PlatformAdminEnvBootstrapService.name);

  constructor(private readonly prisma: PrismaService) {}

  async bootstrap(): Promise<void> {
    const configuredEmail = process.env.SETUP_PLATFORM_ADMIN_EMAIL?.trim();
    const password = process.env.SETUP_PLATFORM_ADMIN_PASSWORD;

    if (!configuredEmail || !password?.trim()) {
      return;
    }

    let email: string;
    try {
      email = validatePlatformAdminBootstrapInput({
        email: configuredEmail,
        password,
      });
    } catch {
      this.logger.error({
        event: "platform_admin_env_bootstrap_invalid_configuration",
      });
      return;
    }

    await this.bootstrapValidated(email, password);
  }

  private async bootstrapValidated(
    email: string,
    password: string,
  ): Promise<void> {
    try {
      const existing = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true, platformRole: true },
      });

      if (existing?.platformRole === "platform_owner") {
        this.logger.log({
          event: "platform_admin_env_bootstrap_skipped_existing_owner",
          email,
        });
        return;
      }

      const confirmExisting =
        process.env.SETUP_PLATFORM_ADMIN_CONFIRM_EXISTING === "true";
      if (existing && !confirmExisting) {
        this.logger.warn({
          event:
            "platform_admin_env_bootstrap_existing_user_requires_confirmation",
          email,
          requiredEnv: "SETUP_PLATFORM_ADMIN_CONFIRM_EXISTING=true",
        });
        return;
      }

      const result = await bootstrapPlatformAdminUser(this.prisma as never, {
        email,
        password,
        confirmExisting,
      });

      this.logger.log({
        event: "platform_admin_env_bootstrap_completed",
        email: result.email,
        outcome: result.createdUser ? "created" : "promoted",
      });
    } catch {
      // The CLI remains available if the database is temporarily unavailable.
      this.logger.error({ event: "platform_admin_env_bootstrap_failed" });
    }
  }
}
