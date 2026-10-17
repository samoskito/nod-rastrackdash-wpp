import { Prisma, type PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  hashPhoneIdentity,
  hashPhoneIdentityVariants,
} from "../common/phone/phone-identity";
import {
  MANUAL_STATUS_TRIGGER,
  META_LEAD_FORM_CRM_TRIGGER,
} from "../conversion-events/conversion-events.service";
import { LeadsService } from "../leads/leads.service";

/**
 * One-time import of the Dashboard Leads history (Supabase) into workspaces.
 * Lead form and WhatsApp leads only (the landing page source is out of
 * scope). Idempotent: people by phone, submissions by Meta lead id, events by
 * the dedupe key the lead screen would use, so an event Dashboard Leads already
 * sent is recorded as "imported" and never sent again.
 */

export const DASHBOARD_LEADS_SOURCE = "dashboard_leads";
export const DASHBOARD_LEADS_IMPORT_TRIGGER = "dashboard_leads_import";

export type DashboardLeadsProject = { id: string; slug: string };

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
};

export type DashboardLeadsImportReport = {
  apply: boolean;
  unmappedProjects: string[];
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
  };
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

export async function runDashboardLeadsImport(
  prisma: PrismaClient,
  source: DashboardLeadsSource,
  options: { apply: boolean; workspaceBySlug: Record<string, string> },
): Promise<DashboardLeadsImportReport> {
  const projects = await source.listProjects();
  const workspaceByProject = new Map<string, { slug: string; workspaceId: string }>();
  const report: DashboardLeadsImportReport = {
    apply: options.apply,
    unmappedProjects: [],
    unroutedLeads: 0,
    projects: {},
  };

  for (const project of projects) {
    const workspaceId = options.workspaceBySlug[project.slug];
    if (!workspaceId) {
      report.unmappedProjects.push(project.slug);
      continue;
    }
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} (${project.slug}) nao existe.`);
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
  // Lead form events of a lead without connection have no dedupe target.
  const recordsEvent =
    sentEvent && (lead.source === "whatsapp" || Boolean(connection));
  if (recordsEvent) report.importedEvents++;

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
      data: {
        status,
        statusChangedAt: date(lead.status_changed_at) ?? date(lead.qualified_at),
      },
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

  // The key the lead screen would use: clicking Qualificado again finds it.
  const crm = lead.source === "lead_form" && connection;
  const eventId = crm
    ? `${lead.meta_lead_id}:${connection.qualifiedEventName}`
    : `${lead.ctwa_clid ?? lead.id}:${lead.event_name}`;
  const dedupeKey = crm
    ? [workspaceId, META_LEAD_FORM_CRM_TRIGGER, eventId].join(":")
    : [workspaceId, person.id, MANUAL_STATUS_TRIGGER, "QualifiedLead"].join(":");
  const sentAt = date(lead.sent_at);

  await prisma.conversionEventLog.upsert({
    where: { dedupeKey },
    update: {},
    create: {
      workspaceId,
      leadId: person.id,
      phoneHash,
      customerIdentityKey: phoneHash,
      sourceTrigger: crm ? META_LEAD_FORM_CRM_TRIGGER : MANUAL_STATUS_TRIGGER,
      eventName: lead.event_name!,
      status: "imported",
      pixelId: crm ? connection.crmDatasetId : null,
      pageId: lead.page_id,
      eventId,
      dedupeKey,
      campaignId: lead.campaign_id,
      adSetId: lead.adset_id,
      adId: lead.ad_id,
      ctwaClid: lead.ctwa_clid,
      attributionStatus: lead.ad_id ? "attributed" : "missing_ad_id",
      eventOccurredAt: date(lead.qualified_at) ?? sentAt ?? firstAt,
      sentAt,
      sourceEventId: lead.id,
      sourcePayload: {
        importedFrom: DASHBOARD_LEADS_IMPORT_TRIGGER,
        dashboardLeadsId: lead.id,
        ...(crm ? { connectionId: connection.id } : {}),
      },
      providerResponseSummary: lead.meta_fbtrace_id
        ? { fbtraceId: lead.meta_fbtrace_id }
        : Prisma.JsonNull,
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
    listProjects: () => get<DashboardLeadsProject[]>("projects?select=id,slug"),
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
