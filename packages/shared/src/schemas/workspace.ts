import { z } from "zod";
import { platformRoles, workspaceRoles } from "../roles";

export const workspaceOperationalStatuses = ["active", "blocked"] as const;
export const workspaceInviteStatuses = [
  "pending",
  "sent",
  "failed",
  "accepted",
  "revoked",
  "expired",
] as const;
const invitationalWorkspaceRoles = ["admin", "member"] as const;

export const workspacePermissionsSchema = z.object({
  canInviteMembers: z.boolean(),
  canManageMembers: z.boolean(),
  canGrantMemberManager: z.boolean(),
  canManageBilling: z.boolean(),
  canManageIntegrations: z.boolean(),
  canManageWorkspaceSettings: z.boolean(),
  canTransferOwnership: z.boolean(),
  canViewReports: z.boolean(),
  canExportReports: z.boolean(),
});

export const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  role: z.enum(workspaceRoles),
  operationalStatus: z.enum(workspaceOperationalStatuses).default("active"),
});

export const workspaceListEntrySchema = workspaceSchema.extend({
  permissions: workspacePermissionsSchema,
});

export const workspaceListSchema = z.array(workspaceListEntrySchema);

export const currentWorkspaceSchema = workspaceSchema.extend({
  permissions: workspacePermissionsSchema,
  accessMode: z.enum(["member", "platform_support"]).optional(),
  platformRole: z.enum(platformRoles).nullable().optional(),
});

export const workspaceUpdateInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
});

export const workspaceActiveInputSchema = z.object({
  workspaceId: z.string().trim().min(1),
  // Backoffice routes use the same active-workspace endpoint, but platform
  // admins can select from their separately authorized workspace catalogue.
  // The API still checks that privilege and the selected workspace server-side.
  backoffice: z.literal(true).optional(),
});

export const workspaceBillingSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  asaasCustomerId: z.string().min(1).nullable(),
  operationalStatus: z.enum(workspaceOperationalStatuses),
  subscriptionStatus: z.enum([
    "not_configured",
    "active",
    "pending",
    "overdue",
    "cancelled",
  ]),
  activeInstances: z.number().int().nonnegative(),
});

export const workspaceBillingListSchema = z.array(workspaceBillingSchema);

export const workspaceBillingUpdateInputSchema = z.object({
  asaasCustomerId: z.string().trim().min(1).nullable(),
});

export const workspaceOperationalStatusUpdateInputSchema = z.object({
  operationalStatus: z.enum(workspaceOperationalStatuses),
});

export const workspaceMemberSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  email: z.string().email(),
  name: z.string().nullable(),
  role: z.enum(workspaceRoles),
  canManageMembers: z.boolean(),
  joinedAt: z.string().datetime(),
});

export const workspaceMemberRoleUpdateInputSchema = z.object({
  role: z.enum(["admin", "member"]),
});

export const workspaceMemberManagerUpdateInputSchema = z.object({
  canManageMembers: z.boolean(),
});

export const workspaceInviteInputSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .transform((email) => email.toLowerCase()),
  role: z.enum(invitationalWorkspaceRoles),
});

export const workspaceInviteSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  role: z.enum(invitationalWorkspaceRoles),
  status: z.enum(workspaceInviteStatuses),
  expiresAt: z.string().datetime(),
  acceptUrl: z.string().url().optional(),
});

export const workspaceInviteAcceptInputSchema = z.object({
  token: z.string().trim().min(16),
});

export const workspaceInviteNewUserAcceptInputSchema =
  workspaceInviteAcceptInputSchema.extend({
    name: z.string().trim().min(2).max(120),
    password: z.string().min(8).max(128),
  });

export const workspaceInviteInspectionSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("invalid"),
  }),
  z.object({
    state: z.literal("valid"),
    workspaceName: z.string().min(1),
    emailHint: z.string().min(3),
    role: z.enum(invitationalWorkspaceRoles),
    accountMode: z.enum(["login", "create"]),
    expiresAt: z.string().datetime(),
  }),
]);

export const workspaceInviteAcceptSchema = z.object({
  workspaceId: z.string().min(1),
  memberId: z.string().min(1),
  role: z.enum(invitationalWorkspaceRoles),
  status: z.literal("accepted"),
});

export type WorkspaceDto = z.infer<typeof workspaceSchema>;
export type WorkspaceListEntryDto = z.infer<typeof workspaceListEntrySchema>;
export type WorkspaceListDto = z.infer<typeof workspaceListSchema>;
export type WorkspacePermissionsDto = z.infer<
  typeof workspacePermissionsSchema
>;
export type CurrentWorkspaceDto = z.infer<typeof currentWorkspaceSchema>;
export type WorkspaceActiveInputDto = z.infer<
  typeof workspaceActiveInputSchema
>;
export type WorkspaceUpdateInputDto = z.infer<
  typeof workspaceUpdateInputSchema
>;
export type WorkspaceBillingDto = z.infer<typeof workspaceBillingSchema>;
export type WorkspaceBillingListDto = z.infer<
  typeof workspaceBillingListSchema
>;
export type WorkspaceBillingUpdateInputDto = z.infer<
  typeof workspaceBillingUpdateInputSchema
>;
export type WorkspaceOperationalStatus =
  (typeof workspaceOperationalStatuses)[number];
export type WorkspaceOperationalStatusUpdateInputDto = z.infer<
  typeof workspaceOperationalStatusUpdateInputSchema
>;
export type WorkspaceMemberDto = z.infer<typeof workspaceMemberSchema>;
export type WorkspaceMemberRoleUpdateInputDto = z.infer<
  typeof workspaceMemberRoleUpdateInputSchema
>;
export type WorkspaceMemberManagerUpdateInputDto = z.infer<
  typeof workspaceMemberManagerUpdateInputSchema
>;
export type WorkspaceInviteInputDto = z.infer<
  typeof workspaceInviteInputSchema
>;
export type WorkspaceInviteDto = z.infer<typeof workspaceInviteSchema>;
export type WorkspaceInviteAcceptInputDto = z.infer<
  typeof workspaceInviteAcceptInputSchema
>;
export type WorkspaceInviteNewUserAcceptInputDto = z.infer<
  typeof workspaceInviteNewUserAcceptInputSchema
>;
export type WorkspaceInviteInspectionDto = z.infer<
  typeof workspaceInviteInspectionSchema
>;
export type WorkspaceInviteAcceptDto = z.infer<
  typeof workspaceInviteAcceptSchema
>;

// Client Swap schemas
export const clientSwapDto = z.object({
  confirm: z.literal(true, {
    errorMap: () => ({ message: 'Confirmação obrigatória: envie confirm: true' }),
  }),
  newClientName: z.string().min(1).max(100).optional(),
});

// Replay: a completed swap with the same Idempotency-Key returns HTTP 200
// with replayed: true and the recorded afterSummary. The wipe is never re-executed.
export const clientSwapResultSchema = z.object({
  success: z.literal(true),
  replayed: z.literal(true).optional(),
  wipedCounts: z.record(z.string(), z.number().int().nonnegative()),
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    operationalStatus: z.enum(workspaceOperationalStatuses),
  }),
});

export type ClientSwapDto = z.infer<typeof clientSwapDto>;
export type ClientSwapResult = z.infer<typeof clientSwapResultSchema>;
