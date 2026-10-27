"use server";

import {
  crmBoardSchema,
  crmColumnPageSchema,
  type CrmBoardDto,
  type CrmColumnPageDto,
  type LeadDetailDto,
} from "@wpptrack/shared";
import { serverApiFetch } from "../../../lib/server-api";
import { crmQueryString, type CrmFilterValues } from "./crm-filter-params";

/**
 * CRM Kanban reads (design §11/§12). Moving a card is not here: it is the
 * manual conversion action of the lead detail with source "kanban".
 */

/**
 * `fresh` ("Atualizar", after a move): skip the 15 s server cache the 60 s
 * auto-refresh uses.
 */
export async function refreshCrmBoardAction(
  filters: CrmFilterValues,
  fresh = false,
): Promise<{ ok: true; board: CrmBoardDto } | { ok: false }> {
  try {
    const board = crmBoardSchema.parse(
      await serverApiFetch<unknown>(
        `/crm/board?${crmQueryString(filters, { fresh: fresh ? "1" : null })}`,
      ),
    );
    return { ok: true, board };
  } catch {
    return { ok: false };
  }
}

export async function loadCrmColumnAction(
  stageKey: string,
  filters: CrmFilterValues,
  cursor: string,
): Promise<{ ok: true; page: CrmColumnPageDto } | { ok: false }> {
  try {
    const page = crmColumnPageSchema.parse(
      await serverApiFetch<unknown>(
        `/crm/board/columns/${encodeURIComponent(stageKey)}?${crmQueryString(
          filters,
          { cursor },
        )}`,
      ),
    );
    return { ok: true, page };
  } catch {
    return { ok: false };
  }
}

/** Lead detail for the modal (same endpoint as the lead page). */
export async function loadCrmLeadDetailAction(
  leadId: string,
): Promise<{ ok: true; detail: LeadDetailDto } | { ok: false }> {
  try {
    return {
      ok: true,
      detail: await serverApiFetch<LeadDetailDto>(
        `/leads/${encodeURIComponent(leadId)}`,
      ),
    };
  } catch {
    return { ok: false };
  }
}
