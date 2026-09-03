import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
  ExternalConnectionTestResultDto,
  ExternalConnectorSslModeDto,
  ExternalMysqlCredentialsInputDto,
} from "@wpptrack/shared";
import {
  createConnection,
  type Connection,
  type ConnectionOptions,
  type RowDataPacket,
} from "mysql2/promise";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";

const leadsView = "vw_wpptrack_leads";
const eventsView = "vw_wpptrack_events";

export const EXTERNAL_MYSQL_CONNECTION_FACTORY = Symbol(
  "EXTERNAL_MYSQL_CONNECTION_FACTORY",
);

export type ExternalMysqlConnection = Pick<Connection, "query" | "end">;
export type ExternalMysqlConnectionFactory = (
  options: ConnectionOptions,
) => Promise<ExternalMysqlConnection>;

export type ExternalSyncCursorValue = {
  lastUpdatedAt: Date | null;
  lastExternalId: string | null;
};

export type ExternalLeadRow = {
  externalRowId: string;
  externalLeadId: string | null;
  phone: string;
  name: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  firstMessageAt: string;
  lastMessageAt: string | null;
  qualifiedAt: string | null;
  purchasedAt: string | null;
  adId: string | null;
  ctwaClid: string | null;
  sourceUrl: string | null;
  thumbnailUrl: string | null;
  status: string | null;
  updatedAt: string;
};

export type ExternalEventRow = {
  externalRowId: string;
  dedupeKey: string;
  provider: string;
  eventType: string;
  sourceEventName: string | null;
  externalEventId: string | null;
  externalLeadId: string | null;
  transactionId: string | null;
  phone: string;
  occurredAt: string;
  eventLocalDate: string;
  adId: string | null;
  adSetId: string | null;
  campaignId: string | null;
  ctwaClid: string | null;
  sourceUrl: string | null;
  valueCents: number | null;
  currency: string | null;
  valueSource: string | null;
  duplicateCount: number;
  updatedAt: string;
};

type ViewRow = RowDataPacket & { TABLE_NAME: string };

@Injectable()
export class ExternalMysqlAdapter {
  constructor(
    @Optional()
    @Inject(EXTERNAL_MYSQL_CONNECTION_FACTORY)
    private readonly connectionFactory: ExternalMysqlConnectionFactory = createConnection,
    @Optional()
    @Inject(RUNTIME_ENV)
    private readonly env: RuntimeEnv = process.env,
  ) {}

  async testConnection(
    credentials: ExternalMysqlCredentialsInputDto,
    sslMode: ExternalConnectorSslModeDto,
  ): Promise<ExternalConnectionTestResultDto> {
    const startedAt = Date.now();

    try {
      return await this.withConnection(
        credentials,
        sslMode,
        async (connection) => {
          await this.query(connection, "SELECT 1 AS ok", []);
          const rows = await this.query<ViewRow>(
            connection,
            `SELECT TABLE_NAME
             FROM information_schema.VIEWS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME IN (?, ?)`,
            [credentials.database, leadsView, eventsView],
          );
          const views = new Set(rows.map((row) => String(row.TABLE_NAME)));
          const leadsViewAvailable = views.has(leadsView);
          const eventsViewAvailable = views.has(eventsView);
          const ok = leadsViewAvailable && eventsViewAvailable;

          return {
            ok,
            status: ok ? "connected" : "failed",
            latencyMs: Math.max(0, Date.now() - startedAt),
            leadsViewAvailable,
            eventsViewAvailable,
            errorCode: ok ? null : "RequiredViewsMissing",
            message: ok
              ? "Conexao e views obrigatorias validadas"
              : "Conexao estabelecida, mas faltam views obrigatorias",
          };
        },
      );
    } catch (error) {
      return {
        ok: false,
        status: "failed",
        latencyMs: Math.max(0, Date.now() - startedAt),
        leadsViewAvailable: false,
        eventsViewAvailable: false,
        errorCode: this.errorCode(error),
        message: this.safeErrorMessage(error),
      };
    }
  }

