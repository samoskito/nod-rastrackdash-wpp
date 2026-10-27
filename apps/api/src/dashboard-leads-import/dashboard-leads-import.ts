import { Prisma, type PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  hashPhoneIdentity,
  hashPhoneIdentityVariants,
} from "../common/phone/phone-identity";
import { acquirePlatformWorkspaceWriteLocks } from "../common/prisma/workspace-write-concurrency";
import {
  isLeadLifetimeEvent,
  leadLifetimeMetaEventId,
  MANUAL_CONVERSION_TRIGGER,
  resolveLeadConversionIdentity,
} from "../conversion-events/lead-lifetime-conversion-guard";
import {
  MANUAL_CONVERSION_PROCESSING_MODE,
  manualIdempotentDedupeKey,
  type ManualConversionSourcePayload,
} from "../leads/manual-conversion-payload";
import { LeadsService } from "../leads/leads.service";
import {
  crmDedupeKey,
  crmEventId,
  META_LEAD_FORM_CRM_TRIGGER,
} from "../meta-lead-forms/meta-crm-capi";

/**
 * One-time import of the Dashboard Leads history (Supabase) into workspaces.
 * Lead form and WhatsApp leads only (the landing page source is out of
 * scope). Idempotent: people by phone, submissions by Meta lead id, events by
 * the dedupe key the nod itself would use, so an event Dashboard Leads already
 * sent is recorded as "imported" and never sent again.
 *
 * Fase 6.9 (PR #92 do nod, sem o #90): the keys are the ones of the nod after
 * the #153/#158 port, not the #90 "manual_status" ones:
 * - lead form: the CRM stage key/event_id of meta_lead_form_crm (6.9);
 * - WhatsApp: a manual conversion ("manual_conversion", status imported) with
 *   the once-per-lead event_id of #153 (leadLifetimeMetaEventId). The #153
 *   guard and the CRM Kanban count it, so neither an automation nor a new
 *   manual registration sends it again.
 */

/** createdByUserId/Name of the imported manual conversions. */
export const DASHBOARD_LEADS_IMPORT_ACTOR = "dashboard_leads_import";
const DASHBOARD_LEADS_IMPORT_ACTOR_NAME = "Importação do Dashboard Leads";

export const DASHBOARD_LEADS_SOURCE = "dashboard_leads";
export const DASHBOARD_LEADS_IMPORT_TRIGGER = "dashboard_leads_import";

export type DashboardLeadsProject = {
  id: string;
  slug: string;
  name: string;
  active: boolean;
};

export type DashboardLeadsLead = {
  id: string;
  project_id: string | null;
  source: "lead_form" | "whatsapp" | "web";
  meta_lead_id: string | null;
  ctwa_clid: string | null;
  page_id: string | null;
  form_id: string | null;
  campaign_id: string | null;
  adset_id: string | null;
  ad_id: string | null;
  created_time: string | null;
  created_at: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  field_data: unknown;
  status: "novo" | "contatado" | "qualificado" | "descartado";
  status_changed_at: string | null;
  qualified_at: string | null;
  notes: string | null;
  sent_to_meta: boolean;
  sent_at: string | null;
  event_name: string | null;
  meta_fbtrace_id: string | null;
};

export type DashboardLeadsSource = {
  listProjects(): Promise<DashboardLeadsProject[]>;
  /** Pages of leads in creation order. */
  leadPages(): AsyncIterable<DashboardLeadsLead[]>;
};

type ProjectReport = {
  leads: number;
  peopleCreated: number;
  peopleMatched: number;
  submissions: number;
  importedEvents: number;
  statusUpdated: number;
  qualifiedNotSent: number;
  notesNotImported: number;
  skippedWeb: number;
  skippedWithoutConnection: number;
  /** Sent to Meta with an event name the nod has no once-per-lead key for. */
  eventsNotImported: number;
};

export type DashboardLeadsImportReport = {
  apply: boolean;
  unmappedProjects: string[];
  skippedInactiveProjects: string[];
  /** Companies (workspaces) created for the owner; in a dry-run, to create. */
  workspacesCreated: string[];
  /** Companies the owner already had with the same slug. */
  workspacesReused: string[];
  unroutedLeads: number;
  projects: Record<string, ProjectReport>;
};

