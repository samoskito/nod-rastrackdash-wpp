import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.service";
import { PlatformAdminService } from "../src/auth/platform-admin.service";
import { PlatformWorkspaceAccessService } from "../src/workspaces/platform-workspace-access.service";
import { WorkspacesController } from "../src/workspaces/workspaces.controller";
import { WorkspacesService } from "../src/workspaces/workspaces.service";

describe("POST /workspaces/active backoffice selection", () => {
  it("lets a platform admin select a workspace from the backoffice catalogue", async () => {
    const authenticated = { user: { id: "admin_1" } };
    const currentWorkspace = { id: "workspace_client" };
    const auth = {
      setActiveWorkspace: vi.fn(),
      setSupportWorkspace: vi.fn(async () => undefined),
      getSession: vi.fn(async () => authenticated),
    } as unknown as AuthService;
    const platformAdmin = {
      assertPlatformAdmin: vi.fn(async () => ({ id: "admin_1" })),
    } as unknown as PlatformAdminService;
    const workspaceAccess = {
      assertWorkspaceAvailableForBackoffice: vi.fn(async () => undefined),
    } as unknown as PlatformWorkspaceAccessService;
    const workspaces = {
      getCurrentWorkspace: vi.fn(() => currentWorkspace),
    } as unknown as WorkspacesService;
    const controller = new WorkspacesController(
      auth,
      platformAdmin,
      workspaces,
      workspaceAccess,
    );

    await expect(
      controller.setActive("refresh-token", {
        workspaceId: "workspace_client",
        backoffice: true,
      }),
    ).resolves.toEqual(currentWorkspace);

    expect(platformAdmin.assertPlatformAdmin).toHaveBeenCalledWith(
      "refresh-token",
    );
    expect(
      workspaceAccess.assertWorkspaceAvailableForBackoffice,
    ).toHaveBeenCalledWith("workspace_client");
    expect(auth.setSupportWorkspace).toHaveBeenCalledWith(
      "refresh-token",
      "workspace_client",
    );
    expect(auth.setActiveWorkspace).not.toHaveBeenCalled();
  });

  it("does not bypass membership selection outside the marked backoffice flow", async () => {
    const auth = {
      setActiveWorkspace: vi.fn(async () => undefined),
      setSupportWorkspace: vi.fn(),
      getSession: vi.fn(async () => ({ user: { id: "member_1" } })),
    } as unknown as AuthService;
    const platformAdmin = {
      assertPlatformAdmin: vi.fn(),
    } as unknown as PlatformAdminService;
    const workspaceAccess = {
      assertWorkspaceAvailableForBackoffice: vi.fn(),
    } as unknown as PlatformWorkspaceAccessService;
    const workspaces = {
      getCurrentWorkspace: vi.fn(() => ({ id: "workspace_member" })),
    } as unknown as WorkspacesService;
    const controller = new WorkspacesController(
      auth,
      platformAdmin,
      workspaces,
      workspaceAccess,
    );

    await controller.setActive("refresh-token", {
      workspaceId: "workspace_member",
    });

    expect(auth.setActiveWorkspace).toHaveBeenCalledWith(
      "refresh-token",
      "workspace_member",
    );
    expect(auth.setSupportWorkspace).not.toHaveBeenCalled();
    expect(platformAdmin.assertPlatformAdmin).not.toHaveBeenCalled();
    expect(
      workspaceAccess.assertWorkspaceAvailableForBackoffice,
    ).not.toHaveBeenCalled();
  });

  it("rejects an unprivileged backoffice request before changing context", async () => {
    const auth = {
      setActiveWorkspace: vi.fn(),
      setSupportWorkspace: vi.fn(),
      getSession: vi.fn(),
    } as unknown as AuthService;
    const platformAdmin = {
      assertPlatformAdmin: vi.fn(async () => {
        throw new ForbiddenException();
      }),
    } as unknown as PlatformAdminService;
    const workspaceAccess = {
      assertWorkspaceAvailableForBackoffice: vi.fn(),
    } as unknown as PlatformWorkspaceAccessService;
    const workspaces = {
      getCurrentWorkspace: vi.fn(),
    } as unknown as WorkspacesService;
    const controller = new WorkspacesController(
      auth,
      platformAdmin,
      workspaces,
      workspaceAccess,
    );

    await expect(
      controller.setActive("common-user-token", {
        workspaceId: "workspace_secret",
        backoffice: true,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(
      workspaceAccess.assertWorkspaceAvailableForBackoffice,
    ).not.toHaveBeenCalled();
    expect(auth.setSupportWorkspace).not.toHaveBeenCalled();
  });
});

describe("PlatformWorkspaceAccessService backoffice catalogue validation", () => {
  it("accepts only a workspace that exists in the platform catalogue", async () => {
    const findUnique = vi.fn(async ({ where }: { where: { id: string } }) =>
      where.id === "workspace_client" ? { id: where.id } : null,
    );
    const service = new PlatformWorkspaceAccessService(
      { workspace: { findUnique } } as never,
      {} as never,
    );

    await expect(
      service.assertWorkspaceAvailableForBackoffice("workspace_client"),
    ).resolves.toBeUndefined();
    await expect(
      service.assertWorkspaceAvailableForBackoffice("workspace_secret"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "workspace_client" },
      select: { id: true },
    });
  });
});
