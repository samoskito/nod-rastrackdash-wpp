import { Inject, Injectable } from "@nestjs/common";
import {
  templateVersionSchema,
  type TemplateVersionDto,
} from "@wpptrack/shared";
import {
  GITHUB_MAIN_CACHE_TTL_MS,
  GITHUB_MAIN_COMMIT_URL,
  GITHUB_MAIN_TIMEOUT_MS,
  githubCompareUrl,
  TEMPLATE_UPDATE_GUIDE_URL,
  TEMPLATE_VERSION_DEPLOYED_SHA,
  TEMPLATE_VERSION_GITHUB_FETCH,
} from "./template-version.constants";

type GithubFetch = typeof fetch;

type VersionResolution = {
  latestMainSha: string | null;
  status: TemplateVersionDto["status"];
};

type CachedVersionResolution = VersionResolution & {
  expiresAt: number;
};

@Injectable()
export class TemplateVersionService {
  private cache: CachedVersionResolution | null = null;
  private fetchInFlight: Promise<VersionResolution> | null = null;

  constructor(
    @Inject(TEMPLATE_VERSION_GITHUB_FETCH)
    private readonly githubFetch: GithubFetch,
    @Inject(TEMPLATE_VERSION_DEPLOYED_SHA)
    private readonly configuredDeployedSha: string | undefined,
  ) {}

  async getVersion(): Promise<TemplateVersionDto> {
    const deployedSha = normalizeConfiguredSha(this.configuredDeployedSha);
    const resolution = await this.getVersionResolution(deployedSha);

    return templateVersionSchema.parse({
      deployedSha,
      latestMainSha: resolution.latestMainSha,
      status: resolution.status,
      updateGuideUrl: TEMPLATE_UPDATE_GUIDE_URL,
    });
  }

  private async getVersionResolution(
    deployedSha: string | null,
  ): Promise<VersionResolution> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache;

    if (!this.fetchInFlight) {
      this.fetchInFlight = this.resolveVersion(deployedSha)
        .then((resolution) => {
          this.cache = {
            ...resolution,
            expiresAt: Date.now() + GITHUB_MAIN_CACHE_TTL_MS,
          };
          return resolution;
        })
        .finally(() => {
          this.fetchInFlight = null;
        });
    }

    return this.fetchInFlight;
  }

  private async resolveVersion(
    deployedSha: string | null,
  ): Promise<VersionResolution> {
    const latestMainSha = await this.fetchLatestMainSha();
    if (!latestMainSha || !isFullGitSha(deployedSha)) {
      return { latestMainSha, status: "unknown" };
    }

    if (deployedSha === latestMainSha) {
      return { latestMainSha, status: "current" };
    }

    const isBehind = await this.isDeployedShaBehind(deployedSha, latestMainSha);
    return {
      latestMainSha,
      status: isBehind ? "behind" : "unknown",
    };
  }

  private async fetchLatestMainSha(): Promise<string | null> {
    const body = await this.fetchGithubJson(GITHUB_MAIN_COMMIT_URL);
    return parseGithubCommitSha(body);
  }

  private async isDeployedShaBehind(
    deployedSha: string,
    latestMainSha: string,
  ): Promise<boolean> {
    const body = await this.fetchGithubJson(
      githubCompareUrl(deployedSha, latestMainSha),
    );
    return isAheadCompareResponse(body);
  }

  private async fetchGithubJson(url: string): Promise<unknown | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GITHUB_MAIN_TIMEOUT_MS);

    try {
      const response = await this.githubFetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "rastrackdash-template-version",
        },
        signal: controller.signal,
      });

      if (!response.ok) return null;
      return await response.json();
    } catch {
      // GitHub availability must never be mistaken for an up-to-date template.
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeConfiguredSha(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sha = value.trim().toLowerCase();
  return sha.length > 0 ? sha : null;
}

function parseGithubCommitSha(body: unknown): string | null {
  if (!isRecord(body) || !isFullGitSha(body.sha)) return null;
  return body.sha;
}

function isAheadCompareResponse(body: unknown): boolean {
  return (
    isRecord(body) &&
    body.status === "ahead" &&
    isPositiveSafeInteger(body.ahead_by) &&
    body.behind_by === 0
  );
}

function isFullGitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function isPositiveSafeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