const STATUS_RANK = { new: 0, active: 1, lost: 2, qualified: 3, converted: 4 };
type RastrackStatus = keyof typeof STATUS_RANK;

const STATUS_MAP: Record<DashboardLeadsLead["status"], RastrackStatus> = {
  novo: "new",
  contatado: "active",
  descartado: "lost",
  qualificado: "qualified",
};

function date(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function emptyReport(): ProjectReport {
  return {
    leads: 0,
    peopleCreated: 0,
    peopleMatched: 0,
    submissions: 0,
    importedEvents: 0,
    statusUpdated: 0,
    qualifiedNotSent: 0,
    notesNotImported: 0,
    skippedWeb: 0,
    skippedWithoutConnection: 0,
    eventsNotImported: 0,
  };
}

/**
 * One company per Dashboard Leads project, all owned by the same client login,
 * so the "Selecionar empresa" switcher lists them like the old tabs. Same
 * records as the backoffice screen: workspace, owner membership and the two
 * audit entries.
 */
async function resolveCompanyWorkspace(
  prisma: PrismaClient,
  project: DashboardLeadsProject,
  create: CreateWorkspacesOption,
  apply: boolean,
  report: DashboardLeadsImportReport,
): Promise<string> {
  const existing = await prisma.workspace.findUnique({
    where: { slug: project.slug },
    select: {
      id: true,
      members: {
        where: { userId: create.ownerUserId, role: "owner" },
        select: { id: true },
      },
    },
  });

  if (existing) {
    if (existing.members.length === 0) {
      throw new Error(
        `Já existe um workspace "${project.slug}" de outro dono. Use --map ${project.slug}=<workspaceId>.`,
      );
    }
    report.workspacesReused.push(project.slug);
    return existing.id;
  }

  report.workspacesCreated.push(project.slug);
  if (!apply) {
    // Dry-run: a placeholder no row will match.
    return `(nova:${project.slug})`;
  }

  return prisma.$transaction(async (tx) => {
    // Same locks as the backoffice "Criar workspace" (platform role + slug).
    await acquirePlatformWorkspaceWriteLocks(tx);
    const workspace = await tx.workspace.create({
      data: { name: project.name, slug: project.slug },
      select: { id: true, slug: true },
    });
    const member = await tx.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: create.ownerUserId,
        role: "owner",
      },
      select: { id: true },
    });
    const actor = { actorUserId: create.actorUserId, actorType: "platform_owner" };
    await tx.auditLog.create({
      data: {
        workspaceId: workspace.id,
        ...actor,
        action: "backoffice.workspace_created",
        targetType: "Workspace",
        targetId: workspace.id,
        resultStatus: "success",
        afterSummary: {
          slug: workspace.slug,
          responsibleUserId: create.ownerUserId,
          responsibleRole: "owner",
          source: DASHBOARD_LEADS_IMPORT_TRIGGER,
        },
      },
    });
    await tx.auditLog.create({
      data: {
        workspaceId: workspace.id,
        ...actor,
        action: "backoffice.workspace_responsible_reused",
        targetType: "WorkspaceMember",
        targetId: member.id,
        resultStatus: "success",
        afterSummary: {
          userId: create.ownerUserId,
          role: "owner",
          reusedExistingUser: true,
          activationRequired: false,
          source: DASHBOARD_LEADS_IMPORT_TRIGGER,
        },
      },
    });

    return workspace.id;
  });
}

/** Only moves forward; lost never overrides a qualification. */
export function nextStatus(
  current: RastrackStatus,
  imported: RastrackStatus,
): RastrackStatus | null {
  if (imported === current) return null;
  if (imported === "lost") return current === "new" || current === "active" ? "lost" : null;
  return STATUS_RANK[imported] > STATUS_RANK[current] ? imported : null;
}

