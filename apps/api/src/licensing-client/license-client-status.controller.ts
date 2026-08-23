import { Body, Controller, ForbiddenException, Get, HttpCode, HttpException, HttpStatus, Inject, Post } from "@nestjs/common";
import { LicenseAccountMismatchError } from "./license-client-errors";
import { LicenseClientService } from "./license-client.service";
import type { LicenseRuntimeState } from "./license-client.types";

/** Minimum time between two activation attempts — light in-memory throttle (see #3 in the task spec). */
const ACTIVATE_MIN_INTERVAL_MS = 5_000;

type PublicLicenseStatus = Pick<
  LicenseRuntimeState,
  "status" | "softLock" | "hardLock" | "usable" | "expiresAt" | "validUntil" | "source"
>;

/**
 * Public (no auth) — coarse license status only, no key material or account
 * identity. Exempted from the soft-lock guard so it stays reachable while
 * blocked. See .claude-task-f4-2-softlock.md #2/#3.
 */
@Controller("license-client")
export class LicenseClientStatusController {
  private lastActivateAttemptAt = 0;

  constructor(@Inject(LicenseClientService) private readonly licenseClientService: LicenseClientService) {}

  @Get("status")
  async getStatus(): Promise<PublicLicenseStatus> {
    const state = await this.licenseClientService.getState();
    return toPublicStatus(state);
  }

  @Post("activate")
  @HttpCode(HttpStatus.OK)
  async postActivate(@Body() body: { key?: string }): Promise<PublicLicenseStatus> {
    this.enforceRateLimit();
    try {
      const state = await this.licenseClientService.activate({ key: body?.key });
      return toPublicStatus(state);
    } catch (error) {
      if (error instanceof LicenseAccountMismatchError) {
        throw new ForbiddenException(error.message);
      }
      throw error;
    }
  }

  private enforceRateLimit(): void {
    const now = Date.now();
    if (now - this.lastActivateAttemptAt < ACTIVATE_MIN_INTERVAL_MS) {
      throw new HttpException("Muitas tentativas de ativação. Aguarde alguns segundos.", HttpStatus.TOO_MANY_REQUESTS);
    }
    this.lastActivateAttemptAt = now;
  }
}

function toPublicStatus(state: LicenseRuntimeState): PublicLicenseStatus {
  return {
    status: state.status,
    softLock: state.softLock,
    hardLock: state.hardLock,
    usable: state.usable,
    expiresAt: state.expiresAt,
    validUntil: state.validUntil,
    source: state.source,
  };
}
