import {
  activateRuleNumberAction,
  adaptProviderConversionRuleAction,
  confirmConversionRuleCreateAction,
  createConversionRuleAction,
  loadProviderConversionAutomationAuditAction,
  loadProviderConversionAutomationPayloadAction,
  loadProviderConversionExecutionAuditAction,
  removeProviderConversionRuleAction,
  reprocessBlockedExecutionsAction,
  reprocessProviderConversionAutomationCallbacksAction,
  rotateProviderConversionRuleEndpointAction,
  testProviderCatalogMessageAction,
  removeConversionRulesAction,
  unifyConversionRulesAction,
  updateLegacyRuleAction,
  updateProviderConversionRuleAction,
} from "./actions";
import { isRuleOriginId } from "./conversion-origins";
import {
  buildCrmRuleRows,
  buildProviderRuleRows,
  offeredRuleOrigins,
  sortRuleRows,
} from "./conversion-rules-view";
import { loadConversionsData } from "./conversions-data";
import { ConversionsScreen } from "./conversions-screen";
import { WorkspaceCurrencyProvider } from "../../../components/workspace-currency";
import {
  ensureIntegrationEndpointAction,
  loadIntegrationEventPayloadAction,
  removeIntegrationEndpointAction,
  retryIntegrationEventAction,
  revealIntegrationEndpointAction,
  rotateIntegrationEndpointAction,
  setRulePublicUrlAction,
} from "../integrations/single-url/single-url-actions";
import { loadSingleUrlData } from "../integrations/single-url/single-url-data";
import { getWorkspaceCurrencySettings } from "../../../lib/currency-settings";

type ConversionsPageProps = {
  searchParams?: Promise<{ nova?: string }>;
};

export default async function ConversionsPage({
  searchParams,
}: ConversionsPageProps) {
  const params = searchParams ? await searchParams : {};
  const [data, currencySettings, singleUrlData] = await Promise.all([
    loadConversionsData(),
    getWorkspaceCurrencySettings(),
    loadSingleUrlData(),
  ]);
  const rows = sortRuleRows([
    ...buildProviderRuleRows(
      data.providerRules,
      data.numbers,
      data.connections,
      data.capabilities,
    ),
    ...(data.crmVisible ? buildCrmRuleRows(
          { kommo: data.kommo, pipedrive: data.pipedrive },
          data.numbers,
        ) : []),
  ]);
  const offeredOrigins = offeredRuleOrigins({
    numbers: data.numbers,
    connections: data.connections,
    capabilities: data.capabilities,
    // Porte do SaaS #164: um /channels que falhou nunca esconde as
    // plataformas de venda (Payt, Braip, Yampi).
    numbersPartial: data.numbersPartial,
    crm: {
      kommo: data.crmVisible && data.kommo.length > 0,
      pipedrive: data.crmVisible && data.pipedrive.length > 0,
    },
  });
  const initialOrigin = isRuleOriginId(params.nova) ? params.nova : null;

  return (
    <section className="page-stack page-standard conversions-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Conversões</span>
          <h1>Conversões</h1>
          <p>
            Todas as regras que transformam uma conversa em conversão na Meta,
            em um só lugar: frases, etiquetas, pedidos do catálogo, automações e
            etapas do CRM, para todos os números ou só para os que você
            escolher.
          </p>
        </div>
      </header>

      <WorkspaceCurrencyProvider currency={currencySettings?.conversionCurrency}>
      <ConversionsScreen
        rows={rows}
        numbers={data.numbers}
        connections={data.connections}
        offeredOrigins={offeredOrigins}
        capabilities={data.capabilities}
        comingSoonNumbers={data.comingSoonNumbers}
        licenseLocked={data.licenseLocked}
        unifyGroups={data.unifyGroups}
        canManage={data.canManage}
        rulesState={data.rulesState}
        numbersPartial={data.numbersPartial}
        crmVisible={data.crmVisible}
        crmError={data.crmError}
        initialOrigin={initialOrigin}
        createAction={createConversionRuleAction}
        confirmCreateAction={confirmConversionRuleCreateAction}
        unifyAction={unifyConversionRulesAction}
        bulkRemoveAction={removeConversionRulesAction}
        providerRules={data.providerRules}
        legacyRules={data.legacyRules}
        legacyRulesState={data.legacyRulesState}
        updateRuleAction={updateProviderConversionRuleAction}
        loadExecutionsAction={loadProviderConversionExecutionAuditAction}
        activateNumberAction={activateRuleNumberAction}
        reprocessBlockedAction={reprocessBlockedExecutionsAction}
        ruleActions={{
          remove: removeProviderConversionRuleAction,
          rotateEndpoint: rotateProviderConversionRuleEndpointAction,
          loadReceivedEvents: loadProviderConversionAutomationAuditAction,
          loadReceivedPayload: loadProviderConversionAutomationPayloadAction,
          reprocessReceivedEvents:
            reprocessProviderConversionAutomationCallbacksAction,
          testCatalogMessage: testProviderCatalogMessageAction,
        }}
        legacyActions={{
          update: updateLegacyRuleAction,
          adapt: adaptProviderConversionRuleAction,
        }}
        singleUrl={
          singleUrlData.endpoints?.enabled
            ? {
                endpoints: singleUrlData.endpoints.endpoints,
                paytProducts: singleUrlData.paytProducts,
                paytUnattributed: singleUrlData.unattributed.payt,
                braipProducts: singleUrlData.braipProducts,
                braipUnattributed: singleUrlData.unattributed.braip,
                yampiProducts: singleUrlData.yampiProducts,
                yampiUnattributed: singleUrlData.unattributed.yampi,
                actions: {
                  ensure: ensureIntegrationEndpointAction,
                  reveal: revealIntegrationEndpointAction,
                  rotate: rotateIntegrationEndpointAction,
                  remove: removeIntegrationEndpointAction,
                  retry: retryIntegrationEventAction,
                  setPublicUrl: setRulePublicUrlAction,
                  loadPayload: loadIntegrationEventPayloadAction,
                },
              }
            : undefined
        }
      />
      </WorkspaceCurrencyProvider>
    </section>
  );
}
