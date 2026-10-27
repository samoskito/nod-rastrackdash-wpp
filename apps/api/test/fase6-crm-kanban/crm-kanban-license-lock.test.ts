import type { ExecutionContext } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { LicenseSoftlockGuard } from "../../src/licensing-client/license-softlock.guard";
import type { LicenseClientService } from "../../src/licensing-client/license-client.service";

/**
 * Fase 6.2b (nod): arrastar um card para frente no CRM Kanban registra uma
 * conversão manual (POST com source "kanban"), então é escrita: com a licença
 * bloqueada o guard global responde 423. A leitura do quadro (GET /crm/board
 * e "Carregar mais") continua liberada.
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

describe("CRM Kanban com a licença bloqueada", () => {
  for (const path of [
    "/leads/lead_sintetico/manual-conversions/preview",
    "/leads/lead_sintetico/manual-conversions",
  ])
    it(`mover o card (POST ${path}) responde 423`, async () => {
      const rejection = await guard(true)
        .canActivate(context("POST", path))
        .then(() => null, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(HttpException);
      expect((rejection as HttpException).getStatus()).toBe(423);
    });

  for (const path of [
    "/crm/board",
    "/crm/board/columns/LeadSubmitted",
  ])
    it(`a leitura do quadro (GET ${path}) continua liberada`, async () => {
      await expect(guard(true).canActivate(context("GET", path))).resolves.toBe(true);
    });
});
