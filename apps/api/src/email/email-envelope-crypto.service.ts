import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { EmailConfigurationService } from "./email-configuration.service";
import type {
  EncryptedEmailEnvelope,
  EmailEnvelopeContext,
  TransactionalEmailEnvelope,
} from "./email.types";

const shortText = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) => !/[\r\n]/.test(value),
    "Control characters are not allowed",
  );
const token = z.string().min(32).max(512);
const expiry = z.string().datetime({ offset: true });
const recipient = z.object({
  address: z.string().email().max(320),
  name: shortText.optional(),
});
const licenseKeyText = z
  .string()
  .trim()
  .min(8)
  .max(80)
  .refine(
    (value) => !/[\r\n]/.test(value),
    "Control characters are not allowed",
  );
const repoUrl = z.string().trim().url().max(500);
const supportEmail = z.string().trim().email().max(320);

const transactionalEmailEnvelopeSchema = z.discriminatedUnion("template", [
  z.object({
    to: recipient,
    template: z.literal("workspace_invitation"),
    data: z.object({
      workspaceName: shortText,
      inviterName: shortText.optional(),
      roleLabel: shortText,
      token,
      expiresAt: expiry,
    }),
  }),
  z.object({
    to: recipient,
    template: z.literal("password_reset"),
    data: z.object({
      recipientName: shortText.optional(),
      token,
      expiresAt: expiry,
    }),
  }),
  z.object({
    to: recipient,
    template: z.literal("email_verification"),
    data: z.object({
      recipientName: shortText.optional(),
      token,
      expiresAt: expiry,
    }),
  }),
  z.object({
    to: recipient,
    template: z.literal("client_owner_activation"),
    data: z.object({
      recipientName: shortText.optional(),
      workspaceName: shortText,
      token,
      expiresAt: expiry,
    }),
  }),
  z.object({
    to: recipient,
    template: z.literal("workspace_access_granted"),
    data: z.object({
      recipientName: shortText.optional(),
      workspaceName: shortText,
    }),
  }),
  z.object({
    to: recipient,
    template: z.literal("platform_operator_activation"),
    data: z.object({
      recipientName: shortText.optional(),
      token,
      expiresAt: expiry,
    }),
  }),
  z.object({
    to: recipient,
    template: z.literal("license_key_delivery"),
    data: z.object({
      recipientName: shortText.optional(),
      licenseKey: licenseKeyText,
      keyPrefix: shortText,
      expiresAt: expiry,
      productName: shortText,
      repoUrl,
      supportEmail: supportEmail.optional(),
    }),
  }),
]);

@Injectable()
export class EmailEnvelopeCryptoService {
  constructor(private readonly configuration: EmailConfigurationService) {}

  encrypt(
    envelope: TransactionalEmailEnvelope,
    context: EmailEnvelopeContext,
  ): EncryptedEmailEnvelope {
    const validated = transactionalEmailEnvelopeSchema.parse(envelope);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(this.associatedData(context));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(validated), "utf8"),
      cipher.final(),
    ]);

    return {
      encryptionVersion: 1,
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  }

  decrypt(
    encrypted: EncryptedEmailEnvelope,
    context: EmailEnvelopeContext,
  ): TransactionalEmailEnvelope {
    if (encrypted.encryptionVersion !== 1) {
      throw new Error("Unsupported transactional email envelope version");
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key(),
      Buffer.from(encrypted.iv, "base64"),
    );
    decipher.setAAD(this.associatedData(context));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");

    return transactionalEmailEnvelopeSchema.parse(JSON.parse(plaintext));
  }

  private key(): Buffer {
    return Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(this.configuration.getEnvelopeSecret(), "utf8"),
        Buffer.from("wpptrack-email-envelope", "utf8"),
        Buffer.from("transactional-email-v1", "utf8"),
        32,
      ),
    );
  }

  private associatedData(context: EmailEnvelopeContext): Buffer {
    return Buffer.from(
      [
        "transactional-email-v1",
        context.deliveryId,
        context.workspaceId ?? "global",
        context.template,
        context.recipientHash,
        context.actionType,
        context.actionId,
        context.actionVersion,
      ].join("\n"),
      "utf8",
    );
  }
}
