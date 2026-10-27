/**
 * Fase 6.8 (porte do #183 e #185): guia do webhook do ROI Chat, mostrado
 * junto da URL do número (exibida uma vez) e na tela de Integrações.
 *
 * Contrato lido pelo RastrackDash (formato real recebido no SaaS):
 *  - entrada do lead: { nome, telefone, anuncio: { source_id, ctwa_clid, ... } }
 *    (sem `event_name`);
 *  - compra: o mesmo corpo + `event_name: "Purchase"`, `valor_venda` e `moeda`.
 * Uma conexão = um número = uma URL; a mesma URL recebe os dois.
 */
export function RoichatSetupPanel() {
  return (
    <div className="provider-conversion-payload-helper roichat-setup">
      <div>
        <span className="micro-label">Configuração no ROI Chat</span>
        <strong>Webhook do número: entrada do lead e compra</strong>
      </div>
      <ol className="provider-conversion-payload-steps">
        <li>
          No ROI Chat, abra a configuração de webhook do número que você
          cadastrou aqui e cole a URL completa acima, com o token. Não precisa
          de cabeçalho extra.
        </li>
        <li>
          Use a mesma URL para os dois avisos do ROI Chat: a entrada da
          conversa que veio do anúncio e a compra.
        </li>
        <li>
          A rota Meta do número (conta de anúncio e pixel) é aprendida sozinha
          pelo anúncio da primeira entrada, com a conta de anúncio conectada
          em Meta Ads. Se o número mostrar que falta a rota, salve-a logo
          abaixo, em “Números desta conexão”: sem rota nada é enviado.
        </li>
        <li>
          Em Conversões, crie a regra “Compra no ROI Chat” para enviar a compra
          como <code>Purchase</code> para a Meta.
        </li>
      </ol>
      <p className="action-note">
        A entrada com o clique do anúncio (<code>ctwa_clid</code>) cria o lead.
        Sem o clique, a conversa fica registrada como “sem anúncio” e nada vai
        para a Meta.
      </p>
      <p className="action-note">
        A compra usa o <code>valor_venda</code> e a <code>moeda</code> que o ROI
        Chat manda. A mesma compra repetida (mesmo lead, número, valor e moeda)
        em menos de 12 horas conta uma vez só; uma nova compra com outro valor
        ou depois de 12 horas é enviada de novo.
      </p>
    </div>
  );
}
