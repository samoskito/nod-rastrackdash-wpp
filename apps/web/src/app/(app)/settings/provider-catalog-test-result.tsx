import type {
  StructuredCatalogMatchReasonCodeDto,
  StructuredCatalogTestMessageResultDto,
} from "@wpptrack/shared";
import { formatMoney } from "@wpptrack/shared";

type ProviderCatalogTestResultProps = {
  result: StructuredCatalogTestMessageResultDto;
};

const classificationLabels: Record<
  StructuredCatalogTestMessageResultDto["classification"],
  string
> = {
  recognized: "Variante reconhecida",
  awaiting_data: "Aguardando dados",
  review_required: "Revisão necessária",
  ignored: "Mensagem ignorada",
};

const reasonLabels: Record<StructuredCatalogMatchReasonCodeDto, string> = {
  matched: "Combinação e preço conferidos.",
  rule_inactive: "A regra está pausada.",
  catalog_inactive: "O catálogo está inativo.",
  missing_attribute: "A mensagem não contém todos os atributos.",
  ambiguous_attribute: "Um atributo apareceu com mais de um valor.",
  unknown_combination: "A combinação não existe no catálogo.",
  ambiguous_variant: "Mais de uma variante corresponde a mensagem.",
  missing_price: "Nenhum preço foi encontrado na mensagem.",
  ambiguous_price: "Mais de um preço foi encontrado na mensagem.",
  price_mismatch: "O preço da mensagem difere do catálogo.",
  trigger_missing: "A frase gatilho não foi encontrada.",
  empty_template: "O template ainda não possui dados preenchidos.",
  awaiting_data: "A mensagem ainda não contém os dados da compra.",
  incomplete_item: "Um produto está sem todos os atributos.",
  invalid_quantity: "A quantidade informada não é válida.",
};

export function ProviderCatalogTestResult({
  result,
}: ProviderCatalogTestResultProps) {
  const currency = result.currency ?? "BRL";
  const calculatedValueCents =
    result.calculatedValueCents ?? result.parsedValueCents;

  return (
    <section
      className={`provider-catalog-test-result classification-${result.classification}`}
      aria-live="polite"
      role="status"
    >
      <header className="provider-catalog-test-result-heading">
        <div>
          <span className="micro-label">Decisão do simulador</span>
          <strong>{classificationLabels[result.classification]}</strong>
        </div>
        <span className="provider-catalog-test-result-reason">
          {reasonLabels[result.reasonCode]}
        </span>
      </header>

      {result.matchedTriggerPhrase ? (
        <div className="provider-catalog-test-trigger">
          <span>Frase gatilho</span>
          <strong>{result.matchedTriggerPhrase}</strong>
        </div>
      ) : null}

      {result.parsedAttributes.length > 0 ? (
        <dl className="provider-catalog-test-attributes">
          {result.parsedAttributes.map((attribute) => (
            <div key={attribute.key}>
              <dt>{attribute.label}</dt>
              <dd>{attribute.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {result.items.length > 0 ? (
        <div className="provider-catalog-test-items">
          <span className="micro-label">
            {result.items.length === 1 ? "Item extraído" : "Itens extraídos"}
          </span>
          {result.items.map((item) => (
            <div className="provider-catalog-test-item" key={item.position}>
              <div>
                <strong>{item.contentName ?? `Item ${item.position}`}</strong>
                <span>
                  {item.parsedAttributes
                    .map(
                      (attribute) =>
                        `${attribute.label}: ${attribute.value}`,
                    )
                    .join(" / ") || "Atributos incompletos"}
                </span>
              </div>
              <span className="provider-catalog-test-quantity">
                {item.quantity} un.
              </span>
              <span className="provider-catalog-test-item-value">
                {item.subtotalValueCents
                  ? formatMoney(item.subtotalValueCents, currency)
                  : "Valor pendente"}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {calculatedValueCents || result.observedPaymentValueCents ? (
        <dl className="provider-catalog-test-values">
          {calculatedValueCents ? (
            <div>
              <dt>Valor pelo catálogo</dt>
              <dd>{formatMoney(calculatedValueCents, currency)}</dd>
            </div>
          ) : null}
          {result.observedPaymentValueCents ? (
            <div>
              <dt>Valor informado na mensagem</dt>
              <dd>
                {formatMoney(result.observedPaymentValueCents, currency)}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </section>
  );
}
