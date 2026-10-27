import { Controller, Get, Inject } from "@nestjs/common";
import type {
  BackofficeParserReleaseListDto,
  InboundWebhookParserReleaseDto,
} from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { PlatformAdminService } from "../auth/platform-admin.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { effectiveInboundParserStatus } from "./inbound-webhook-parser-eligibility";

/**
 * Backoffice "Leitores de webhook" (fase 6.5): porte só de leitura do SaaS
 * b4d71afc. Lista as versões de leitor da instalação e se cada uma está em
 * uso (status efetivo). É diagnóstico de suporte: no nod os leitores
 * validados no SaaS entram certificados por migration (produção direta);
 * não existe ação de certificar ou liberar aqui, e nada muda o envio.
 */
@Controller("backoffice/inbound-webhooks/parser-releases")
export class BackofficeParserReleasesController {
  constructor(
    @Inject(PlatformAdminService)
    private readonly platformAdmin: PlatformAdminService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(
    @AuthToken() refreshToken: string,
  ): Promise<BackofficeParserReleaseListDto> {
    await this.platformAdmin.assertPlatformAdmin(refreshToken);
    const releases = await this.prisma.inboundWebhookParserRelease.findMany({
      orderBy: [{ provider: "asc" }, { version: "asc" }],
      select: {
        id: true,
        provider: true,
        version: true,
        status: true,
        certifiedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return {
      releases: releases.map(
        (release): InboundWebhookParserReleaseDto => ({
          id: release.id,
          provider: release.provider as InboundWebhookParserReleaseDto["provider"],
          version: release.version,
          status: effectiveInboundParserStatus(release),
          certifiedAt: release.certifiedAt?.toISOString() ?? null,
          createdAt: release.createdAt.toISOString(),
          updatedAt: release.updatedAt.toISOString(),
        }),
      ),
    };
  }
}
