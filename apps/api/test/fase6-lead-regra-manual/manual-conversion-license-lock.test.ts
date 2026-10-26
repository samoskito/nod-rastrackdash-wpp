import type { ExecutionContext } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { LicenseSoftlockGuard } from "../../src/licensing-client/license-softlock.guard";
import type { LicenseClientService } from "../../src/licensing-client/license-client.service";

/**
 * Fase 6.2a (nod): registrar, pré-visualizar e cancelar uma conversão manual
 * são escritas (POST). Com a licença bloqueada, o guard global responde 423
 * e nada é gravado; a leitura do lead (GET) continua liberada.
 */
function guard(locked: boolean) {
  const getLockState = vi.fn().mockResolvedValue({
    inert: false,
    locked,
    reason: locked ? "revoked" : null,
    state: {},
  });
  return new LicenseSoftlockGuard({ getLockState } as unknown as LicenseClientService);
}

const context = (method: string, path: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ method, path }),
      getResponse: () => ({}),
    }),
  }) as unknown as ExecutionContext;

describe("conversão manual com a licença bloqueada", () => {
  for (const path of [
    "/leads/lead_sintetico/manual-conversions",
    "/leads/lead_sintetico/manual-conversions/preview",
    "/leads/lead_sintetico/manual-conversions/log_sintetico/cancel",
  ])
    it(`POST ${path} responde 423`, async () => {
      const rejection = await guard(true)
        .canActivate(context("POST", path))
        .then(() => null, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(HttpException);
      expect((rejection as HttpException).getStatus()).toBe(423);
    });

  it("a leitura do lead continua liberada; com a licença utilizável o registro passa", async () => {
    await expect(
      guard(true).canActivate(context("GET", "/leads/lead_sintetico")),
    ).resolves.toBe(true);
    await expect(
      guard(false).canActivate(
        context("POST", "/leads/lead_sintetico/manual-conversions"),
      ),
    ).resolves.toBe(true);
  });
});
