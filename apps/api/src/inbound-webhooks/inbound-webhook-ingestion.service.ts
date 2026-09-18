import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import {
  INBOUND_WEBHOOK_RAW_RETENTION_DAYS,
  parseInboundWebhooksConfig,
} from "../config/deployment-config";
import { InboundWebhookPayloadEncryptionService } from "./inbound-webhook-payload-encryption.service";
import { InboundWebhookQueueService } from "./inbound-webhook-queue.service";
import {
  rawBodyDeliveryIdentity,
  type InboundWebhookDeliveryIdentity,
} from "./providers/inbound-webhook-delivery-identity";
import { extractUmblerV1DeliveryIdentity } from "./providers/umbler/umbler-v1-delivery-identity";
import { extractMetaCloudV1DeliveryIdentity } from "./providers/meta-cloud/meta-cloud-v1-delivery-identity";
import { MAX_INBOUND_WEBHOOK_PAYLOAD_BYTES } from "./inbound-webhook-limits";

export { MAX_INBOUND_WEBHOOK_PAYLOAD_BYTES } from "./inbound-webhook-limits";

const publicConnectionNotFoundMessage = "Webhook nao encontrado";
const publicPersistenceFailureMessage = "Webhook temporariamente indisponivel";
const dummySecretHash = Buffer.alloc(32);
const CONNECTION_TELEMETRY_INTERVAL_MS = 30_000;

type PublicInboundWebhookConnection =
  Prisma.InboundWebhookConnectionGetPayload<{
    include: { parserRelease: true };
  }>;

export type InboundWebhookIngestionResult = {
  status: "accepted";
  deliveryId: string;
  duplicate: boolean;
  queueStatus: "queued" | "pending" | "existing";
};

export type InboundWebhookIngestionInput = {
  connectionId: string;
  token: unknown;
  contentType: string | undefined;
  providerAttempt: unknown;
  metaCloudSignature256?: unknown;
  rawBody: Buffer | undefined;
};

export function matchesInboundWebhookSecret(
  storedHash: string | null | undefined,
  candidateSecret: unknown,
): boolean {
  const expected =
    storedHash && /^[a-f0-9]{64}$/i.test(storedHash)
      ? Buffer.from(storedHash, "hex")
      : dummySecretHash;
  const received = createHash("sha256")
    .update(typeof candidateSecret === "string" ? candidateSecret : "", "utf8")
    .digest();

  return timingSafeEqual(expected, received);
}

export function parseInboundWebhookProviderAttempt(
  value: unknown,
): number | null {
  const normalized = typeof value === "string" ? value.trim() : "";

  if (!/^[1-9]\d{0,5}$/.test(normalized)) {
    return null;
  }

  return Number(normalized);
}

