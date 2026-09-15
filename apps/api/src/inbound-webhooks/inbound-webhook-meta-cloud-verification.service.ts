import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { matchesInboundWebhookSecret } from "./inbound-webhook-ingestion.service";

/**
 * Verifies Meta Cloud's subscription handshake for a workspace-scoped
 * connection. This intentionally does not accept or parse Meta POST payloads;
 * that work is introduced by the follow-up parser release.
 */
@Injectable()
export class InboundWebhookMetaCloudVerificationService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async matches(connectionId: string, verifyToken: unknown): Promise<boolean> {
    const connection = await this.prisma.inboundWebhookConnection.findFirst({
      where: {
        id: connectionId,
        provider: "meta_cloud",
        removedAt: null,
        secretHash: { not: null },
      },
      select: { secretHash: true },
    });

    return matchesInboundWebhookSecret(connection?.secretHash, verifyToken);
  }
}