export type CreateWorkspacesOption = {
  /** Client login that owns every created company (never a platform user). */
  ownerUserId: string;
  /** Platform owner recorded in the audit, as on the backoffice screen. */
  actorUserId: string;
};

export async function runDashboardLeadsImport(
  prisma: PrismaClient,
  source: DashboardLeadsSource,
  options: {
    apply: boolean;
    workspaceBySlug: Record<string, string>;
    createWorkspaces?: CreateWorkspacesOption;
    /**
     * Called once before any write of an --apply run. The script passes the
     * license check: a blocked license refuses the import (as the 423 of every
     * write); the dry-run never writes and never asks.
     */
    assertCanWrite?: () => Promise<void>;
  },
): Promise<DashboardLeadsImportReport> {
  if (options.apply) await options.assertCanWrite?.();
  const projects = await source.listProjects();
  const workspaceByProject = new Map<string, { slug: string; workspaceId: string }>();
  const report: DashboardLeadsImportReport = {
    apply: options.apply,
    unmappedProjects: [],
    skippedInactiveProjects: [],
    workspacesCreated: [],
    workspacesReused: [],
    unroutedLeads: 0,
    projects: {},
  };

  for (const project of projects) {
    let workspaceId: string | undefined = options.workspaceBySlug[project.slug];

    if (workspaceId) {
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true },
      });
      if (!workspace) {
        throw new Error(`Workspace ${workspaceId} (${project.slug}) nao existe.`);
      }
    } else if (!options.createWorkspaces) {
      report.unmappedProjects.push(project.slug);
      continue;
    } else if (!project.active) {
      report.skippedInactiveProjects.push(project.slug);
      continue;
    } else {
      workspaceId = await resolveCompanyWorkspace(
        prisma,
        project,
        options.createWorkspaces,
        options.apply,
        report,
      );
    }

    workspaceByProject.set(project.id, { slug: project.slug, workspaceId });
    report.projects[project.slug] = emptyReport();
  }

  const leads = new LeadsService(prisma as never);

  for await (const page of source.leadPages()) {
    for (const lead of page) {
      const target = lead.project_id
        ? workspaceByProject.get(lead.project_id)
        : undefined;
      if (!target) {
        if (!lead.project_id) report.unroutedLeads++;
        continue;
      }

      await importLead(
        prisma,
        leads,
        target.workspaceId,
        lead,
        report.projects[target.slug]!,
        options.apply,
      );
    }
  }

  return report;
}