export function matchesMetaCloudSignature256(
  appSecret: string | undefined,
  rawBody: Buffer,
  signature: unknown,
): boolean {
  if (
    !appSecret ||
    appSecret.trim().length === 0 ||
    typeof signature !== "string"
  ) {
    return false;
  }

  const signatureHex = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : null;

  if (!signatureHex || !/^[a-f0-9]{64}$/i.test(signatureHex)) {
    return false;
  }

  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(signatureHex, "hex");

  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

@Injectable()
export class InboundWebhookIngestionService {
  private readonly logger = new Logger(InboundWebhookIngestionService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv,
    @Inject(InboundWebhookPayloadEncryptionService)
    private readonly encryption: InboundWebhookPayloadEncryptionService,
    @Inject(InboundWebhookQueueService)
    private readonly queue: InboundWebhookQueueService,
  ) {}

  async ingest(
    input: InboundWebhookIngestionInput,
  ): Promise<InboundWebhookIngestionResult> {
    this.assertFeatureEnabled();
    const rawBody = this.requireJsonBody(input.contentType, input.rawBody);
    const connection = await this.authenticateConnection(
      input.connectionId,
      input.token,
      rawBody,
      input.metaCloudSignature256,
    );
    const providerAttempt = parseInboundWebhookProviderAttempt(
      input.providerAttempt,
    );
    const identity = this.extractIdentity(connection, rawBody);
    const existing = await this.findExistingDelivery(connection.id, identity);

    if (existing) {
      this.scheduleDuplicateAccounting(
        connection,
        existing.id,
        providerAttempt,
      );

      return {
        status: "accepted",
        deliveryId: existing.id,
        duplicate: true,
        queueStatus: "existing",
      };
    }

    const deliveryId = randomUUID();
    const receivedAt = new Date();
    const encrypted = this.encryption.encrypt(rawBody, {
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      deliveryId,
    });

    try {
      await this.persistNewDelivery({
        connection,
        deliveryId,
        encrypted,
        identity,
        providerAttempt,
        rawBodyLength: rawBody.length,
        receivedAt,
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        const duplicate = await this.findExistingDelivery(
          connection.id,
          identity,
        );

        if (!duplicate) {
          throw new ServiceUnavailableException(
            publicPersistenceFailureMessage,
          );
        }

        this.scheduleDuplicateAccounting(
          connection,
          duplicate.id,
          providerAttempt,
        );

        return {
          status: "accepted",
          deliveryId: duplicate.id,
          duplicate: true,
          queueStatus: "existing",
        };
      }

      if (error instanceof NotFoundException) {
        throw error;
      }

      throw new ServiceUnavailableException(publicPersistenceFailureMessage);
    }

    this.schedulePostAcceptance(connection, deliveryId, receivedAt);

    return {
      status: "accepted",
      deliveryId,
      duplicate: false,
      queueStatus: "pending",
    };
  }

  private assertFeatureEnabled(): void {
    if (!parseInboundWebhooksConfig(this.env).enabled) {
      throw new NotFoundException(publicConnectionNotFoundMessage);
    }
  }

  private async authenticateConnection(
    connectionId: string,
    token: unknown,
    rawBody: Buffer,
    metaCloudSignature256: unknown,
  ): Promise<PublicInboundWebhookConnection> {
    let connection: PublicInboundWebhookConnection | null;

    try {
      connection = await this.prisma.inboundWebhookConnection.findUnique({
        where: {
          id: connectionId,
        },
        include: {
          parserRelease: true,
        },
      });
    } catch (error) {
      this.logInfrastructureFailure("connection_lookup", connectionId, error);
      throw new ServiceUnavailableException(publicPersistenceFailureMessage);
    }

    const isMetaCloud = connection?.provider === "meta_cloud";
    const metaAppSecret = this.env.META_APP_SECRET;
    const authenticated = isMetaCloud
      ? metaAppSecret && metaAppSecret.trim().length > 0
        ? matchesMetaCloudSignature256(
            metaAppSecret,
            rawBody,
            metaCloudSignature256,
          )
        : connection?.status === "observation"
      : matchesInboundWebhookSecret(connection?.secretHash, token);

    if (
      !connection ||
      !authenticated ||
      connection.removedAt !== null ||
      !["observation", "production"].includes(connection.status)
    ) {
      throw new NotFoundException(publicConnectionNotFoundMessage);
    }

    if (isMetaCloud && (!metaAppSecret || metaAppSecret.trim().length === 0)) {
      this.logger.warn(
        JSON.stringify({
          event: "inbound_webhook.meta_cloud_signature_unverified",
          connectionId: connection.id,
          mode: "observation_fallback",
        }),
      );
    }

    return connection;
  }

  private requireJsonBody(
    contentType: string | undefined,
    rawBody: Buffer | undefined,
  ): Buffer {
    const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();

    if (mediaType !== "application/json") {
      throw new UnsupportedMediaTypeException(
        "Webhook requer Content-Type application/json",
      );
    }

    if (!rawBody || rawBody.length === 0) {
      throw new BadRequestException("Payload JSON obrigatorio");
    }

    if (rawBody.length > MAX_INBOUND_WEBHOOK_PAYLOAD_BYTES) {
      throw new PayloadTooLargeException("Payload do webhook excede o limite");
    }

    try {
      JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new BadRequestException("Payload JSON invalido");
    }

    return rawBody;
  }

  private extractIdentity(
    connection: PublicInboundWebhookConnection,
    rawBody: Buffer,
  ): InboundWebhookDeliveryIdentity {
    if (
      connection.provider === "umbler" &&
      connection.parserRelease.version === "v1"
    ) {
      return extractUmblerV1DeliveryIdentity(rawBody);
    }

    if (
      connection.provider === "meta_cloud" &&
      connection.parserRelease.version === "v1"
    ) {
      return extractMetaCloudV1DeliveryIdentity(rawBody);
    }

    return rawBodyDeliveryIdentity(rawBody);
  }

  private async findExistingDelivery(
    connectionId: string,
    identity: InboundWebhookDeliveryIdentity,
  ): Promise<{ id: string } | null> {
    try {
      return await this.prisma.inboundWebhookDelivery.findUnique({
        where: {
          connectionId_ingressKey: {
            connectionId,
            ingressKey: identity.ingressKey,
          },
        },
        select: {
          id: true,
        },
      });
    } catch (error) {
      this.logInfrastructureFailure("delivery_lookup", connectionId, error);
      throw new ServiceUnavailableException(publicPersistenceFailureMessage);
    }
  }

  private scheduleDuplicateAccounting(
    connection: PublicInboundWebhookConnection,
    deliveryId: string,
    providerAttempt: number | null,
  ): void {
    const receivedAt = new Date();

    setImmediate(() => {
      void Promise.allSettled([
        this.prisma.inboundWebhookDelivery.updateMany({
          where: {
            id: deliveryId,
            connectionId: connection.id,
            workspaceId: connection.workspaceId,
          },
          data: {
            attemptCount: {
              increment: 1,
            },
            lastReceivedAt: receivedAt,
            providerAttempt: providerAttempt ?? undefined,
          },
        }),
        this.touchConnectionTelemetry(connection, receivedAt),
      ]).then((results) => {
        this.logBackgroundFailures(
          "inbound_webhook.duplicate_accounting_failed",
          connection.id,
          deliveryId,
          results,
        );
      });
    });
  }

  private async persistNewDelivery(input: {
    connection: PublicInboundWebhookConnection;
    deliveryId: string;
    encrypted: {
      encryptedPayload: string;
      payloadIv: string;
      payloadTag: string;
      encryptionKeyVersion: number;
    };
    identity: InboundWebhookDeliveryIdentity;
    providerAttempt: number | null;
    rawBodyLength: number;
    receivedAt: Date;
  }): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.revalidateConnection(transaction, input.connection);
      await transaction.inboundWebhookDelivery.create({
        data: {
          id: input.deliveryId,
          workspaceId: input.connection.workspaceId,
          connectionId: input.connection.id,
          provider: input.connection.provider,
          ingressKey: input.identity.ingressKey,
          externalDeliveryId: input.identity.externalDeliveryId,
          providerEventType: input.identity.providerEventType,
          parserVersion: input.connection.parserRelease.version,
          status: "pending",
          firstReceivedAt: input.receivedAt,
          lastReceivedAt: input.receivedAt,
          providerAttempt: input.providerAttempt,
          ...input.encrypted,
          payloadExpiresAt: new Date(
            input.receivedAt.getTime() +
              INBOUND_WEBHOOK_RAW_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
          ),
          normalizedSummary: {
            identitySource: input.identity.identitySource,
            rawBodyLength: input.rawBodyLength,
          },
        },
      });
    });
  }

  private schedulePostAcceptance(
    connection: PublicInboundWebhookConnection,
    deliveryId: string,
    receivedAt: Date,
  ): void {
    setImmediate(() => {
      void Promise.allSettled([
        this.enqueueAcceptedDelivery(connection, deliveryId),
        this.touchConnectionTelemetry(connection, receivedAt),
      ]).then((results) => {
        this.logBackgroundFailures(
          "inbound_webhook.post_acceptance_failed",
          connection.id,
          deliveryId,
          results,
        );
      });
    });
  }

  private async enqueueAcceptedDelivery(
    connection: PublicInboundWebhookConnection,
    deliveryId: string,
  ): Promise<void> {
    await this.queue.enqueueDelivery({
      deliveryId,
      connectionId: connection.id,
      workspaceId: connection.workspaceId,
    });
    await this.prisma.inboundWebhookDelivery.updateMany({
      where: {
        id: deliveryId,
        connectionId: connection.id,
        workspaceId: connection.workspaceId,
        status: "pending",
      },
      data: {
        status: "queued",
        queuedAt: new Date(),
      },
    });
  }

  private async revalidateConnection(
    transaction: Prisma.TransactionClient,
    connection: PublicInboundWebhookConnection,
  ): Promise<void> {
    const current = await transaction.inboundWebhookConnection.findFirst({
      where: {
        id: connection.id,
        workspaceId: connection.workspaceId,
        secretHash: connection.secretHash,
        status: { in: ["observation", "production"] },
        removedAt: null,
      },
      select: {
        id: true,
      },
    });

    if (!current) {
      throw new NotFoundException(publicConnectionNotFoundMessage);
    }
  }

  private async touchConnectionTelemetry(
    connection: PublicInboundWebhookConnection,
    lastDeliveryAt: Date,
  ): Promise<void> {
    const staleBefore = new Date(
      lastDeliveryAt.getTime() - CONNECTION_TELEMETRY_INTERVAL_MS,
    );

    await this.prisma.inboundWebhookConnection.updateMany({
      where: {
        id: connection.id,
        workspaceId: connection.workspaceId,
        secretHash: connection.secretHash,
        status: { in: ["observation", "production"] },
        removedAt: null,
        OR: [
          {
            lastDeliveryAt: null,
          },
          {
            lastDeliveryAt: {
              lt: staleBefore,
            },
          },
        ],
      },
      data: {
        lastDeliveryAt,
      },
    });
  }

  private logBackgroundFailures(
    event: string,
    connectionId: string,
    deliveryId: string,
    results: PromiseSettledResult<unknown>[],
  ): void {
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    if (failures.length === 0) {
      return;
    }

    this.logger.warn(
      JSON.stringify({
        event,
        connectionId,
        deliveryId,
        failureCount: failures.length,
        failureTypes: failures.map((failure) => this.errorType(failure.reason)),
      }),
    );
  }

  private errorType(error: unknown): string {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return error.code;
    }

    return error instanceof Error ? error.name : "unknown";
  }

  private logInfrastructureFailure(
    stage: string,
    connectionId: string,
    error: unknown,
  ): void {
    this.logger.error(
      JSON.stringify({
        event: "inbound_webhook.infrastructure_failure",
        stage,
        connectionId,
        errorType: this.errorType(error),
      }),
    );
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    );
  }
}
