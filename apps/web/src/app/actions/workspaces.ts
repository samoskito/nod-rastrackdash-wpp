"use server";

import {
  workspaceActiveInputSchema,
  type CurrentWorkspaceDto,
} from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import { serverApiFetch } from "../../lib/server-api";

export type WorkspaceSwitchActionResult = {
  ok: boolean;
};

type WorkspaceSwitchSource = "membership" | "backoffice";

export async function switchActiveWorkspace(
  workspaceId: string,
  source: WorkspaceSwitchSource = "membership",
): Promise<WorkspaceSwitchActionResult> {
  const parsed = workspaceActiveInputSchema.safeParse({ workspaceId });

  if (!parsed.success) {
    return { ok: false };
  }

  try {
    await serverApiFetch<CurrentWorkspaceDto>("/workspaces/active", {
      method: "POST",
      body: JSON.stringify(
        source === "backoffice"
          ? { ...parsed.data, backoffice: true }
          : parsed.data,
      ),
    });
  } catch {
    return { ok: false };
  }

  revalidatePath("/", "layout");
  return { ok: true };
}
