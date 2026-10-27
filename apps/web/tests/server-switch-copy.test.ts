import { describe, expect, it } from "vitest";
import { CONVERSION_SENDING_OFF_FIX } from "../src/lib/server-switch-copy";
import { conversionSendingOffCopy } from "../src/app/(app)/conversions/lead-submitted-override";
import { describeAuditErrorCode } from "../src/app/(app)/settings/kommo-audit-labels";
import { observationDetailCopy } from "../src/app/(app)/settings/provider-conversion-labels";

/**
 * 1.3.1 (caso real: INBOUND_CONVERSION_PRODUCTION_ENABLED=false copiado do
 * .env.example antigo): o aviso de envio desligado mostra o nome da variável
 * e a ação exata, por exceção aprovada pelo Samuel.
 */
describe("envio desligado no servidor: orientação exata", () => {
  it("texto combinado com o Samuel", () => {
    expect(CONVERSION_SENDING_OFF_FIX).toBe(
      "No Dokploy, no serviço da API, troque INBOUND_CONVERSION_PRODUCTION_ENABLED=false por true (ou apague a linha), confira se INBOUND_CONVERSION_RULES_ENABLED=true e faça o deploy da API.",
    );
  });

  it("aparece em Conversões, na Kommo e no reprocessar", () => {
    expect(conversionSendingOffCopy.body).toContain(CONVERSION_SENDING_OFF_FIX);
    expect(describeAuditErrorCode("conversion_production_disabled")).toContain(
      CONVERSION_SENDING_OFF_FIX,
    );
    expect(observationDetailCopy.production_sending_disabled.reprocess).toContain(
      CONVERSION_SENDING_OFF_FIX,
    );
  });
});
