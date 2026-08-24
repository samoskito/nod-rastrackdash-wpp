import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../../src/auth/session.types";
import type { IntegrationsService } from "../../src/integrations/integrations.service";
import type { LicenseClientService } from "../../src/licensing-client/license-client.service";
import type { LicenseRuntimeState } from "../../src/licensing-client/license-client.types";
import { OnboardingService } from "../../src/onboarding/onboarding.service";
import type { PrismaService } from "../../src/common/prisma/prisma.service";
import type { WorkspacesService } from "../../src/workspaces/workspaces.service";

function authenticatedUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    user: {
      id: "user-1",
      email: "student@example.com",
      name: "Student",
      authProvider: "email",
      emailVerifiedAt: new Date(),
    },
    activeWorkspaceId: "workspace-1",
    workspaces: [
      {
        id: "workspace-1",
        name: "Minha Agencia",
        slug: "minha-agencia",
        role: "owner",
        operationalStatus: "active",
      },
    ],
    ...overrides,
  };
}

function licenseState(overrides: Partial<LicenseRuntimeState> = {}): LicenseRuntimeState {
  return {
    status: "active",
    softLock: false,
    hardLock: false,
    usable: true,
    expiresAt: null,
    validUntil: null,
    source: "cache",
    reason: null,
    ...overrides,
  };
}

function fakePrisma(overrides: { queryRaw?: () => Promise<unknown> } = {}): PrismaService {
  return {
    $queryRaw: overrides.queryRaw ?? vi.fn().mockResolvedValue([{ "?column?": 1 }]),
  } as unknown as PrismaService;
}

function fakeLicenseClient(overrides: { getState?: () => Promise<LicenseRuntimeState> } = {}): LicenseClientService {
  return {
    getState: overrides.getState ? vi.fn(overrides.getState) : vi.fn().mockResolvedValue(licenseState()),
  } as unknown as LicenseClientService;
}

function fakeIntegrations(status: "connected" | "not_connected" | "error" = "connected"): IntegrationsService {
  return {
    getMetaConnection: vi.fn().mockResolvedValue({
      workspaceId: "workspace-1",
      status,
      tokenType: null,
      scopes: [],
      expiresAt: null,
      connectedAt: null,
      selectedBusinessId: null,
      selectedAdAccountId: null,
      selectedPixelId: null,
      capiTokenConfigured: false,
    }),
  } as unknown as IntegrationsService;
}

function fakeWorkspaces(): WorkspacesService {
  return {
    getCurrentWorkspace: vi.fn().mockReturnValue({
      id: "workspace-1",
      name: "Minha Agencia",
      slug: "minha-agencia",
      role: "owner",
      operationalStatus: "active",
      permissions: {},
      accessMode: "member",
      platformRole: null,
    }),
  } as unknown as WorkspacesService;
}

describe("OnboardingService", () => {
  it("reports every check as true when everything is healthy", async () => {
    const service = new OnboardingService(
      fakePrisma(),
      fakeLicenseClient(),
      fakeIntegrations("connected"),
      fakeWorkspaces(),
    );

    const status = await service.getStatus(authenticatedUser());

    expect(status).toEqual({
      checks: {
        database: true,
        licenseActive: true,
        metaConnected: true,
        hasWorkspace: true,
      },
      completedCount: 4,
      totalCount: 4,
    });
  });

  it("marks database as false when the query fails", async () => {
    const service = new OnboardingService(
      fakePrisma({ queryRaw: () => Promise.reject(new Error("connection refused")) }),
      fakeLicenseClient(),
      fakeIntegrations("connected"),
      fakeWorkspaces(),
    );

    const status = await service.getStatus(authenticatedUser());

    expect(status.checks.database).toBe(false);
    expect(status.completedCount).toBe(3);
  });

  it("marks licenseActive as false for a grace-window-exceeded/blocked license", async () => {
    const service = new OnboardingService(
      fakePrisma(),
      fakeLicenseClient({ getState: () => Promise.resolve(licenseState({ status: "blocked", usable: false })) }),
      fakeIntegrations("connected"),
      fakeWorkspaces(),
    );

    const status = await service.getStatus(authenticatedUser());

    expect(status.checks.licenseActive).toBe(false);
  });

  it("treats the license as active during the grace window", async () => {
    const service = new OnboardingService(
      fakePrisma(),
      fakeLicenseClient({ getState: () => Promise.resolve(licenseState({ status: "grace", usable: true })) }),
      fakeIntegrations("connected"),
      fakeWorkspaces(),
    );

    const status = await service.getStatus(authenticatedUser());

    expect(status.checks.licenseActive).toBe(true);
  });

  it("marks metaConnected as false when Meta is not connected", async () => {
    const service = new OnboardingService(
      fakePrisma(),
      fakeLicenseClient(),
      fakeIntegrations("not_connected"),
      fakeWorkspaces(),
    );

    const status = await service.getStatus(authenticatedUser());

    expect(status.checks.metaConnected).toBe(false);
  });

  it("marks hasWorkspace and metaConnected as false when the user has no workspaces", async () => {
    const service = new OnboardingService(
      fakePrisma(),
      fakeLicenseClient(),
      fakeIntegrations("connected"),
      fakeWorkspaces(),
    );

    const status = await service.getStatus(authenticatedUser({ workspaces: [], activeWorkspaceId: null }));

    expect(status.checks.hasWorkspace).toBe(false);
    expect(status.checks.metaConnected).toBe(false);
    expect(status.completedCount).toBe(2);
  });

  it("fails the meta check open (false) instead of throwing when the integrations service errors", async () => {
    const integrations = {
      getMetaConnection: vi.fn().mockRejectedValue(new Error("meta api down")),
    } as unknown as IntegrationsService;
    const service = new OnboardingService(fakePrisma(), fakeLicenseClient(), integrations, fakeWorkspaces());

    const status = await service.getStatus(authenticatedUser());

    expect(status.checks.metaConnected).toBe(false);
  });

  it("degrades gracefully to metaConnected=false when integrations/workspaces are not wired (public/minimal setups)", async () => {
    const service = new OnboardingService(fakePrisma(), fakeLicenseClient());

    const status = await service.getStatus(authenticatedUser());

    expect(status.checks.metaConnected).toBe(false);
    expect(status.checks.hasWorkspace).toBe(true);
  });
});
