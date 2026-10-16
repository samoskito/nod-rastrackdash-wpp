import {
  adaptProviderConversionRuleAction,
  confirmConversionRuleCreateAction,
  createConversionRuleAction,
  loadProviderConversionAutomationAuditAction,
  loadProviderConversionAutomationPayloadAction,
  loadProviderConversionExecutionAuditAction,
  removeProviderConversionRuleAction,
  reprocessProviderConversionAutomationCallbacksAction,
  rotateProviderConversionRuleEndpointAction,
  testProviderCatalogMessageAction,
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
import { getWorkspaceCurrencySettings } from "../../../lib/currency-settings";

type ConversionsPageProps = {
  searchParams?: Promise<{ nova?: string }>;
};

export default async function ConversionsPage({
  searchParams,
}: ConversionsPageProps) {
  const params = searchParams ? await searchParams : {};
  const [data, currencySettings] = await Promise.all([
    loadConversionsData(),
    getWorkspaceCurrencySettings(),
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
        providerRules={data.providerRules}
        legacyRules={data.legacyRules}
        legacyRulesState={data.legacyRulesState}
        updateRuleAction={updateProviderConversionRuleAction}
        loadExecutionsAction={loadProviderConversionExecutionAuditAction}
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
      />
      </WorkspaceCurrencyProvider>
    </section>
  );
}
