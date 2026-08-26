import { createHash } from "node:crypto";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import { ZodError } from "zod";
import { createBullJobId } from "../common/queue/job-id";
import { EmailConfigurationService } from "./email-configuration.service";
import { EmailDeliveryAuditService } from "./email-delivery-audit.service";
import { EmailEnvelopeCryptoService } from "./email-envelope-crypto.service";
import {
  EMAIL_DELIVERY_QUEUE,
  type EmailDeliveryJobPayload,
  type EmailEnvelopeContext,
  type EmailQueueInput,
  type EmailQueueResult,
} from "./email.types";

const emailRetentionSeconds = 60 * 60 * 24 * 14;

@Injectable()
export class EmailQueueService {
  private readonly logger = new Logger(EmailQueueService.name);

  constructor(
    @InjectQueue(EMAIL_DELIVERY_QUEUE)
    private readonly queue: Queue<EmailDeliveryJobPayload>,
    private readonly configuration: EmailConfigurationService,
    private readonly crypto: EmailEnvelopeCryptoService,
    private readonly audit: EmailDeliveryAuditService,
  ) {}

  isEnabled(): boolean {
    return this.configuration.isEnabled();
  }

  async enqueue(input: EmailQueueInput): Promise<EmailQueueResult> {
    if (!this.configuration.isEnabled()) {
      throw new Error("Transactional email provider is disabled");
    }

    this.assertInput(input);
    const context = {
      deliveryId: this.deliveryId(input),
      workspaceId: input.workspaceId,
      template: input.envelope.template,
      recipientHash: this.hash(input.envelope.to.address.trim().toLowerCase()),
      actionType: input.action.type,
      actionId: input.action.id,
      actionVersion: input.action.version,
    } satisfies EmailEnvelopeContext;
    let encrypted: ReturnType<EmailEnvelopeCryptoService["encrypt"]>;
    try {
      encrypted = this.crypto.encrypt(input.envelope, context);
    } catch (error) {
      // Encryption/validation failed before the job ever reached the queue.
      // Audit this fail-closed so a bad envelope never disappears silently.
      await this.safeAudit({
        deliveryId: context.deliveryId,
        workspaceId: context.workspaceId,
        template: context.template,
        recipientHash: context.recipientHash,
        status: "failed",
        errorCode:
          error instanceof ZodError ? "zod_envelope" : "encrypt_failed",
      });
      throw error;
    }
    const payload: EmailDeliveryJobPayload = {
      ...context,
      ...encrypted,
    };
    const job = await this.queue.add("send-transactional-email", payload, {
      jobId: createBullJobId("email", context.deliveryId),
      attempts: 4,
      backoff: {
        type: "exponential",
        delay: 5_000,
      },
      removeOnComplete: {
        age: emailRetentionSeconds,
        count: 1_000,
      },
      removeOnFail: {
        age: emailRetentionSeconds,
        count: 1_000,
      },
    });

    await this.safeAudit({
      deliveryId: context.deliveryId,
      workspaceId: payload.workspaceId,
      template: payload.template,
      recipientHash: payload.recipientHash,
      status: "queued",
    });

    return {
      deliveryId: context.deliveryId,
      jobId: job.id,
      status: "queued",
    };
  }

  private assertInput(input: EmailQueueInput): void {
    if (
      !input.action.id.trim() ||
      !input.action.version.trim() ||
      (input.workspaceId !== null && !input.workspaceId.trim())
    ) {
      throw new Error("Transactional email action reference is invalid");
    }

    if (
      [
        "workspace_invitation",
        "client_owner_activation",
        "workspace_access_granted",
      ].includes(input.envelope.template) &&
      input.workspaceId === null
    ) {
      throw new Error("Workspace email requires a workspace scope");
    }
  }

  private deliveryId(input: EmailQueueInput): string {
    return this.hash(
      [
        "transactional-email-v1",
        input.envelope.template,
        input.workspaceId ?? "global",
        input.action.type,
        input.action.id,
        input.action.version,
      ].join(":"),
    );
  }

  private hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  private async safeAudit(
    input: Parameters<EmailDeliveryAuditService["record"]>[0],
  ): Promise<void> {
    try {
      await this.audit.record(input);
    } catch {
      this.logger.error(
        `Falha ao registrar auditoria de delivery enfileirado; deliveryId=${input.deliveryId} template=${input.template} status=${input.status}`,
      );
    }
  }
}
