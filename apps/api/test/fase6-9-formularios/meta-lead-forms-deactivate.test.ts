import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";
import {
  META_LEAD_FORM_DELETE_BLOCKED_MESSAGE,
  MetaLeadFormsService,
} from "../../src/meta-lead-forms/meta-lead-forms.service";

/**
 * Fase 6.9b (decisão de 27/10/2026): uma Página que já recebeu formulários não
 * pode ser removida (409, o histórico fica); só desativada. Desativar e
 * reativar mudam apenas o "active". Sem envios, remover continua funcionando.
 * Dados fictícios.
 */

const env = {
  META_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  API_PUBLIC_URL: "https://api.example.test",
};

function harness(submissionCount: number) {
  const encryption = new MetaTokenEncryptionService(env);
  const token = encryption.encrypt("graph-token-1234");
  const connection = {
    id: "conn1",
    workspaceId: "ws1",
    label: "Página Exemplo",
    pageId: "111",
    formIds: [] as string[],
    crmDatasetId: null,
    qualifiedEventName: "LeadQualificado",
    graphTokenEncrypted: token.encryptedAccessToken,
    graphTokenIv: token.tokenIv,
    graphTokenTag: token.tokenTag,
    graphTokenLast4: "1234",
    capiTokenLast4: null,
    active: true,
    pageSubscribedAt: null,
    createdAt: new Date("2026-10-20T12:00:00.000Z"),
    updatedAt: new Date("2026-10-20T12:00:00.000Z"),
  };
  const prisma = {
    metaLeadFormConnection: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === connection.id && where.workspaceId === connection.workspaceId
          ? connection
          : null,
      ),
      deleteMany: vi.fn(async ({ where }) => ({
        count:
          where.id === connection.id &&
          where.submissions?.none !== undefined &&
          submissionCount === 0
            ? 1
            : 0,
      })),
      delete: vi.fn(),
      update: vi.fn(async ({ data }) => Object.assign(connection, data)),
    },
    metaLeadSubmission: {
      groupBy: vi.fn(async () =>
        submissionCount > 0
          ? [
              {
                connectionId: "conn1",
                _count: { _all: submissionCount },
                _max: { createdAt: new Date("2026-10-26T12:00:00.000Z") },
              },
            ]
          : [],
      ),
    },
  };
  const service = new MetaLeadFormsService(
    prisma as never,
    encryption,
    {} as never,
    env,
    { fetchLead: vi.fn(), subscribePage: vi.fn() } as never,
  );
  return { service, prisma, connection };
}

describe("remover conexão de formulários Meta", () => {
  it("sem envios: remove", async () => {
    const h = harness(0);

    await expect(h.service.deleteConnection("ws1", "conn1")).resolves.toBeUndefined();
    expect(h.prisma.metaLeadFormConnection.deleteMany).toHaveBeenCalledWith({
      where: { id: "conn1", workspaceId: "ws1", submissions: { none: {} } },
    });
    // Never the unconditional delete that cascaded the submissions (#91).
    expect(h.prisma.metaLeadFormConnection.delete).not.toHaveBeenCalled();
  });

  it("com envios: 409 com a mensagem para desativar, e nada é apagado", async () => {
    const h = harness(3);

    const error = await h.service.deleteConnection("ws1", "conn1").catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getStatus()).toBe(409);
    expect((error as Error).message).toBe(META_LEAD_FORM_DELETE_BLOCKED_MESSAGE);
    expect(META_LEAD_FORM_DELETE_BLOCKED_MESSAGE).toContain("Desative a conexão");
    expect(h.prisma.metaLeadFormConnection.delete).not.toHaveBeenCalled();
  });

  it("de outro workspace: 404", async () => {
    const h = harness(0);

    await expect(h.service.deleteConnection("ws2", "conn1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.prisma.metaLeadFormConnection.deleteMany).not.toHaveBeenCalled();
  });
});

describe("desativar e reativar", () => {
  it("desativa e reativa mudando só o active, com a contagem de envios", async () => {
    const h = harness(3);

    const off = await h.service.setConnectionActive("ws1", "conn1", false);
    expect(h.prisma.metaLeadFormConnection.update).toHaveBeenLastCalledWith({
      where: { id: "conn1" },
      data: { active: false },
    });
    expect(off).toMatchObject({ active: false, submissionCount: 3 });

    const on = await h.service.setConnectionActive("ws1", "conn1", true);
    expect(h.prisma.metaLeadFormConnection.update).toHaveBeenLastCalledWith({
      where: { id: "conn1" },
      data: { active: true },
    });
    expect(on).toMatchObject({ active: true, submissionCount: 3 });
  });

  it("de outro workspace: 404 sem alterar", async () => {
    const h = harness(3);

    await expect(
      h.service.setConnectionActive("ws2", "conn1", false),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.prisma.metaLeadFormConnection.update).not.toHaveBeenCalled();
  });
});
