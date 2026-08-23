import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { LicenseClientService } from "./license-client.service";
import type { LicenseBlockReason, LicenseRuntimeState } from "./license-client.types";

/** HTTP methods that never mutate state — soft-lock never blocks these. */
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Path prefixes reachable even while blocked: health checks, the license
 * status/activate endpoints themselves (so an operator can see why they're
 * locked and reactivate), and auth (so they can still sign in to see it).
 */
const EXEMPT_PATH_PREFIXES = ["/health", "/license-client", "/auth"];

/** How long the guard trusts a previous isInert()/getState() lookup before re-checking. */
const STATE_CACHE_TTL_MS = 60_000;

const LOCK_MESSAGE = "Licença bloqueada — operações de escrita desativadas. Contate o suporte / reative.";

type Decision = { inert: boolean; state: LicenseRuntimeState | null };

/**
 * Global APP_GUARD: soft-locks mutating requests (POST/PATCH/PUT/DELETE) with
 * HTTP 423 once the license status is "blocked". Reads always pass. Inert
 * (no license server configured, or never activated + no key) when the
 * template is used without licensing — see .claude-task-f4-2-softlock.md.
 */
@Injectable()
export class LicenseSoftlockGuard implements CanActivate, OnModuleInit {
  private readonly logger = new Logger(LicenseSoftlockGuard.name);
  private cache: Decision | null = null;
  private cachedAt = 0;

  constructor(@Inject(LicenseClientService) private readonly licenseClientService: LicenseClientService) {}

  async onModuleInit(): Promise<void> {
    if (await this.licenseClientService.isInert()) {
      this.logger.log("license guard inert");
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest() as { method: string; path?: string; url?: string };
    if (READ_ONLY_METHODS.has(request.method)) {
      return true;
    }
    if (isExemptPath(request.path ?? request.url ?? "")) {
      return true;
    }

    const decision = await this.getDecision();
    if (decision.inert || decision.state?.status !== "blocked") {
      return true;
    }

    throw new HttpException(buildLockedBody(decision.state), 423);
  }

  private async getDecision(): Promise<Decision> {
    const now = Date.now();
    if (this.cache && now - this.cachedAt < STATE_CACHE_TTL_MS) {
      return this.cache;
    }

    const inert = await this.licenseClientService.isInert();
    const state = inert ? null : await this.licenseClientService.getState();
    this.cache = { inert, state };
    this.cachedAt = now;
    return this.cache;
  }
}

function isExemptPath(path: string): boolean {
  return EXEMPT_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function buildLockedBody(state: LicenseRuntimeState) {
  const reason: LicenseBlockReason = state.reason ?? "revoked";
  return {
    statusCode: 423,
    error: "License Locked",
    message: LOCK_MESSAGE,
    reason,
    licenseStatus: "blocked" as const,
  };
}
