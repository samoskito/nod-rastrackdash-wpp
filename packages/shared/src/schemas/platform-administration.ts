import { z } from "zod";
import { platformRoles } from "../roles";

const normalizedEmailSchema = z
  .string()
  .trim()
  .email()
  .transform((email) => email.toLowerCase());

export const platformUserProvisionInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    email: normalizedEmailSchema,
    role: z.literal("platform_operator"),
  })
  .strict();

export const platformUserRoleUpdateInputSchema = z
  .object({
    role: z.enum(platformRoles).nullable(),
  })
  .strict();

export const platformUserInvitationReissueInputSchema = z.object({}).strict();

export const platformUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  email: z.string().email(),
  role: z.enum(platformRoles),
  createdAt: z.string().datetime(),
});

export const platformUserListSchema = z.array(platformUserSchema);

export const platformUserProvisionResultSchema = z.object({
  accepted: z.literal(true),
});

export const backofficeWorkspaceResponsibleInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    email: normalizedEmailSchema,
  })
  .strict();

export const backofficeWorkspaceCreateInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    responsible: backofficeWorkspaceResponsibleInputSchema,
    reuseExistingUser: z.boolean().default(false),
  })
  .strict();

export const backofficeWorkspaceResponsibleSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().nullable(),
    email: z.string().email(),
    role: z.literal("owner"),
    status: z.enum(["active", "pending_activation"]),
  })
  .strict();

export const backofficeWorkspaceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().min(1),
    operationalStatus: z.enum(["active", "blocked"]),
    createdAt: z.string().datetime(),
    responsible: backofficeWorkspaceResponsibleSchema.nullable(),
  })
  .strict();

export const backofficeWorkspaceListSchema = z.array(backofficeWorkspaceSchema);

export const backofficeWorkspaceCreateResultSchema = backofficeWorkspaceSchema
  .extend({
    reusedExistingUser: z.boolean(),
    deliveryStatus: z.enum(["queued", "failed", "not_required"]),
  })
  .strict();

export const backofficeWorkspaceActivationReissueResultSchema = z
  .object({
    accepted: z.literal(true),
    deliveryStatus: z.literal("queued"),
  })
  .strict();

export type PlatformUserProvisionInputDto = z.infer<
  typeof platformUserProvisionInputSchema
>;
export type PlatformUserRoleUpdateInputDto = z.infer<
  typeof platformUserRoleUpdateInputSchema
>;
export type PlatformUserDto = z.infer<typeof platformUserSchema>;
export type PlatformUserProvisionResultDto = z.infer<
  typeof platformUserProvisionResultSchema
>;
export type BackofficeWorkspaceCreateInputDto = z.infer<
  typeof backofficeWorkspaceCreateInputSchema
>;
export type BackofficeWorkspaceResponsibleDto = z.infer<
  typeof backofficeWorkspaceResponsibleSchema
>;
export type BackofficeWorkspaceDto = z.infer<typeof backofficeWorkspaceSchema>;
export type BackofficeWorkspaceListDto = z.infer<
  typeof backofficeWorkspaceListSchema
>;
export type BackofficeWorkspaceCreateResultDto = z.infer<
  typeof backofficeWorkspaceCreateResultSchema
>;
export type BackofficeWorkspaceActivationReissueResultDto = z.infer<
  typeof backofficeWorkspaceActivationReissueResultSchema
>;
