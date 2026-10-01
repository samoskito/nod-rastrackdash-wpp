import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformAdminService } from "../../src/auth/platform-admin.service";
import {
  GITHUB_MAIN_COMMIT_URL,
  GITHUB_MAIN_TIMEOUT_MS,
  githubCompareUrl,
  TEMPLATE_UPDATE_GUIDE_URL,
} from "../../src/template-version/template-version.constants";
import { TemplateVersionController } from "../../src/template-version/template-version.controller";
import { TemplateVersionModule } from "../../src/template-version/template-version.module";
import { TemplateVersionService } from "../../src/template-version/template-version.service";

const mainSha = "a".repeat(40);
const deployedSha = "b".repeat(40);

function githubResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function mainResponse(sha = mainSha): Response {
  return githubResponse({ sha });
}

function aheadResponse(aheadBy = 1, behindBy = 0): Response {
  return githubResponse({
    status: "ahead",
    ahead_by: aheadBy,
    behind_by: behindBy,
  });
}

async function flushPromises() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TemplateVersionService", () => {
  it("returns unknown when GIT_SHA is empty", async () => {
    const service = new TemplateVersionService(
      vi.fn().mockResolvedValue(mainResponse()),
      "   ",
    );

    await expect(service.getVersion()).resolves.toEqual({
      deployedSha: null,
      latestMainSha: mainSha,
      status: "unknown",
      updateGuideUrl: TEMPLATE_UPDATE_GUIDE_URL,
    });
  });

  it("returns current only for equal full SHAs", async () => {
    const githubFetch = vi.fn().mockResolvedValue(mainResponse());
    const service = new TemplateVersionService(githubFetch, mainSha);

    await expect(service.getVersion()).resolves.toMatchObject({
      deployedSha: mainSha,
      latestMainSha: mainSha,
      status: "current",
    });
    expect(githubFetch).toHaveBeenCalledTimes(1);
    expect(githubFetch).toHaveBeenCalledWith(
      GITHUB_MAIN_COMMIT_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns behind only after GitHub proves main is ahead", async () => {
    const githubFetch = vi
      .fn()
      .mockResolvedValueOnce(mainResponse())
      .mockResolvedValueOnce(aheadResponse(3, 0));
    const service = new TemplateVersionService(githubFetch, deployedSha);

    await expect(service.getVersion()).resolves.toMatchObject({
      deployedSha,
      latestMainSha: mainSha,
      status: "behind",
    });
    expect(githubFetch).toHaveBeenNthCalledWith(
      2,
      githubCompareUrl(deployedSha, mainSha),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    ["installed SHA is ahead of main", { status: "behind", ahead_by: 0, behind_by: 3 }],
    ["branches diverged", { status: "diverged", ahead_by: 2, behind_by: 3 }],
  ])("returns unknown when %s", async (_description, compareBody) => {
    const service = new TemplateVersionService(
      vi
        .fn()
        .mockResolvedValueOnce(mainResponse())
        .mockResolvedValueOnce(githubResponse(compareBody)),
      deployedSha,
    );

    await expect(service.getVersion()).resolves.toMatchObject({
      latestMainSha: mainSha,
      status: "unknown",
    });
  });

  it.each([mainSha.slice(0, 12), "not-a-git-sha", "a".repeat(39)])(
    "returns unknown for abbreviated or invalid deployed SHA %s",
    async (configuredSha) => {
      const githubFetch = vi.fn().mockResolvedValue(mainResponse());
      const service = new TemplateVersionService(githubFetch, configuredSha);

      await expect(service.getVersion()).resolves.toMatchObject({
        deployedSha: configuredSha,
        latestMainSha: mainSha,
        status: "unknown",
      });
      expect(githubFetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([404, 429, 503])(
    "returns unknown when the main commit request returns %i",
    async (status) => {
      const service = new TemplateVersionService(
        vi.fn().mockResolvedValue(githubResponse({}, status)),
        deployedSha,
      );

      await expect(service.getVersion()).resolves.toMatchObject({
        latestMainSha: null,
        status: "unknown",
      });
    },
  );

  it("returns unknown when the main commit request fails on the network", async () => {
    const service = new TemplateVersionService(
      vi.fn().mockRejectedValue(new Error("network unavailable")),
      deployedSha,
    );

    await expect(service.getVersion()).resolves.toMatchObject({
      latestMainSha: null,
      status: "unknown",
    });
  });

  it("returns unknown when the compare request fails", async () => {
    const service = new TemplateVersionService(
      vi
        .fn()
        .mockResolvedValueOnce(mainResponse())
        .mockResolvedValueOnce(githubResponse({}, 503)),
      deployedSha,
    );

    await expect(service.getVersion()).resolves.toMatchObject({
      latestMainSha: mainSha,
      status: "unknown",
    });
  });

  it("returns unknown when a GitHub request times out", async () => {
    vi.useFakeTimers();
    const githubFetch = vi.fn<typeof fetch>(async (url, init) => {
      if (url === GITHUB_MAIN_COMMIT_URL) return mainResponse();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("request aborted"));
        });
      });
    });
    const service = new TemplateVersionService(githubFetch, deployedSha);
    const result = service.getVersion();

    await flushPromises();
    await vi.advanceTimersByTimeAsync(GITHUB_MAIN_TIMEOUT_MS);

    await expect(result).resolves.toMatchObject({
      latestMainSha: mainSha,
      status: "unknown",
    });
    expect(githubFetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each([
    ["malformed main envelope", [], undefined],
    [
      "malformed compare fields",
      { sha: mainSha },
      { status: "ahead", ahead_by: 1, behind_by: "0" },
    ],
    [
      "contradictory compare fields",
      { sha: mainSha },
      { status: "ahead", ahead_by: 1, behind_by: 1 },
    ],
  ])("returns unknown for %s", async (_description, mainBody, compareBody) => {
    const githubFetch = vi.fn().mockResolvedValueOnce(githubResponse(mainBody));
    if (compareBody !== undefined) {
      githubFetch.mockResolvedValueOnce(githubResponse(compareBody));
    }
    const service = new TemplateVersionService(githubFetch, deployedSha);

    await expect(service.getVersion()).resolves.toMatchObject({
      latestMainSha: Array.isArray(mainBody) ? null : mainSha,
      status: "unknown",
    });
  });

  it("caches both main and compare results", async () => {
    const githubFetch = vi
      .fn()
      .mockResolvedValueOnce(mainResponse())
      .mockResolvedValueOnce(aheadResponse());
    const service = new TemplateVersionService(githubFetch, deployedSha);

    await service.getVersion();
    await service.getVersion();

    expect(githubFetch).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent main and compare requests", async () => {
    let resolveMain: (response: Response) => void;
    let resolveCompare: (response: Response) => void;
    const mainPending = new Promise<Response>((resolve) => {
      resolveMain = resolve;
    });
    const comparePending = new Promise<Response>((resolve) => {
      resolveCompare = resolve;
    });
    const githubFetch = vi
      .fn()
      .mockReturnValueOnce(mainPending)
      .mockReturnValueOnce(comparePending);
    const service = new TemplateVersionService(githubFetch, deployedSha);

    const first = service.getVersion();
    const second = service.getVersion();
    expect(githubFetch).toHaveBeenCalledTimes(1);

    resolveMain!(mainResponse());
    resolveCompare!(aheadResponse());
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "behind" }),
      expect.objectContaining({ status: "behind" }),
    ]);
    expect(githubFetch).toHaveBeenCalledTimes(2);
  });
});

