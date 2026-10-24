import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";

export const META_CLOUD_WABA_RATE_LIMITS = Symbol("META_CLOUD_WABA_RATE_LIMITS");

export type MetaCloudWabaRateLimits = {
  /** Intervalo mínimo entre chamadas do mesmo usuário. */
  perUserMinIntervalMs: number;
  /** Teto de chamadas por workspace na janela. */
  perWorkspaceMax: number;
  perWorkspaceWindowMs: number;
  now: () => number;
};

export const defaultMetaCloudWabaRateLimits: MetaCloudWabaRateLimits = {
  perUserMinIntervalMs: 4_000,
  perWorkspaceMax: 20,
  perWorkspaceWindowMs: 60 * 60 * 1000,
  now: () => Date.now(),
};

/**
 * Limite em memória (por processo), no padrão do enforceMutationRateLimit das
 * conexões WhatsApp: protege a cota da Graph do aluno e evita cliques em
 * sequência. Consulta e inscrição contam juntas.
 */
@Injectable()
export class MetaCloudWabaRateLimiter {
  private readonly lastByUser = new Map<string, number>();
  private readonly hitsByWorkspace = new Map<string, number[]>();
  private readonly limits: MetaCloudWabaRateLimits;

  constructor(
    @Optional()
    @Inject(META_CLOUD_WABA_RATE_LIMITS)
    limits?: Partial<MetaCloudWabaRateLimits>,
  ) {
    this.limits = { ...defaultMetaCloudWabaRateLimits, ...(limits ?? {}) };
  }

  enforce(userId: string, workspaceId: string): void {
    const now = this.limits.now();
    const previous = this.lastByUser.get(userId);
    if (previous !== undefined && now - previous < this.limits.perUserMinIntervalMs) {
      throw rateLimited(
        "Muitas consultas seguidas da WABA. Aguarde alguns segundos e tente de novo.",
      );
    }

    const windowStart = now - this.limits.perWorkspaceWindowMs;
    const hits = (this.hitsByWorkspace.get(workspaceId) ?? []).filter(
      (at) => at > windowStart,
    );
    if (hits.length >= this.limits.perWorkspaceMax) {
      this.hitsByWorkspace.set(workspaceId, hits);
      throw rateLimited(
        "Este workspace atingiu o limite de consultas e inscrições da WABA na última hora. Aguarde um pouco e tente de novo.",
      );
    }

    hits.push(now);
    this.hitsByWorkspace.set(workspaceId, hits);
    this.lastByUser.set(userId, now);
  }
}

function rateLimited(message: string): HttpException {
  return new HttpException(
    { statusCode: HttpStatus.TOO_MANY_REQUESTS, message, code: "rate_limited" },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
