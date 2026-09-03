import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
} from "@nestjs/common";
import {
  externalDataConnectorCreateInputSchema,
  type ExternalDataConnectorCreateInputDto,
} from "@wpptrack/shared";
import { z } from "zod";
import { AuthToken } from "../auth/auth-user.decorator";
import { PlatformAdminService } from "../auth/platform-admin.service";
import { ExternalDataService } from "./external-data.service";

const idSchema = z.string().trim().min(1).max(191);

@Controller("backoffice/workspaces/:workspaceId/external-connectors")
export class BackofficeExternalDataController {
  constructor(
    private readonly platformAdmin: PlatformAdminService,
    private readonly externalData: ExternalDataService,
  ) {}

  @Get()
  async list(
    @AuthToken() refreshToken: string,
    @Param("workspaceId") workspaceId: string,
  ) {
    const actor = await this.platformAdmin.assertPlatformOwner(refreshToken);
    return this.externalData.listWorkspaceConnectors(
      this.id(workspaceId),
      actor.id,
    );
  }

  @Post()
  async create(
    @AuthToken() refreshToken: string,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ) {
    const actor = await this.platformAdmin.assertPlatformOwner(refreshToken);
    const parsed = externalDataConnectorCreateInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Payload invalido");
    if (parsed.data.workspaceId !== this.id(workspaceId)) {
      throw new BadRequestException(
        "Workspace do payload nao corresponde a rota",
      );
    }
    this.assertReadOnlyInput(parsed.data);
    return this.externalData.createWorkspaceConnector(
      this.id(workspaceId),
      parsed.data,
      actor.id,
    );
  }

  @Post(":connectorId/test")
  async test(
    @AuthToken() refreshToken: string,
    @Param("workspaceId") workspaceId: string,
    @Param("connectorId") connectorId: string,
  ) {
    const actor = await this.platformAdmin.assertPlatformOwner(refreshToken);
    return this.externalData.testWorkspaceConnection(
      this.id(workspaceId),
      this.id(connectorId),
      actor.id,
    );
  }

  @Get(":connectorId/status")
  async status(
    @AuthToken() refreshToken: string,
    @Param("workspaceId") workspaceId: string,
    @Param("connectorId") connectorId: string,
  ) {
    const actor = await this.platformAdmin.assertPlatformOwner(refreshToken);
    return this.externalData.getWorkspaceConnectorStatus(
      this.id(workspaceId),
      this.id(connectorId),
      actor.id,
    );
  }

  private id(value: string): string {
    const parsed = idSchema.safeParse(value);
    if (!parsed.success)
      throw new BadRequestException("Identificador invalido");
    return parsed.data;
  }

  private assertReadOnlyInput(
    input: ExternalDataConnectorCreateInputDto,
  ): void {
    if (input.syncEnabled || !input.shadowMode || input.capiSendEnabled) {
      throw new BadRequestException(
        "Este conector opera somente em modo leitura",
      );
    }
  }
}
