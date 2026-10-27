import type { ReportPaginationDto } from "@wpptrack/shared";
import { ArrowRight, Lightbulb } from "lucide-react";
import Link from "next/link";
import { PresentationMask } from "../../../components/presentation-mask";
import { ReportAdPreview } from "./report-ad-preview";
import {
  REPORT_INSIGHT_COST_DELTA_THRESHOLD,
  REPORT_INSIGHT_MIN_SAMPLE,
  REPORT_INSIGHT_SHARE_THRESHOLD,
  REPORT_INSIGHT_TOP_N,
  buildReportInsightRanking,
  formatReportInsightMoney,
  reportInsightCost,
  reportInsightObjectiveLabel,
  reportInsightObjectiveTracked,
  reportInsightVolume,
  type ReportInsightItem,
  type ReportInsightKind,
  type ReportInsightMetrics,
  type ReportInsightObjective,
  type ReportInsightSourceRow,
} from "./report-insights";

export type ReportInsightLevel = "campaigns" | "adsets" | "ads";

export type ReportInsightRow = ReportInsightSourceRow & {
  adSetName?: string;
  campaignId?: string;
  campaignName?: string;
  previewUrl?: string | null;
  thumbnailUrl?: string | null;
  thumbnailVersion?: string | null;
};

export type ReportInsightFetch =
  | {
      state: "real";
      pagination?: ReportPaginationDto;
      rows: ReportInsightRow[];
      totals?: ReportInsightMetrics;
    }
  | { state: "error" };

export type ReportInsightObjectiveLink = {
  href: string;
  objective: ReportInsightObjective;
};

const levelCopy: Record<
  ReportInsightLevel,
  { none: string; plural: string; pluralTitle: string; singular: string }
> = {
  campaigns: {
    none: "Nenhuma campanha",
    plural: "campanhas",
    pluralTitle: "Campanhas",
    singular: "campanha",
  },
  adsets: {
    none: "Nenhum conjunto",
    plural: "conjuntos",
    pluralTitle: "Conjuntos",
    singular: "conjunto",
  },
  ads: {
    none: "Nenhum anúncio",
    plural: "anúncios",
    pluralTitle: "Anúncios",
    singular: "anúncio",
  },
};

const namePlaceholders: Record<ReportInsightLevel, string> = {
  campaigns: "Campanha oculta",
  adsets: "Conjunto oculto",
  ads: "Anúncio oculto",
};

function countLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function InsightState({
  message,
  title,
  tone = "neutral",
}: {
  message: string;
  title: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <div className={`report-insight-state ${tone}`} role="status">
      <strong>{title}</strong>
      <span>{message}</span>
    </div>
  );
}

function parentLabel(level: ReportInsightLevel, row: ReportInsightRow) {
  if (level === "adsets") {
    return row.campaignName ?? null;
  }

  if (level === "ads") {
    return (
      [row.campaignName, row.adSetName].filter(Boolean).join(" / ") || null
    );
  }

  return null;
}

