"use client";

import type {
  GhlPipelineOptionsDto,
  GhlStageFilterDto,
} from "@wpptrack/shared";
import { RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GhlPipelinesActionResult } from "./actions";

export type LoadGhlPipelines = (
  connectionId: string,
) => Promise<GhlPipelinesActionResult>;

export const ghlNoTokenMessage =
  "Sem o token da conexão, a regra vale para todas as etapas. Para escolher uma etapa, gere o token no GoHighLevel (Configurações → Private Integrations, com leitura de oportunidades) e salve em Integrações → GoHighLevel.";

/** Integrações → Go High Level (a seção "Token do GoHighLevel" da conexão). */
export const ghlTokenHref = "/integrations#integracao-gohighlevel";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; options: GhlPipelineOptionsDto }
  | { status: "error"; message: string };

/**
 * "Pipeline + etapa" (optional) of a GoHighLevel rule: two selects, Pipeline
 * on top and, right below, Stage (only the chosen pipeline's stages; disabled
 * until a pipeline is chosen). A chosen stage shows as one chip with "Trocar"
 * and "×"; the selects open only on "Trocar", and a saved rule starts
 * collapsed. Nothing chosen = every stage. The call carries pipeline_id and
 * the stage NAME, so a stage renamed in GHL is refreshed here (by its id) and
 * saved with the rule.
 */
export function GhlStagePicker({
  connectionId,
  value,
  onChange,
  load,
  disabled,
}: {
  connectionId: string | null;
  value: GhlStageFilterDto | null;
  onChange: (stage: GhlStageFilterDto | null) => void;
  load: LoadGhlPipelines;
  disabled: boolean;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [open, setOpen] = useState(false);
  const [pipelineId, setPipelineId] = useState(value?.pipelineId ?? "");
  const [stageId, setStageId] = useState(value?.stageId ?? "");
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++request.current;
    if (!connectionId) {
      setState({ status: "ready", options: { tokenConfigured: false, pipelines: [] } });
      return;
    }
    setState({ status: "loading" });
    try {
      const result = await load(connectionId);
      if (id !== request.current) return;
      setState(
        result.ok
          ? { status: "ready", options: result.data }
          : { status: "error", message: result.message },
      );
    } catch {
      if (id !== request.current) return;
      setState({
        status: "error",
        message: "Não deu para carregar os pipelines agora. Tente de novo em instantes.",
      });
    }
  }, [connectionId, load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pipelines = state.status === "ready" ? state.options.pipelines : [];
  const selectedPipeline = pipelines.find((item) => item.id === pipelineId) ?? null;

  // The saved stage renamed in GHL: take the current name (same id).
  const current = useMemo(() => {
    if (!value) return null;
    const pipeline = pipelines.find((item) => item.id === value.pipelineId);
    const stage = pipeline?.stages.find((item) => item.id === value.stageId);
    return pipeline && stage ? { pipeline, stage } : null;
  }, [pipelines, value]);
  const renamed =
    value !== null &&
    current !== null &&
    (current.stage.name !== value.stageName ||
      current.pipeline.name !== value.pipelineName);
  const missing =
    value !== null && state.status === "ready" && pipelines.length > 0 && !current;

  useEffect(() => {
    if (value && current && renamed) {
      onChange({
        ...value,
        pipelineName: current.pipeline.name,
        stageName: current.stage.name,
      });
    }
    // Only when the list or the saved choice changes.
  }, [current, renamed, value, onChange]);

  function chooseStage(nextStageId: string) {
    setStageId(nextStageId);
    const stage = selectedPipeline?.stages.find((item) => item.id === nextStageId);
    if (!selectedPipeline || !stage) return;
    onChange({
      pipelineId: selectedPipeline.id,
      pipelineName: selectedPipeline.name,
      stageId: stage.id,
      stageName: stage.name,
    });
    setOpen(false);
  }

  const expanded = value === null || open;
  const reloadButton = (
    <button
      className="icon-button"
      type="button"
      aria-label="Recarregar pipelines"
      title="Recarregar pipelines"
      onClick={() => void refresh()}
      disabled={disabled || state.status === "loading"}
    >
      <RefreshCw size={14} aria-hidden="true" />
    </button>
  );

  return (
    <fieldset className="conversion-flow-fieldset ghl-stage-picker">
      <legend className="field-label">Pipeline + etapa (opcional)</legend>
      <p className="action-note">
        A regra só converte quando a oportunidade chega na etapa escolhida.
        Sem escolha, vale para todas as etapas.
      </p>

      {value ? (
        <div
          role="group"
          aria-label="Etapa escolhida"
          style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
        >
          <span
            className="status-chip neutral"
            title={`${value.pipelineName} · ${value.stageName}`}
            style={{
              display: "block",
              flex: "1 1 0",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {value.pipelineName} · {value.stageName}
          </span>
          {!open ? (
            <button
              className="button ghost"
              type="button"
              style={{ width: "auto", flex: "none", whiteSpace: "nowrap" }}
              onClick={() => {
                setPipelineId(value.pipelineId);
                setStageId(value.stageId);
                setOpen(true);
              }}
              disabled={disabled}
            >
              Trocar
            </button>
          ) : null}
          <button
            className="icon-button"
            type="button"
            style={{ flex: "none" }}
            aria-label="Remover o filtro de etapa"
            onClick={() => {
              onChange(null);
              setPipelineId("");
              setStageId("");
              setOpen(false);
            }}
            disabled={disabled}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {renamed ? (
        <p className="action-note" role="status">
          A etapa foi renomeada no GoHighLevel. Salve a regra para atualizar o nome.
        </p>
      ) : null}
      {missing ? (
        <p className="action-note warn" role="alert">
          Esta etapa não aparece mais no GoHighLevel. Escolha outra ou remova o filtro.
        </p>
      ) : null}

      {state.status === "loading" && expanded ? (
        <p className="action-note" role="status">
          Carregando os pipelines…
        </p>
      ) : null}

      {state.status === "error" && expanded ? (
        <div className="action-note warn" role="alert">
          {state.message} {reloadButton}
        </div>
      ) : null}

      {state.status === "ready" && expanded && !state.options.tokenConfigured ? (
        <p className="action-note">
          {ghlNoTokenMessage}{" "}
          <a href={ghlTokenHref}>Adicionar token</a>
        </p>
      ) : null}

      {state.status === "ready" &&
      expanded &&
      state.options.tokenConfigured &&
      pipelines.length === 0 ? (
        <p className="action-note">
          Nenhum pipeline encontrado nesta localização. {reloadButton}
        </p>
      ) : null}

      {state.status === "ready" && expanded && pipelines.length > 0 ? (
        <>
          <div className="conversion-field">
            <span className="field-label">Pipeline {reloadButton}</span>
            <select
              value={pipelineId}
              onChange={(event) => {
                setPipelineId(event.target.value);
                setStageId("");
              }}
              disabled={disabled}
              aria-label="Pipeline"
            >
              <option value="">Escolha o pipeline</option>
              {pipelines.map((pipeline) => (
                <option key={pipeline.id} value={pipeline.id}>
                  {pipeline.name}
                </option>
              ))}
            </select>
          </div>
          <label className="conversion-field">
            <span className="field-label">Etapa</span>
            <select
              value={stageId}
              onChange={(event) => chooseStage(event.target.value)}
              disabled={disabled || !selectedPipeline}
              aria-label="Etapa"
            >
              <option value="">
                {selectedPipeline ? "Escolha a etapa" : "Escolha o pipeline primeiro"}
              </option>
              {(selectedPipeline?.stages ?? []).map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null}
    </fieldset>
  );
}
