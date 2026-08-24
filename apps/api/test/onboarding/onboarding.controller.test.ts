import { UnauthorizedException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { AuthService } from "../../src/auth/auth.service";
import { OnboardingController } from "../../src/onboarding/onboarding.controller";
import type { OnboardingService } from "../../src/onboarding/onboarding.service";
import type { OnboardingStatusDto } from "../../src/onboarding/onboarding.types";

function fakeStatus(overrides: Partial<OnboardingStatusDto> = {}): OnboardingStatusDto {
  return {
    checks: {
      database: true,
      licenseActive: true,
      metaConnected: false,
      hasWorkspace: true,
    },
    completedCount: 3,
    totalCount: 4,
    ...overrides,
  };
}

describe("OnboardingController", () => {
  it("GET status resolves the session then delegates to the onboarding service", async () => {
    const authenticated = { user: { id: "user-1" }, workspaces: [] } as never;
    const authService = {
      getSession: vi.fn().mockResolvedValue(authenticated),
    } as unknown as AuthService;
    const onboardingService = {
      getStatus: vi.fn().mockResolvedValue(fakeStatus()),
    } as unknown as OnboardingService;
    const controller = new OnboardingController(authService, onboardingService);

    const response = await controller.getStatus("refresh-token");

    expect(authService.getSession).toHaveBeenCalledWith("refresh-token");
    expect(onboardingService.getStatus).toHaveBeenCalledWith(authenticated);
    expect(response).toEqual(fakeStatus());
  });

  it("propagates UnauthorizedException when the session is invalid", async () => {
    const authService = {
      getSession: vi.fn().mockRejectedValue(new UnauthorizedException("Sessao invalida")),
    } as unknown as AuthService;
    const onboardingService = {
      getStatus: vi.fn(),
    } as unknown as OnboardingService;
    const controller = new OnboardingController(authService, onboardingService);

    await expect(controller.getStatus("bad-token")).rejects.toBeInstanceOf(UnauthorizedException);
    expect(onboardingService.getStatus).not.toHaveBeenCalled();
  });
});
