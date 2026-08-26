import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { parseDeploymentConfig } from "./config/deployment-config";
import { getApiPort } from "./config/env";
import { loadLocalEnv } from "./config/load-env";
import { PlatformAdminEnvBootstrapService } from "./auth/platform-admin-env-bootstrap.service";
import { INBOUND_WEBHOOK_BODY_LIMIT } from "./inbound-webhooks/inbound-webhook-limits";

async function bootstrap() {
  loadLocalEnv();
  const deploymentConfig = parseDeploymentConfig();
  const { AppModule } = await import("./app.module");
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.useBodyParser("json", { limit: INBOUND_WEBHOOK_BODY_LIMIT });
  app.enableCors({
    origin: deploymentConfig.webOrigin,
    credentials: true,
  });

  await app.get(PlatformAdminEnvBootstrapService).bootstrap();

  await app.listen(getApiPort());
}

void bootstrap();