function InsightItem({
  entityHref,
  item,
  label,
  level,
  totalItems,
}: {
  entityHref?: (row: ReportInsightRow) => string | undefined;
  item: ReportInsightItem<ReportInsightRow>;
  label: string;
  level: ReportInsightLevel;
  totalItems: number;
}) {
  const copy = levelCopy[level];
  const href = entityHref?.(item.row);
  const parent = parentLabel(level, item.row);
  const name = (
    <PresentationMask placeholder={namePlaceholders[level]}>
      {item.row.name}
    </PresentationMask>
  );

  return (
    <li className="report-insight-item" data-insight-rank={item.position}>
      <span className="report-insight-position" aria-hidden="true">
        {item.position}
      </span>
      <div className="report-insight-entity">
        {level === "ads" ? (
          <ReportAdPreview
            adId={item.row.id}
            adName={item.row.name}
            previewUrl={item.row.previewUrl}
            thumbnailUrl={item.row.thumbnailUrl}
            thumbnailVersion={item.row.thumbnailVersion}
          />
        ) : null}
        <div className="report-entity-copy">
          <strong className="report-insight-name">
            {href ? <Link href={href}>{name}</Link> : name}
          </strong>
          {parent ? (
            <span>
              <PresentationMask
                placeholder={
                  level === "ads"
                    ? "Campanha oculta / Conjunto oculto"
                    : "Campanha oculta"
                }
              >
                {parent}
              </PresentationMask>
            </span>
          ) : null}
          <small>
            Posição {item.position} de{" "}
            {countLabel(totalItems, copy.singular, copy.plural)} no filtro
          </small>
        </div>
      </div>
      <dl className="report-insight-metrics">
        <div>
          <dt>Investimento</dt>
          <dd>
            {formatReportInsightMoney(item.row.spendCents, item.row.currency)}
          </dd>
        </div>
        <div>
          <dt>{label}</dt>
          <dd>{item.volume}</dd>
        </div>
        <div>
          <dt>Custo por resultado</dt>
          <dd>
            {item.costCents === null ? (
              <span title="Custo indisponível">-</span>
            ) : (
              formatReportInsightMoney(item.costCents, item.row.currency)
            )}
          </dd>
        </div>
      </dl>
      {item.signals.length > 0 ? (
        <ul className="report-insight-signals" aria-label="Sinais">
          {item.signals.map((signal) => (
            <li key={signal.key}>
              <span className={`event-chip ${signal.tone}`}>
                {signal.label}
              </span>
              <small>{signal.basis}</small>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function InsightRanking({
  entityHref,
  fetch,
  kind,
  label,
  level,
  objective,
  tableHref,
  totals,
}: {
  entityHref?: (row: ReportInsightRow) => string | undefined;
  fetch: ReportInsightFetch;
  kind: ReportInsightKind;
  label: string;
  level: ReportInsightLevel;
  objective: ReportInsightObjective;
  tableHref: string;
  totals?: ReportInsightMetrics;
}) {
  const copy = levelCopy[level];
  const titleId = `report-insight-${kind}-title`;
  const title =
    kind === "volume" ? `Maior volume de ${label}` : `Menor custo por ${label}`;
  const order =
    kind === "volume"
      ? `Ordem da API: ${label} do maior para o menor. Itens com 0 ${label} não entram neste ranking.`
      : `Ordem da API: custo por resultado do menor para o maior. ${copy.pluralTitle} sem ${label} não tem custo calculável e ficam fora deste ranking.`;

  if (fetch.state === "error") {
    return (
      <section className="report-insight-ranking" aria-labelledby={titleId}>
        <header>
          <h3 id={titleId}>{title}</h3>
        </header>
        <InsightState
          tone="warn"
          title="Não foi possível carregar o ranking"
          message="Confira a API e tente novamente. Nenhum valor foi presumido como zero."
        />
      </section>
    );
  }

  const ranking = buildReportInsightRanking({
    kind,
    label,
    objective,
    rows: fetch.rows,
    totals,
  });
  const totalItems = fetch.pagination?.totalItems ?? fetch.rows.length;

  return (
    <section className="report-insight-ranking" aria-labelledby={titleId}>
      <header>
        <h3 id={titleId}>{title}</h3>
        <p>{order}</p>
      </header>
      {ranking.items.length > 0 ? (
        <ol className="report-insight-list">
          {ranking.items.map((item) => (
            <InsightItem
              entityHref={entityHref}
              item={item}
              key={item.id}
              label={label}
              level={level}
              totalItems={totalItems}
            />
          ))}
        </ol>
      ) : kind === "volume" ? (
        <InsightState
          title={`${copy.none} registrou ${label} no período`}
          message={`O total do filtro e 0 ${label}.`}
        />
      ) : (
        <InsightState
          title="Sem custo calculável"
          message={`${copy.none} tem ${label} no período; custo por resultado indisponível.`}
        />
      )}
      <Link
        aria-label={`Ver ranking completo na tabela: ${title}`}
        className="button ghost report-insight-table-link"
        href={tableHref}
      >
        Ver ranking completo na tabela
        <ArrowRight aria-hidden="true" size={15} />
      </Link>
    </section>
  );
}

function InsightTotals({
  label,
  level,
  objective,
  totalItems,
  totals,
}: {
  label: string;
  level: ReportInsightLevel;
  objective: ReportInsightObjective;
  totalItems: number;
  totals: ReportInsightMetrics;
}) {
  const copy = levelCopy[level];
  // `currency: null`: o filtro mistura moedas das contas de anúncio, então não
  // existe investimento nem custo médio únicos para mostrar.
  const mixedCurrency = totals.currency === null;
  const costCents = mixedCurrency ? null : reportInsightCost(objective, totals);

  return (
    <div
      aria-label="Total do filtro"
      className="report-summary-strip report-insight-totals"
      role="group"
    >
      <article>
        <span>Investimento</span>
        <strong>
          {mixedCurrency
            ? "Várias moedas"
            : formatReportInsightMoney(totals.spendCents, totals.currency)}
        </strong>
        <small>
          {mixedCurrency ? "Veja a tabela por moeda" : "Total do filtro"}
        </small>
      </article>
      <article>
        <span>{label}</span>
        <strong>{reportInsightVolume(objective, totals)}</strong>
        <small>Total do filtro</small>
      </article>
      <article>
        <span>Custo por resultado</span>
        <strong>
          {costCents === null
            ? "-"
            : formatReportInsightMoney(costCents, totals.currency)}
        </strong>
        <small>
          {mixedCurrency
            ? "Moedas diferentes"
            : costCents === null
              ? "Custo indisponível"
              : "Media do filtro"}
        </small>
      </article>
      <article>
        <span>Itens no filtro</span>
        <strong>{totalItems}</strong>
        <small>{copy.plural}</small>
      </article>
    </div>
  );
}

function InsightMethod({ zeroSpend }: { zeroSpend: string }) {
  return (
    <details className="report-insight-method">
      <summary>Como ler estes sinais</summary>
      <ul>
        <li>
          <strong>Amostra insuficiente:</strong> menos de{" "}
          {REPORT_INSIGHT_MIN_SAMPLE} resultados no período. O item continua no
          ranking, mas a posição é instável.
        </li>
        <li>
          <strong>Concentração:</strong> item com{" "}
          {Math.round(REPORT_INSIGHT_SHARE_THRESHOLD * 100)}% ou mais do volume
          do filtro.
        </li>
        <li>
          <strong>Custo vs. media:</strong> diferença de{" "}
          {Math.round(REPORT_INSIGHT_COST_DELTA_THRESHOLD * 100)}% ou mais em
          relação ao custo por resultado do filtro inteiro. Não é calculado com
          amostra insuficiente.
        </li>
        <li>
          <strong>Sem investimento:</strong> gasto {zeroSpend} no período. Custo
          zero não é eficiência.
        </li>
        <li>
          <strong>Empate:</strong> mesmo valor de um item vizinho. A API
          desempata pelo nome.
        </li>
      </ul>
      <p>
        Sinais determinísticos e heurísticos, calculados somente com os números
        exibidos. Não indicam causa nem garantem resultado futuro. Nenhuma ação
        e executada automaticamente.
      </p>
    </details>
  );
}

export function ReportInsightsPanel({
  cost,
  costTableHref,
  entityHref,
  level,
  objective,
  objectiveLinks,
  periodLabel,
  volume,
  volumeTableHref,
}: {
  cost: ReportInsightFetch;
  costTableHref: string;
  entityHref?: (row: ReportInsightRow) => string | undefined;
  level: ReportInsightLevel;
  objective: ReportInsightObjective;
  objectiveLinks: ReportInsightObjectiveLink[];
  periodLabel: string;
  volume: ReportInsightFetch;
  volumeTableHref: string;
}) {
  const copy = levelCopy[level];
  const loaded = [volume, cost].find(
    (result): result is Extract<ReportInsightFetch, { state: "real" }> =>
      result.state === "real",
  );
  const totals = loaded?.totals;
  const funnelSteps = totals?.funnelSteps ?? [];
  const label = reportInsightObjectiveLabel(objective, funnelSteps);
  const totalItems = loaded?.pagination?.totalItems ?? loaded?.rows.length ?? 0;
  const tracked =
    reportInsightObjectiveTracked(objective, funnelSteps) ||
    Boolean(
      loaded?.rows.some((row) =>
        reportInsightObjectiveTracked(objective, row.funnelSteps),
      ),
    );

  let body;

  if (!loaded) {
    body = (
      <InsightState
        tone="warn"
        title="Não foi possível carregar o ranking"
        message="Confira a API antes de analisar os insights. Nenhum valor foi presumido como zero."
      />
    );
  } else if (totalItems === 0) {
    body = (
      <InsightState
        title={`${copy.none} no filtro atual`}
        message="Ajuste o período ou os filtros. Sem dados sincronizados, use Sincronizar Meta."
      />
    );
  } else if (!tracked) {
    body = (
      <InsightState
        tone="warn"
        title={`${label} ainda não é rastreado neste filtro`}
        message="O workspace não tem configuração nem eventos desta etapa no período. Os rankings ficam indisponíveis, o que não equivale a zero."
      />
    );
  } else {
    body = (
      <>
        {totals ? (
          <InsightTotals
            label={label}
            level={level}
            objective={objective}
            totalItems={totalItems}
            totals={totals}
          />
        ) : null}
        <p className="report-insight-basis">
          Posições calculadas pela API sobre{" "}
          {countLabel(totalItems, copy.singular, copy.plural)} do filtro atual
          (período, contas, busca, status e seleção), antes da paginação. A
          página da tabela não é usada para ranquear; aqui aparecem até{" "}
          {REPORT_INSIGHT_TOP_N} posições.
        </p>
        <div className="report-insight-grid">
          <InsightRanking
            entityHref={entityHref}
            fetch={volume}
            kind="volume"
            label={label}
            level={level}
            objective={objective}
            tableHref={volumeTableHref}
            totals={totals}
          />
          <InsightRanking
            entityHref={entityHref}
            fetch={cost}
            kind="cost"
            label={label}
            level={level}
            objective={objective}
            tableHref={costTableHref}
            totals={totals}
          />
        </div>
      </>
    );
  }

  return (
    <section
      aria-label="Insights do relatório"
      className="report-results-overview report-insights"
    >
      <div className="report-results-heading">
        <div className="report-results-title">
          <Lightbulb aria-hidden="true" size={20} />
          <div>
            <span className="eyebrow">Insights - {periodLabel}</span>
            <h2>
              {label} por {copy.singular}
            </h2>
          </div>
        </div>
        <nav
          aria-label="Objetivo do insight"
          className="report-metric-tabs report-insight-objectives"
        >
          {objectiveLinks.map((link) => (
            <Link
              aria-current={link.objective === objective ? "page" : undefined}
              className={link.objective === objective ? "active" : ""}
              href={link.href}
              key={link.objective}
            >
              {reportInsightObjectiveLabel(link.objective, funnelSteps)}
            </Link>
          ))}
        </nav>
      </div>
      {body}
      <InsightMethod
        zeroSpend={
          totals?.currency === null
            ? "zero"
            : `de ${formatReportInsightMoney(0, totals?.currency)}`
        }
      />
    </section>
  );
}