  async readLeadsPage(
    credentials: ExternalMysqlCredentialsInputDto,
    sslMode: ExternalConnectorSslModeDto,
    cursor: ExternalSyncCursorValue,
    limit: number,
  ): Promise<ExternalLeadRow[]> {
    return this.withConnection(credentials, sslMode, async (connection) => {
      const hasThumbnailUrl = await this.viewHasColumn(
        connection,
        leadsView,
        "thumbnail_url",
      );
      const thumbnailSelection = hasThumbnailUrl
        ? "thumbnail_url AS thumbnailUrl"
        : "NULL AS thumbnailUrl";
      const rows = await this.query<RowDataPacket>(
        connection,
        `SELECT
           CAST(external_row_id AS CHAR) AS externalRowId,
           CAST(external_lead_id AS CHAR) AS externalLeadId,
           phone,
           name,
           email,
           city,
           state,
           country,
           first_message_at AS firstMessageAt,
           last_message_at AS lastMessageAt,
           qualified_at AS qualifiedAt,
           purchased_at AS purchasedAt,
           CAST(ad_id AS CHAR) AS adId,
           ctwa_clid AS ctwaClid,
           source_url AS sourceUrl,
           ${thumbnailSelection},
           status,
           updated_at AS updatedAt
         FROM ${leadsView}
        WHERE (updated_at > ? OR (updated_at = ? AND CAST(external_row_id AS CHAR) > ?))
        ORDER BY updated_at ASC, CAST(external_row_id AS CHAR) ASC
        LIMIT ?`,
        this.cursorValues(cursor, limit),
      );

      return rows.map((row) => this.toLeadRow(row));
    });
  }

  async readEventsPage(
    credentials: ExternalMysqlCredentialsInputDto,
    sslMode: ExternalConnectorSslModeDto,
    cursor: ExternalSyncCursorValue,
    limit: number,
  ): Promise<ExternalEventRow[]> {
    return this.withConnection(credentials, sslMode, async (connection) => {
      const rows = await this.query<RowDataPacket>(
        connection,
        `SELECT
           CAST(external_row_id AS CHAR) AS externalRowId,
           dedupe_key AS dedupeKey,
           provider,
           event_type AS eventType,
           source_event_name AS sourceEventName,
           external_event_id AS externalEventId,
           external_lead_id AS externalLeadId,
           transaction_id AS transactionId,
           phone,
           occurred_at AS occurredAt,
           event_local_date AS eventLocalDate,
           CAST(ad_id AS CHAR) AS adId,
           CAST(adset_id AS CHAR) AS adSetId,
           CAST(campaign_id AS CHAR) AS campaignId,
           ctwa_clid AS ctwaClid,
           source_url AS sourceUrl,
           value_cents AS valueCents,
           currency,
           value_source AS valueSource,
           duplicate_count AS duplicateCount,
           updated_at AS updatedAt
         FROM ${eventsView}
        WHERE (updated_at > ? OR (updated_at = ? AND CAST(external_row_id AS CHAR) > ?))
        ORDER BY updated_at ASC, CAST(external_row_id AS CHAR) ASC
        LIMIT ?`,
        this.cursorValues(cursor, limit),
      );

      return rows.map((row) => this.toEventRow(row));
    });
  }

  private async withConnection<T>(
    credentials: ExternalMysqlCredentialsInputDto,
    sslMode: ExternalConnectorSslModeDto,
    operation: (connection: ExternalMysqlConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.connectionFactory(
      this.connectionOptions(credentials, sslMode),
    );

    try {
      await this.query(connection, "SET SESSION TRANSACTION READ ONLY", []);
      return await operation(connection);
    } finally {
      await connection.end();
    }
  }

  private connectionOptions(
    credentials: ExternalMysqlCredentialsInputDto,
    sslMode: ExternalConnectorSslModeDto,
  ): ConnectionOptions {
    return {
      host: credentials.host,
      port: credentials.port,
      database: credentials.database,
      user: credentials.username,
      password: credentials.password,
      connectTimeout: this.positiveIntegerEnv(
        "WPPTRACK_EXTERNAL_MYSQL_CONNECT_TIMEOUT_MS",
        5_000,
      ),
      timezone: "Z",
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
      ssl:
        sslMode === "disabled"
          ? undefined
          : {
              rejectUnauthorized: sslMode === "verify_identity",
              ...(credentials.sslCa ? { ca: credentials.sslCa } : {}),
            },
    };
  }

  private async query<T extends RowDataPacket>(
    connection: ExternalMysqlConnection,
    sql: string,
    values: unknown[],
  ): Promise<T[]> {
    const [rows] = await connection.query<T[]>({
      sql,
      values,
      timeout: this.positiveIntegerEnv(
        "WPPTRACK_EXTERNAL_MYSQL_QUERY_TIMEOUT_MS",
        10_000,
      ),
    });

    return rows;
  }

  private async viewHasColumn(
    connection: ExternalMysqlConnection,
    viewName: string,
    columnName: string,
  ): Promise<boolean> {
    try {
      const rows = await this.query<RowDataPacket>(
        connection,
        `SELECT COUNT(*) AS columnCount
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = ?
            AND COLUMN_NAME = ?`,
        [viewName, columnName],
      );

      return Number(rows[0]?.columnCount ?? 0) > 0;
    } catch {
      return false;
    }
  }

  private cursorValues(
    cursor: ExternalSyncCursorValue,
    limit: number,
  ): unknown[] {
    const timestamp = cursor.lastUpdatedAt ?? new Date(0);
    return [
      timestamp,
      timestamp,
      cursor.lastExternalId ?? "",
      this.safeLimit(limit),
    ];
  }

  private safeLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit < 1) {
      return 1;
    }

