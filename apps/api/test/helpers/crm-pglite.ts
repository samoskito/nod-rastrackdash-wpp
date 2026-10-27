import { PGlite } from "@electric-sql/pglite";
import type { Prisma } from "@prisma/client";

/**
 * In-process Postgres (PGlite) with the columns of "Lead" and
 * "ConversionEventLog" the CRM board query reads, so its SQL runs for real
 * in the tests. Nothing touches the project database.
 */

export const CRM_TEST_WS = "ws_1";
export const DAY_MS = 24 * 3600_000;
export const CRM_TEST_NOW = new Date("2026-10-24T15:00:00.000Z");

export type CrmLeadSeed = {
  id: string;
  workspaceId?: string;
  name?: string | null;
  phoneDisplay?: string | null;
  firstMessageAt?: Date | null;
  createdAt?: Date;
  campaignId?: string | null;
  adId?: string | null;
  ctwaClid?: string | null;
  whatsappInstanceId?: string | null;
};

export type CrmLogSeed = {
  leadId: string;
  eventName: string;
  status: string;
  at: Date;
  sourceTrigger?: string;
  errorCode?: string | null;
  valueCents?: number | null;
  currency?: string | null;
  workspaceId?: string;
};

export const daysAgo = (days: number) =>
  new Date(CRM_TEST_NOW.getTime() - days * DAY_MS);

export class CrmTestDb {
  private sequence = 0;
  readonly db: PGlite;

  constructor() {
    // "timestamp" (no tz) holds UTC, as Prisma writes and reads it.
    this.db = new PGlite({
      parsers: {
        1114: (value: string) => new Date(`${value.replace(" ", "T")}Z`),
      },
    });
  }

  async init(): Promise<this> {
    await this.db.exec(`
      CREATE TABLE "Lead" (
        id text PRIMARY KEY,
        "workspaceId" text NOT NULL,
        "whatsappInstanceId" text,
        name text,
        "phoneDisplay" text,
        "campaignId" text,
        "adSetId" text,
        "adId" text,
        "ctwaClid" text,
        "ctwaThumbnailUrl" text,
        "firstMessageAt" timestamp(3),
        "createdAt" timestamp(3) NOT NULL
      );
      CREATE INDEX ON "Lead" ("workspaceId", "firstMessageAt");
      CREATE INDEX ON "Lead" ("workspaceId", "createdAt");
      CREATE TABLE "ConversionEventLog" (
        id text PRIMARY KEY,
        "workspaceId" text,
        "leadId" text,
        "sourceTrigger" text NOT NULL,
        "eventName" text NOT NULL,
        status text NOT NULL,
        "eventOccurredAt" timestamp(3) NOT NULL,
        "errorCode" text,
        "valueCents" integer,
        currency text
      );
      CREATE INDEX ON "ConversionEventLog" ("leadId");
    `);
    return this;
  }

  async run<T>(sql: Prisma.Sql): Promise<T[]> {
    const result = await this.db.query<T>(sql.text, sql.values as unknown[]);
    return result.rows;
  }

  async reset(): Promise<void> {
    await this.db.exec(`DELETE FROM "ConversionEventLog"; DELETE FROM "Lead";`);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async lead(seed: CrmLeadSeed): Promise<void> {
    await this.db.query(
      `INSERT INTO "Lead" (id, "workspaceId", name, "phoneDisplay", "firstMessageAt", "createdAt", "campaignId", "adSetId", "adId", "ctwaClid", "whatsappInstanceId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10)`,
      [
        seed.id,
        seed.workspaceId ?? CRM_TEST_WS,
        seed.name ?? null,
        seed.phoneDisplay ?? null,
        seed.firstMessageAt === undefined
          ? daysAgo(2).toISOString()
          : (seed.firstMessageAt?.toISOString() ?? null),
        (seed.createdAt ?? daysAgo(2)).toISOString(),
        seed.campaignId === undefined ? "camp_1" : seed.campaignId,
        seed.adId === undefined ? "ad_1" : seed.adId,
        seed.ctwaClid === undefined ? "clid" : seed.ctwaClid,
        seed.whatsappInstanceId ?? null,
      ],
    );
  }

  async log(seed: CrmLogSeed): Promise<void> {
    this.sequence += 1;
    await this.db.query(
      `INSERT INTO "ConversionEventLog" (id, "workspaceId", "leadId", "sourceTrigger", "eventName", status, "eventOccurredAt", "errorCode", "valueCents", currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        `log_${String(this.sequence).padStart(6, "0")}`,
        seed.workspaceId ?? CRM_TEST_WS,
        seed.leadId,
        seed.sourceTrigger ?? "inbound_webhook:umbler:message_phrase",
        seed.eventName,
        seed.status,
        seed.at.toISOString(),
        seed.errorCode ?? null,
        seed.valueCents ?? null,
        seed.currency ?? null,
      ],
    );
  }

  /** Leads by id, in the shape the board hydration selects. */
  async leadsByIds(ids: string[]): Promise<Array<Record<string, unknown>>> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT id, name, "phoneDisplay", "campaignId", "adSetId", "adId", "ctwaThumbnailUrl", "whatsappInstanceId" FROM "Lead" WHERE id = ANY($1::text[])`,
      [ids],
    );
    return result.rows;
  }
}
