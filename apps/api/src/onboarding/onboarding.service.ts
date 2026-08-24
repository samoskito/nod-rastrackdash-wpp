import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/session.types";
import { PrismaService } from "../common/prisma/prisma.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { LicenseClientService } from "../licensing-client/license-client.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import type { OnboardingChecks, OnboardingStatusDto } from "./onboarding.types";

const TOTAL_CHECKS = 4;

/**
 * Computes the onboarding checklist from real signals — see
 * .claude-task-f6-3-setup-docs.md #2. Every check fails open to `false` on
 * error; this endpoint is informational only and must never 500 the
 * checklist UI because a downstream dependency hiccuped.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LicenseClientService) private readonly licenseClient: LicenseClientService,
    @Optional() @Inject(IntegrationsService) private readonly integrations?: IntegrationsService,
    @Optional() @Inject(WorkspacesService) private readonly workspaces?: WorkspacesService,
  ) {}

  async getStatus(authenticated: AuthenticatedUser): Promise<OnboardingStatusDto> {
    const hasWorkspace = authenticated.workspaces.length > 0;
    const [database, licenseActive, metaConnected] = await Promise.all([
      this.checkDatabase(),
      this.checkLicense(),
      hasWorkspace ? this.checkMetaConnected(authenticated) : Promise.resolve(false),
    ]);

    const checks: OnboardingChecks = { database, licenseActive, metaConnected, hasWorkspace };
    const completedCount = Object.values(checks).filter(Boolean).length;

    return { checks, completedCount, totalCount: TOTAL_CHECKS };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private async checkLicense(): Promise<boolean> {
    try {
      const state = await this.licenseClient.getState();
      return state.usable;
    } catch (error) {
      this.logger.warn(
        `onboarding_license_check_failed:${error instanceof Error ? error.message : "unknown"}`,
      );
      return false;
    }
  }

  private async checkMetaConnected(authenticated: AuthenticatedUser): Promise<boolean> {
    if (!this.integrations || !this.workspaces) {
      return false;
    }

    try {
      const workspace = this.workspaces.getCurrentWorkspace(authenticated);
      const connection = await this.integrations.getMetaConnection(workspace.id);
      return connection.status === "connected";
    } catch {
      // No active workspace, permission issue, or Meta API hiccup — none of
      // these should block the rest of the checklist from rendering.
      return false;
    }
  }
}