    return Math.min(limit, 1_000);
  }

  private toLeadRow(row: RowDataPacket): ExternalLeadRow {
    return {
      externalRowId: this.requiredString(row.externalRowId, "external_row_id"),
      externalLeadId: this.optionalString(row.externalLeadId),
      phone: this.requiredString(row.phone, "phone"),
      name: this.optionalString(row.name),
      email: this.optionalString(row.email),
      city: this.optionalString(row.city),
      state: this.optionalString(row.state),
      country: this.optionalString(row.country),
      firstMessageAt: this.requiredString(
        row.firstMessageAt,
        "first_message_at",
      ),
      lastMessageAt: this.optionalString(row.lastMessageAt),
      qualifiedAt: this.optionalString(row.qualifiedAt),
      purchasedAt: this.optionalString(row.purchasedAt),
      adId: this.optionalString(row.adId),
      ctwaClid: this.optionalString(row.ctwaClid),
      sourceUrl: this.optionalString(row.sourceUrl),
      thumbnailUrl: this.optionalString(row.thumbnailUrl),
      status: this.optionalString(row.status),
      updatedAt: this.requiredString(row.updatedAt, "updated_at"),
    };
  }

  private toEventRow(row: RowDataPacket): ExternalEventRow {
    const value = row.valueCents;

    return {
      externalRowId: this.requiredString(row.externalRowId, "external_row_id"),
      dedupeKey: this.requiredString(row.dedupeKey, "dedupe_key"),
      provider: this.requiredString(row.provider, "provider"),
      eventType: this.requiredString(row.eventType, "event_type"),
      sourceEventName: this.optionalString(row.sourceEventName),
      externalEventId: this.optionalString(row.externalEventId),
      externalLeadId: this.optionalString(row.externalLeadId),
      transactionId: this.optionalString(row.transactionId),
      phone: this.requiredString(row.phone, "phone"),
      occurredAt: this.requiredString(row.occurredAt, "occurred_at"),
      eventLocalDate: this.requiredString(
        row.eventLocalDate,
        "event_local_date",
      ),
      adId: this.optionalString(row.adId),
      adSetId: this.optionalString(row.adSetId),
      campaignId: this.optionalString(row.campaignId),
      ctwaClid: this.optionalString(row.ctwaClid),
      sourceUrl: this.optionalString(row.sourceUrl),
      valueCents:
        value === null || value === undefined
          ? null
          : Number.parseInt(String(value), 10),
      currency: this.optionalString(row.currency),
      valueSource: this.optionalString(row.valueSource),
      duplicateCount: Number.parseInt(String(row.duplicateCount ?? 0), 10) || 0,
      updatedAt: this.requiredString(row.updatedAt, "updated_at"),
    };
  }

  private requiredString(value: unknown, field: string): string {
    const parsed = this.optionalString(value);

    if (!parsed) {
      throw new Error(`External row missing ${field}`);
    }

    return parsed;
  }

  private optionalString(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    const parsed = String(value).trim();
    return parsed || null;
  }

  private positiveIntegerEnv(name: string, fallback: number): number {
    const parsed = Number.parseInt(this.env[name] ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, 30_000)
      : fallback;
  }

  private errorCode(error: unknown): string {
    if (error && typeof error === "object" && "code" in error) {
      const code = String((error as { code?: unknown }).code ?? "").trim();
      if (
        [
          "ER_ACCESS_DENIED_ERROR",
          "ECONNREFUSED",
          "ETIMEDOUT",
          "PROTOCOL_SEQUENCE_TIMEOUT",
          "ENOTFOUND",
        ].includes(code)
      ) {
        return code;
      }
    }

    return "ExternalMysqlConnectionFailed";
  }

  private safeErrorMessage(error: unknown): string {
    switch (this.errorCode(error)) {
      case "ER_ACCESS_DENIED_ERROR":
        return "Acesso negado pelo MySQL";
      case "ECONNREFUSED":
        return "O servidor MySQL recusou a conexao";
      case "ETIMEDOUT":
      case "PROTOCOL_SEQUENCE_TIMEOUT":
        return "A conexao MySQL excedeu o tempo limite";
      case "ENOTFOUND":
        return "O host MySQL nao foi encontrado";
      default:
        return "Nao foi possivel validar a conexao MySQL";
    }
  }
}
