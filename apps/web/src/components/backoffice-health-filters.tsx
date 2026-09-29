import type { HealthSection } from "./backoffice-operations-navigation";

export type BackofficeHealthFilterValues = {
  actorType?: string;
  adId?: string;
  adSetId?: string;
  campaignId?: string;
  errorCode?: string;
  eventType?: string;
  jobId?: string;
  jobName?: string;
  leadId?: string;
  phoneHash?: string;
  pixelId?: string;
  q?: string;
  queueName?: string;
  severity?: string;
  since?: string;
  source?: string;
  sourceTrigger?: string;
  status?: string;
  targetType?: string;
  until?: string;
  workspaceId?: string;
};

function FilterField({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <label className="operations-filter-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function SourceField({
  defaultValue,
}: {
  defaultValue?: string;
}) {
  return (
    <FilterField label="Origem">
      <select name="source" defaultValue={defaultValue ?? ""}>
        <option value="">Todas</option>
        <option value="meta">Meta</option>
        <option value="umbler">Umbler</option>
        <option value="gupshup">Gupshup</option>
        <option value="data_crazy">Data Crazy</option>
        <option value="uazapi">NOD API</option>
        <option value="asaas">Asaas</option>
        <option value="internal">Interno</option>
      </select>
    </FilterField>
  );
}

function DateFields({
  since,
  until,
}: {
  since?: string;
  until?: string;
}) {
  return (
    <>
      <FilterField label="Desde">
        <input name="since" type="date" defaultValue={since?.slice(0, 10)} />
      </FilterField>
      <FilterField label="Ate">
        <input name="until" type="date" defaultValue={until?.slice(0, 10)} />
      </FilterField>
    </>
  );
}

function AttributionFields({
  values,
  includePhone = true,
}: {
  values: BackofficeHealthFilterValues;
  includePhone?: boolean;
}) {
  return (
    <>
      <FilterField label="Lead">
        <input name="leadId" placeholder="ID do lead" defaultValue={values.leadId} />
      </FilterField>
      {includePhone ? (
        <FilterField label="Telefone hash">
          <input
            name="phoneHash"
            placeholder="Hash do telefone"
            defaultValue={values.phoneHash}
          />
        </FilterField>
      ) : null}
      <FilterField label="Campanha">
        <input
          name="campaignId"
          placeholder="ID da campanha"
          defaultValue={values.campaignId}
        />
      </FilterField>
      <FilterField label="Conjunto">
        <input
          name="adSetId"
          placeholder="ID do conjunto"
          defaultValue={values.adSetId}
        />
      </FilterField>
      <FilterField label="Anuncio">
        <input name="adId" placeholder="ID do anuncio" defaultValue={values.adId} />
      </FilterField>
    </>
  );
}

export function BackofficeHealthFilters({
  activeCount,
  section,
  values,
}: {
  activeCount: number;
  section: HealthSection;
  values: BackofficeHealthFilterValues;
}) {
  const typeLabel =
    section === "audit"
      ? "Acao"
      : section === "conversions"
        ? "Evento CAPI"
        : section === "integrations"
          ? "Operacao"
          : "Tipo de evento";

  return (
    <form
      className="operations-filter-panel"
      aria-label={`Filtros de ${section}`}
      action="/backoffice"
    >
      <input type="hidden" name="view" value="operations" />
      <input type="hidden" name="area" value="health" />
      <input type="hidden" name="section" value={section} />

      <div className="operations-filter-heading">
        <div>
          <strong>Filtros desta tabela</strong>
          <span>
            {activeCount > 0
              ? `${activeCount} filtro(s) ativo(s)`
              : "Nenhum filtro aplicado"}
          </span>
        </div>
      </div>

      <div className="operations-filter-grid">
        <FilterField label="Busca">
          <input
            name="q"
            placeholder="Erro, evento ou identificador"
            defaultValue={values.q}
          />
        </FilterField>
        <FilterField label="Workspace">
          <input
            name="workspaceId"
            placeholder="ID do workspace"
            defaultValue={values.workspaceId}
          />
        </FilterField>

        {section !== "audit" && section !== "conversions" ? (
          <SourceField defaultValue={values.source} />
        ) : null}

        <FilterField label="Status">
          <input name="status" placeholder="Status" defaultValue={values.status} />
        </FilterField>

        {section === "incidents" ? (
          <FilterField label="Severidade">
            <select name="severity" defaultValue={values.severity ?? ""}>
              <option value="">Todas</option>
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
              <option value="critical">Critical</option>
            </select>
          </FilterField>
        ) : null}

        {section !== "jobs" ? (
          <FilterField label={typeLabel}>
            <input
              name="eventType"
              placeholder={typeLabel}
              defaultValue={values.eventType}
            />
          </FilterField>
        ) : (
          <>
            <FilterField label="Fila">
              <input
                name="queueName"
                placeholder="Nome da fila"
                defaultValue={values.queueName}
              />
            </FilterField>
            <FilterField label="Job">
              <input
                name="jobName"
                placeholder="Nome do job"
                defaultValue={values.jobName}
              />
            </FilterField>
          </>
        )}

        {section === "audit" ? (
          <>
            <FilterField label="Ator">
              <input
                name="actorType"
                placeholder="Tipo do ator"
                defaultValue={values.actorType}
              />
            </FilterField>
            <FilterField label="Alvo">
              <input
                name="targetType"
                placeholder="Tipo do alvo"
                defaultValue={values.targetType}
              />
            </FilterField>
          </>
        ) : null}
      </div>

      <details className="operations-advanced-filters">
        <summary>Filtros avancados</summary>
        <div className="operations-filter-grid">
          <DateFields since={values.since} until={values.until} />

          {section === "incidents" || section === "webhooks" ? (
            <AttributionFields values={values} />
          ) : null}

          {section === "conversions" ? (
            <>
              <FilterField label="Gatilho CAPI">
                <input
                  name="sourceTrigger"
                  placeholder="Gatilho"
                  defaultValue={values.sourceTrigger}
                />
              </FilterField>
              <FilterField label="Pixel">
                <input
                  name="pixelId"
                  placeholder="ID do Pixel"
                  defaultValue={values.pixelId}
                />
              </FilterField>
              <AttributionFields values={values} />
            </>
          ) : null}

          {section === "integrations" ? (
            <>
              <FilterField label="ID do job">
                <input
                  name="jobId"
                  placeholder="ID do job"
                  defaultValue={values.jobId}
                />
              </FilterField>
              <AttributionFields values={values} includePhone={false} />
            </>
          ) : null}

          {section !== "audit" && section !== "jobs" ? (
            <FilterField label="Codigo do erro">
              <input
                name="errorCode"
                placeholder="Codigo do erro"
                defaultValue={values.errorCode}
              />
            </FilterField>
          ) : null}
        </div>
      </details>

      <div className="operations-filter-actions">
        <button className="button" type="submit">
          Aplicar filtros
        </button>
        <a
          className="button ghost"
          href={`/backoffice?view=operations&area=health&section=${section}`}
        >
          Limpar
        </a>
      </div>
    </form>
  );
}