describe("TemplateVersionModule", () => {
  it("compiles its production DI graph without initializing database lifecycle hooks", async () => {
    const module = await Test.createTestingModule({
      imports: [TemplateVersionModule],
    }).compile();

    expect(module.get(TemplateVersionService)).toBeInstanceOf(
      TemplateVersionService,
    );
    expect(module.get(TemplateVersionController)).toBeInstanceOf(
      TemplateVersionController,
    );

    await module.close();
  });
});

describe("TemplateVersionController", () => {
  it("requires a platform owner", async () => {
    const platformAdmin = {
      assertPlatformOwner: vi.fn().mockRejectedValue(new ForbiddenException()),
    } as unknown as PlatformAdminService;
    const version = { getVersion: vi.fn() } as unknown as TemplateVersionService;
    const controller = new TemplateVersionController(platformAdmin, version);

    await expect(controller.get("operator-session")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(version.getVersion).not.toHaveBeenCalled();
  });

  it("returns the version only after owner authorization", async () => {
    const platformAdmin = {
      assertPlatformOwner: vi.fn().mockResolvedValue({ id: "owner_1" }),
    } as unknown as PlatformAdminService;
    const result = {
      deployedSha: mainSha,
      latestMainSha: mainSha,
      status: "current" as const,
      updateGuideUrl: TEMPLATE_UPDATE_GUIDE_URL,
    };
    const version = {
      getVersion: vi.fn().mockResolvedValue(result),
    } as unknown as TemplateVersionService;
    const controller = new TemplateVersionController(platformAdmin, version);

    await expect(controller.get("owner-session")).resolves.toEqual(result);
    expect(platformAdmin.assertPlatformOwner).toHaveBeenCalledWith("owner-session");
  });
});
