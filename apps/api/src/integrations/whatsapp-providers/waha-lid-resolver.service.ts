import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { MetaTokenEncryptionService } from "../meta/meta-token-encryption.service";
import { WahaWhatsappAdapter } from "./waha-whatsapp.adapter";
import type { WhatsappProviderConfig } from "./whatsapp-provider.types";

/**
 * Resolve o telefone de um contato que chegou só com LID (clique de anúncio
 * sem SenderAlt), consultando a WAHA do próprio aluno
 * (GET /api/{session}/lids/{lid}). Melhor esforço: prazo curto, nunca lança
 * e nunca quebra a ingestão — sem resposta útil, devolve null e o webhook
 * segue registrado como ctwa_contact_phone_unresolved.
 */
@Injectable()
export class WahaLidResolverService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MetaTokenEncryptionService)
    private readonly encryption: MetaTokenEncryptionService,
    @Inject(WahaWhatsappAdapter) private readonly waha: WahaWhatsappAdapter,
  ) {}

  async resolvePhone(input: {
    workspaceId: string;
    whatsappInstanceId: string;
    lid: string;
  }): Promise<string | null> {
    try {
      const instance = await this.prisma.whatsappInstance.findFirst({
        where: {
          id: input.whatsappInstanceId,
          workspaceId: input.workspaceId,
          provider: "waha",
        },
        select: { configEncrypted: true, configIv: true, configTag: true },
      });

      if (
        !instance?.configEncrypted ||
        !instance.configIv ||
        !instance.configTag
      ) {
        return null;
      }

      const config = JSON.parse(
        this.encryption.decrypt({
          encryptedAccessToken: instance.configEncrypted,
          tokenIv: instance.configIv,
          tokenTag: instance.configTag,
        }),
      ) as WhatsappProviderConfig;

      if (config.provider !== "waha") {
        return null;
      }

      return await this.waha.resolveLidPhone(config, input.lid);
    } catch {
      return null;
    }
  }
}
