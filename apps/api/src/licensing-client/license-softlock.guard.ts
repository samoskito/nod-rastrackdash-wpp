import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { LicenseClientService } from "./license-client.service";
import type { LicenseLockReason, LicenseLockState } from "./license-client.types";

/** HTTP methods that never mutate state — soft-lock never blocks these. */
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Path prefixes reachable even while blocked: health checks, the license
 * status/activate endpoints themselves (so an operator can see why they're
 * locked and reactivate), and auth (so they can still sign in to see it).
 */
const EXEMPT_PATH_PREFIXES = ["/health", "/license-client", "/auth"];

/** How long the guard trusts a previous getLockState() lookup before re-checking. */
const STATE_CACHE_TTL_MS = 60_000;

/** pt-BR copy shown to the student for each lock reason. */
const LOCK_MESSAGES: Record<LicenseLockReason, string> = {
  license_required:
    "Licença não ativada — ative a licença em /backoffice/license para liberar as operações de escrita.",
  activation_failed:
    "Falha ao ativar a licença — confira LICENSE_KEY e LICENSE_ACCOUNT_IDENTITY e ative novamente em /backoffice/license.",
  revoked: "Licença bloqueada — operações de escrita desativadas. Contate o suporte / reative.",
  expired: "Licença bloqueada — operações de escrita desativadas. Contate o suporte / reative.",
  grace_exceeded: "Licença bloqueada — operações de escrita desativadas. Contate o suporte / reative.",
};

/**
 * Global APP_GUARD: locks mutating requests (POST/PATCH/PUT/DELETE) with HTTP
 * 423 whenever the license is not usable — never activated, activation
 * failed, revoked/expired or past the grace window. Reads always pass. Only
 * inert (licensing off) when no LICENSE_SERVER_URL is configured — see
 * .claude-task-license-hard-lock.md.
 */
@Injectable()
export class LicenseSoftlockGuard implements CanActivate, OnModuleInit {
  private readonly logger = new Logger(LicenseSoftlockGuard.name);
  private cache: LicenseLockState | null = null;
  private cachedAt = 0;

  constructor(@Inject(LicenseClientService) private readonly licenseClientService: LicenseClientService) {}

  async onModuleInit(): Promise<void> {
    const decision = await this.licenseClientService.getLockState();
    if (decision.inert) {
      this.logger.log("license guard inert (no LICENSE_SERVER_URL configured)");
      return;
    }
    if (decision.locked) {
      this.logger.warn(`license guard locked: ${decision.reason}`);
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
    if (!decision.locked) {
      return true;
    }

    throw new HttpException(buildLockedBody(decision), 423);
  }

  private async getDecision(): Promise<LicenseLockState> {
    const now = Date.now();
    if (this.cache && now - this.cachedAt < STATE_CACHE_TTL_MS) {
      return this.cache;
    }

    this.cache = await this.licenseClientService.getLockState();
    this.cachedAt = now;
    return this.cache;
  }
}

function isExemptPath(path: string): boolean {
  return EXEMPT_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function buildLockedBody(decision: LicenseLockState) {
  const reason: LicenseLockReason = decision.reason ?? "revoked";
  return {
    statusCode: 423,
    error: "License Locked",
    message: LOCK_MESSAGES[reason],
    reason,
    licenseStatus: decision.state.status,
  };
}
