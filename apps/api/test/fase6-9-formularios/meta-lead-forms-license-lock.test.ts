import type { ExecutionContext } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { LicenseSoftlockGuard } from "../../src/licensing-client/license-softlock.guard";
import type { LicenseClientService } from "../../src/licensing-client/license-client.service";
import { licenseWriteAssertion } from "../../src/scripts/import-dashboard-leads";

/**
 * Fase 6.9 (nod): criar, alterar, assinar e remover uma conexão de
 * formulários Meta são escritas, assim como desativar e reativar. Com a
 * licença bloqueada, o guard global
 * responde 423 e a lista (GET) continua liberada. O import do Dashboard Leads
 * com --apply também recusa.
 */
function lockState(locked: boolean) {
  return vi.fn().mockResolvedValue({
    inert: false,
    locked,
    reason: locked ? "revoked" : null,
    state: {},
  });
}

function guard(locked: boolean) {
  return new LicenseSoftlockGuard({
    getLockState: lockState(locked),
  } as unknown as LicenseClientService);
}

const context = (method: string, path: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ method, path }),
      getResponse: () => ({}),
    }),
  }) as unknown as ExecutionContext;

describe("formulários Meta com a licença bloqueada", () => {
  for (const [method, path] of [
    ["POST", "/integrations/meta-lead-forms"],
    ["PATCH", "/integrations/meta-lead-forms/conexao_sintetica"],
    ["POST", "/integrations/meta-lead-forms/conexao_sintetica/subscribe"],
    ["POST", "/integrations/meta-lead-forms/conexao_sintetica/deactivate"],
    ["POST", "/integrations/meta-lead-forms/conexao_sintetica/reactivate"],
    ["DELETE", "/integrations/meta-lead-forms/conexao_sintetica"],
  ] as const)
    it(`${method} ${path} responde 423`, async () => {
      const rejection = await guard(true)
        .canActivate(context(method, path))
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(rejection).toBeInstanceOf(HttpException);
      expect((rejection as HttpException).getStatus()).toBe(423);
    });

  it("a lista continua liberada; com a licença utilizável a escrita passa", async () => {
    await expect(
      guard(true).canActivate(context("GET", "/integrations/meta-lead-forms")),
    ).resolves.toBe(true);
    await expect(
      guard(false).canActivate(context("POST", "/integrations/meta-lead-forms")),
    ).resolves.toBe(true);
  });

  it("import do Dashboard Leads: --apply recusa com a licença bloqueada", async () => {
    await expect(
      licenseWriteAssertion({ getLockState: lockState(true) } as never)(),
    ).rejects.toThrow(/Licença bloqueada/);
    await expect(
      licenseWriteAssertion({ getLockState: lockState(false) } as never)(),
    ).resolves.toBeUndefined();
  });
});
