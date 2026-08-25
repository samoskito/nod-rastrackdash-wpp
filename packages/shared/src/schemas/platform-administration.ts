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