async function importLead(
  prisma: PrismaClient,
  leads: LeadsService,
  workspaceId: string,
  lead: DashboardLeadsLead,
  report: ProjectReport,
  apply: boolean,
) {
  report.leads++;
  if (lead.source === "web") {
    report.skippedWeb++;
    return;
  }
  if (lead.notes?.trim()) report.notesNotImported++;

  const variants = lead.phone ? hashPhoneIdentityVariants([lead.phone]) : [];
  const existing = variants.length
    ? await prisma.lead.findFirst({
        where: { workspaceId, phoneHash: { in: variants } },
        select: { id: true, phoneHash: true, status: true },
        orderBy: { createdAt: "asc" },
      })
    : null;
  const identity = lead.meta_lead_id
    ? `meta_lead:${lead.meta_lead_id}`
    : `ctwa:${lead.ctwa_clid ?? lead.id}`;
  const phoneHash =
    existing?.phoneHash ??
    hashPhoneIdentity(lead.phone ?? undefined) ??
    createHash("sha256").update(identity).digest("hex");
  const firstAt = date(lead.created_time) ?? date(lead.created_at) ?? new Date();

  if (existing) report.peopleMatched++;
  else report.peopleCreated++;

  const connection = lead.meta_lead_id
    ? await prisma.metaLeadFormConnection.findFirst({
        where: { workspaceId, pageId: lead.page_id ?? "" },
      })
    : null;
  if (lead.meta_lead_id && !connection) report.skippedWithoutConnection++;
  if (lead.meta_lead_id && connection) report.submissions++;

  const importedStatus = STATUS_MAP[lead.status];
  const status = nextStatus(
    (existing?.status as RastrackStatus | undefined) ?? "active",
    importedStatus,
  );
  if (status) report.statusUpdated++;
  if (lead.status === "qualificado" && !lead.sent_to_meta) report.qualifiedNotSent++;
  const sentEvent = lead.sent_to_meta && Boolean(lead.event_name);
  // Lead form events of a lead without connection have no dedupe target. A
  // WhatsApp event is imported under the nod key of its event (#153): only the
  // once-per-lead events of the catalog (LeadSubmitted, QualifiedLead).
  const whatsappEventKnown =
    lead.source === "whatsapp" && isLeadLifetimeEvent(lead.event_name ?? "");
  const recordsEvent =
    sentEvent && (whatsappEventKnown || (lead.source === "lead_form" && Boolean(connection)));
  if (recordsEvent) report.importedEvents++;
  else if (sentEvent && lead.source === "whatsapp") report.eventsNotImported++;

  if (!apply) return;

  const person = await leads.upsertFromWhatsappWebhook({
    workspaceId,
    name: lead.full_name ?? undefined,
    phone:
      existing || !hashPhoneIdentity(lead.phone ?? undefined)
        ? undefined
        : (lead.phone ?? undefined),
    phoneHash,
    source: DASHBOARD_LEADS_SOURCE,
    preserveExistingSource: true,
    preserveExistingName: true,
    recordMessageTimestamps: Boolean(lead.ctwa_clid),
    firstMessageAt: firstAt,
    lastMessageAt: firstAt,
    preserveEarliestFirstMessageAt: true,
    ...(existing
      ? { ctwaClid: lead.ctwa_clid ?? undefined }
      : {
          ctwaClid: lead.ctwa_clid ?? undefined,
          campaignId: lead.campaign_id ?? undefined,
          adSetId: lead.adset_id ?? undefined,
          adId: lead.ad_id ?? undefined,
        }),
  });
  if (!person) return;

  if (status) {
    await prisma.lead.update({
      where: { id: person.id },
      data: { status },
    });
  }

  if (lead.meta_lead_id && connection) {
    const data = {
      workspaceId,
      connectionId: connection.id,
      leadId: person.id,
      pageId: lead.page_id ?? connection.pageId,
      formId: lead.form_id,
      campaignId: lead.campaign_id,
      adSetId: lead.adset_id,
      adId: lead.ad_id,
      fullName: lead.full_name,
      email: lead.email,
      phone: lead.phone,
      fieldData:
        lead.field_data == null
          ? Prisma.JsonNull
          : (lead.field_data as Prisma.InputJsonValue),
      metaCreatedAt: date(lead.created_time),
      fetchStatus: "fetched",
    };
    await prisma.metaLeadSubmission.upsert({
      where: { metaLeadId: lead.meta_lead_id },
      create: { metaLeadId: lead.meta_lead_id, ...data },
      update: data,
    });
  }

  if (!recordsEvent) return;

  const sentAt = date(lead.sent_at);
  const occurredAt = date(lead.qualified_at) ?? sentAt ?? firstAt;
  const providerResponseSummary = lead.meta_fbtrace_id
    ? { fbtraceId: lead.meta_fbtrace_id }
    : Prisma.JsonNull;

  if (lead.source === "lead_form" && connection) {
    // The CRM stage key/event_id of the 6.9 port (meta_lead_form_crm):
    // qualifying the lead again finds it and never resends the stage.
    // Keyed by the name Dashboard Leads really sent: when it equals the
    // connection event, qualifying again finds it; a different name was never
    // sent under the connection event, which the nod may still send once.
    const eventId = crmEventId(lead.meta_lead_id!, lead.event_name!);
    const dedupeKey = crmDedupeKey(workspaceId, eventId);
    await prisma.conversionEventLog.upsert({
      where: { dedupeKey },
      update: {},
      create: {
        workspaceId,
        leadId: person.id,
        phoneHash,
        customerIdentityKey: phoneHash,
        businessSource: "paid",
        sourceTrigger: META_LEAD_FORM_CRM_TRIGGER,
        eventName: lead.event_name!,
        status: "imported",
        pixelId: connection.crmDatasetId,
        pageId: lead.page_id,
        eventId,
        dedupeKey,
        campaignId: lead.campaign_id,
        adSetId: lead.adset_id,
        adId: lead.ad_id,
        attributionStatus: lead.ad_id ? "attributed" : "missing_ad_id",
        eventOccurredAt: occurredAt,
        sentAt,
        sourceEventId: lead.meta_lead_id,
        sourcePayload: {
          importedFrom: DASHBOARD_LEADS_IMPORT_TRIGGER,
          dashboardLeadsId: lead.id,
          connectionId: connection.id,
        },
        providerResponseSummary,
      },
    });
    return;
  }

  // WhatsApp: a manual conversion already sent by Dashboard Leads, with the
  // once-per-lead event_id of #153 (the id a rule or a manual registration of
  // this lead would use). The #153 guard and the CRM Kanban count it.
  const eventName = lead.event_name!;
  const conversionIdentity = await resolveLeadConversionIdentity(
    prisma,
    workspaceId,
    person.id,
  );
  const idempotencyKey = `dashboard-leads:${lead.id}`;
  const dedupeKey = manualIdempotentDedupeKey(workspaceId, idempotencyKey);
  const sourcePayload: ManualConversionSourcePayload & {
    importedFrom: string;
    dashboardLeadsId: string;
  } = {
    processingMode: MANUAL_CONVERSION_PROCESSING_MODE,
    createdByUserId: DASHBOARD_LEADS_IMPORT_ACTOR,
    createdByName: DASHBOARD_LEADS_IMPORT_ACTOR_NAME,
    note: null,
    orderRef: null,
    orderKey: null,
    idempotencyKey,
    channelId: null,
    importedFrom: DASHBOARD_LEADS_IMPORT_TRIGGER,
    dashboardLeadsId: lead.id,
  };
  await prisma.conversionEventLog.upsert({
    where: { dedupeKey },
    update: {},
    create: {
      workspaceId,
      leadId: person.id,
      phoneHash,
      customerIdentityKey: phoneHash,
      businessSource: lead.ad_id || lead.ctwa_clid ? "paid" : "organic",
      sourceTrigger: MANUAL_CONVERSION_TRIGGER,
      eventName,
      status: "imported",
      pixelId: null,
      pageId: lead.page_id,
      eventId: leadLifetimeMetaEventId(
        workspaceId,
        conversionIdentity.lockIdentity,
        eventName,
      ),
      dedupeKey,
      campaignId: lead.campaign_id,
      adSetId: lead.adset_id,
      adId: lead.ad_id,
      ctwaClid: lead.ctwa_clid,
      attributionStatus: lead.ad_id ? "attributed" : "missing_ad_id",
      eventOccurredAt: occurredAt,
      sentAt,
      sourceEventId: `manual:${idempotencyKey}`,
      sourcePayload: sourcePayload as unknown as Prisma.InputJsonValue,
      providerResponseSummary,
    },
  });
}

/**
 * Supabase REST (PostgREST) reader with the service role key, passed only at
 * run time. No Supabase client dependency.
 */
export function supabaseRestSource(
  url: string,
  serviceRoleKey: string,
  fetcher: typeof fetch = fetch,
  pageSize = 500,
): DashboardLeadsSource {
  const base = url.replace(/\/+$/, "");
  const get = async <T>(path: string): Promise<T> => {
    const response = await fetcher(`${base}/rest/v1/${path}`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`Supabase respondeu HTTP ${response.status} em ${path.split("?")[0]}`);
    }
    return (await response.json()) as T;
  };

  return {
    listProjects: () =>
      get<DashboardLeadsProject[]>("projects?select=id,slug,name,active"),
    async *leadPages() {
      for (let offset = 0; ; offset += pageSize) {
        const page = await get<DashboardLeadsLead[]>(
          `leads?select=*&order=created_at.asc,id.asc&limit=${pageSize}&offset=${offset}`,
        );
        if (page.length === 0) return;
        yield page;
        if (page.length < pageSize) return;
      }
    },
  };
}
