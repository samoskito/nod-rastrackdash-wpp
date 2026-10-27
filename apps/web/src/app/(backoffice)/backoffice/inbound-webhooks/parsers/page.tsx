import type { BackofficeParserReleaseListDto } from "@wpptrack/shared";
import { backofficeParserReleaseListSchema } from "@wpptrack/shared";
import { ShieldAlert } from "lucide-react";
import { BackofficeNavigation } from "../../../../../components/backoffice-navigation";
import { formatDateTime } from "../../../../../lib/date-time";
import {
  isApiRequestError,
  serverApiFetch,
} from "../../../../../lib/server-api";
import { WebhooksViewSwitch } from "../webhooks-view-switch";
import { parserProviderLabels, parserStatusLabel } from "./parsers-copy";

/**
 * Backoffice "Leitores de webhook" (fase 6.5): porte só de leitura do SaaS
 * b4d71afc. Diagnóstico de suporte: mostra as versões de leitor desta
 * instalação e se cada uma está em uso. Os leitores validados chegam com as
 * atualizações (produção direta): não há nada para ativar aqui.
 */

type LoadResult =
  | { state: "real"; data: BackofficeParserReleaseListDto }
  | { state: "forbidden" | "error" };

async function load(): Promise<LoadResult> {
  try {
    const parsed = backofficeParserReleaseListSchema.safeParse(
      await serverApiFetch<unknown>("/backoffice/inbound-webhooks/parser-releases"),
    );
    return parsed.success
      ? { state: "real", data: parsed.data }
      : { state: "error" };
  } catch (error) {
    if (isApiRequestError(error) && error.status === 403) {
      return { state: "forbidden" };
    }
    return { state: "error" };
  }
}

export default async function ParserReleasesPage() {
  const result = await load();

  return (
    <section className="page-stack standalone-page integration-receipts-page">
      <BackofficeNavigation active="webhooks" />

      <header className="page-header">
        <div>
          <span className="eyebrow">Diagnóstico</span>
          <h1>Leitores de webhook</h1>
          <p>
            Versões de leitor que esta instalação tem para entender o que cada
            plataforma envia. Os leitores novos chegam com as atualizações e já
            entram em uso.
          </p>
        </div>
        <span className="status-chip neutral">Somente leitura</span>
      </header>

      <WebhooksViewSwitch active="parsers" />

      {result.state !== "real" ? (
        <div className="inbound-empty-state" role="alert">
          <ShieldAlert aria-hidden="true" size={20} strokeWidth={2} />
          <div>
            <strong>
              {result.state === "forbidden"
                ? "Área restrita aos administradores da plataforma"
                : "Não deu para carregar os leitores"}
            </strong>
            <p>
              {result.state === "forbidden"
                ? "Entre com uma conta de proprietário ou operador do Backoffice."
                : "Tente de novo em alguns instantes."}
            </p>
          </div>
        </div>
      ) : (
        <div className="table-shell integration-receipts-table">
          <table>
            <thead>
              <tr>
                <th>Plataforma</th>
                <th>Versão</th>
                <th>Estado</th>
                <th>Em uso desde</th>
              </tr>
            </thead>
            <tbody>
              {result.data.releases.map((release) => {
                const status = parserStatusLabel(release.status);
                return (
                  <tr key={release.id}>
                    <td data-label="Plataforma">
                      <span>
                        {parserProviderLabels[release.provider] ??
                          release.provider}
                      </span>
                    </td>
                    <td data-label="Versão">
                      <span className="single-url-code">{release.version}</span>
                    </td>
                    <td data-label="Estado">
                      <span className={`status-chip ${status.tone}`}>
                        {status.label}
                      </span>
                    </td>
                    <td data-label="Em uso desde">
                      <span>
                        {release.status === "certified" && release.certifiedAt
                          ? formatDateTime(release.certifiedAt)
                          : "—"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
