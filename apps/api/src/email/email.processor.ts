import { createHash } from "node:crypto";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger } from "@nestjs/common";
import { UnrecoverableError, type Job } from "bullmq";
import {
  classifyEmailDeliveryError,
  EmailTransportFailure,
  type ClassifiedEmailFailure,
} from "./email-delivery-error";
import { EmailDeliveryAuditService } from "./email-delivery-audit.service";
import { EmailEnvelopeCryptoService } from "./email-envelope-crypto.service";
import { EmailMessageRenderer } from "./email-message.renderer";
import { EMAIL_TRANSPORT, type EmailTransport } from "./email.transport";
import {
  EMAIL_DELIVERY_QUEUE,
  type EmailDeliveryJobPayload,
} from "./email.types";
import { EmailActionStatusService } from "./email-action-status.service";

@Processor(EMAIL_DELIVERY_QUEUE)
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(
    private readonly crypto: EmailEnvelopeCryptoService,
    private readonly renderer: EmailMessageRenderer,
    @Inject(EMAIL_TRANSPORT)
    private readonly transport: EmailTransport,
    private readonly audit: EmailDeliveryAuditService,
    private readonly actionStatus: EmailActionStatusService,
  ) {
    super();
  }

  async process(job: Job<EmailDeliveryJobPayload>) {
    const attemptNumber = (job.attemptsMade ?? 0) + 1;
    const maxAttempts = this.maxAttempts(job);
    let metadataAuthenticated = false;

    try {
      const envelope = this.decryptEnvelope(job.data);
      metadataAuthenticated = true;
      const message = this.renderMessage(envelope);
      const result = await this.transport.send(message);

      await this.safeRecordActionStatus(job.data, "sent");

      await this.safeAudit({
        deliveryId: job.data.deliveryId,
        workspaceId: job.data.workspaceId,
        template: job.data.template,
        recipientHash: job.data.recipientHash,
        status: "sent",
        attemptNumber,
        maxAttempts,
        providerMessageId: result.messageId,
      });

      return {
        deliveryId: job.data.deliveryId,
        status: "sent" as const,
        acceptedCount: result.acceptedCount,
      };
    } catch (error) {
      const failure = this.classifyProcessingFailure(error);
      const willRetry =
        failure.kind === "transient" && attemptNumber < maxAttempts;
      const auditIdentity = this.auditIdentity(job, metadataAuthenticated);

      await this.safeAudit({
        ...auditIdentity,
        status: willRetry ? "retrying" : "failed",
        attemptNumber,
        maxAttempts,
        failureKind: failure.kind,
        errorCode: failure.code,
      });

      if (!willRetry && metadataAuthenticated) {
        await this.safeRecordActionStatus(job.data, "failed");
      }

      const safeMessage = `Transactional email delivery failed (${failure.code})`;

      if (failure.kind === "permanent") {
        throw new UnrecoverableError(safeMessage);
      }

      throw new Error(safeMessage);
    }
  }

  private maxAttempts(job: Job<EmailDeliveryJobPayload>): number {
    const attempts = job.opts.attempts;
    return typeof attempts === "number" && attempts > 0 ? attempts : 1;
  }

  private decryptEnvelope(job: EmailDeliveryJobPayload) {
    try {
      return this.crypto.decrypt(job, job);
    } catch {
      throw new EmailTransportFailure({
        kind: "permanent",
        code: "EINVALIDPAYLOAD",
      });
    }
  }

  private renderMessage(
    envelope: ReturnType<EmailEnvelopeCryptoService["decrypt"]>,
  ) {
    try {
      return this.renderer.render(envelope);
    } catch {
      throw new EmailTransportFailure({
        kind: "permanent",
        code: "ECONFIG",
      });
    }
  }

  private classifyProcessingFailure(error: unknown): ClassifiedEmailFailure {
    if (error instanceof SyntaxError || error instanceof RangeError) {
      return { kind: "permanent", code: "EINVALIDPAYLOAD" };
    }

    if (
      error instanceof Error &&
      (error.message.includes("envelope") ||
        error.message.includes("Unsupported transactional email"))
    ) {
      return { kind: "permanent", code: "EINVALIDPAYLOAD" };
    }

    return classifyEmailDeliveryError(error);
  }

  private auditIdentity(
    job: Job<EmailDeliveryJobPayload>,
    metadataAuthenticated: boolean,
  ): Pick<
    Parameters<EmailDeliveryAuditService["record"]>[0],
    "deliveryId" | "workspaceId" | "template" | "recipientHash"
  > {
    if (metadataAuthenticated) {
      return {
        deliveryId: job.data.deliveryId,
        workspaceId: job.data.workspaceId,
        template: job.data.template,
        recipientHash: job.data.recipientHash,
      };
    }

    return {
      deliveryId: createHash("sha256")
        .update(`invalid-email-job:${String(job.id ?? "unknown")}`)
        .digest("hex"),
      workspaceId: null,
      template: "unknown",
      recipientHash: "unavailable",
    };
  }

  private async safeAudit(
    input: Parameters<EmailDeliveryAuditService["record"]>[0],
  ): Promise<void> {
    try {
      await this.audit.record(input);
    } catch {
      this.logger.error(
        `Falha ao registrar auditoria de delivery processado; deliveryId=${input.deliveryId} template=${input.template} status=${input.status}`,
      );
    }
  }

  private async safeRecordActionStatus(
    payload: EmailDeliveryJobPayload,
    status: "sent" | "failed",
  ): Promise<void> {
    try {
      await this.actionStatus.record({
        workspaceId: payload.workspaceId,
        actionType: payload.actionType,
        actionId: payload.actionId,
        actionVersion: payload.actionVersion,
        status,
      });
    } catch {
      this.logger.error(
        `Falha ao registrar estado de delivery; deliveryId=${payload.deliveryId} status=${status}`,
      );
    }
  }
}
