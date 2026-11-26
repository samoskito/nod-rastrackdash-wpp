# XMAX CRM: conversão pela etapa da oportunidade

Quando uma oportunidade muda de etapa no CRM da XMAX, a automação dessa etapa chama a URL de uma regra do RastrackDash. Se o contato veio de um anúncio, essa chamada vira uma conversão.

**Estado: em observação.** O leitor da XMAX (`xmax` `automation-v1`) nasce **em observação**. As chamadas aparecem na tela, marcadas, e **nada vai para a Meta** até uma migration futura certificar o leitor. Isso só acontece depois do teste com uma chamada real.

PENDENTE: testar com uma conta XMAX real (uma chamada real de mudança de etapa) e certificar o leitor numa migration nova.

## O que a XMAX faz e o que não faz

- **A XMAX não cria lead.** O lead entra pela sua conexão de WhatsApp (API Oficial, Uazapi ou WAHA do aluno por URL + token, Umbler, Unnichat...), quando a pessoa clica no anúncio. A XMAX só marca a conversão desse lead.
- **Só conta lead pago.** Se o telefone não for de um contato que veio do anúncio, a chamada é descartada com o motivo `contact_not_paid_lead` ("Contato não é lead de anúncio").
- A conversão vai para o número de WhatsApp por onde o lead chegou, qualquer que seja a conexão.

## 1. Criar a regra (uma por evento)

1. Abra **Conversões → Nova regra → Etapa no CRM da XMAX**.
2. Escolha o evento: Lead qualificado, Compra ou qualquer outro evento do pixel de mensagem. Cada evento tem **uma regra e uma URL**.
3. Em **Detalhes**, a regra vale sempre para todos os números. Para eventos com valor (como a Compra), informe o **valor fixo**. Ele é obrigatório na Compra.
4. Clique em **Criar regra** e copie a **URL da regra**, que aparece uma única vez. Se perder a URL, gere outra em **Gerenciar → URL**.

## 2. Chamar a URL na XMAX

Na automação da etapa que marca a conversão, configure uma chamada `POST` para a URL da regra:

```
POST {API_PUBLIC_URL}/webhooks/inbound/conversions/{endpointId}?token=...
```

- O token já vem na URL. Se preferir, tire o `?token=...` da URL e mande o token no cabeçalho `x-wpptrack-webhook-token`.
- **O evento vem da URL**: cada regra é de um evento. Uma etapa que deve gerar Compra chama a URL da regra de Compra.

Corpo de exemplo (dados fictícios):

```json
{
  "ID_oportunidade": "90001",
  "Etapa_oportunidade": "3 Negociação",
  "Telefone_oportunidade": "5511900000002"
}
```

## 3. Campos lidos e ignorados

| Campo | Uso |
| --- | --- |
| `ID_oportunidade` | **Obrigatório.** Identifica a oportunidade (sem ele: "Chamada da XMAX sem ID_oportunidade"). |
| `Telefone_oportunidade` | Telefone do lead. |
| `Contatos_oportunidade` | Só se não vier `Telefone_oportunidade`: o `contact_number` do primeiro contato (pode vir como texto JSON). O `contact_id` é opcional. |
| `Etapa_oportunidade` | Só para conferência na tela. Não decide o evento. |
| `Queue_id`, `Queue_id_v2` | Ignorados. |
| E-mail, endereço, documento | **Nunca são lidos.** |

Sem telefone, a chamada é descartada como "Oportunidade sem telefone do lead". Com um corpo que não dá para ler, o motivo é "Formato da chamada da XMAX não reconhecido".

## 4. Valor e repetição

- **Valor:** sempre o **valor fixo da regra**. A XMAX ainda não manda um campo de valor que o RastrackDash use.
- **Repetição:** cada oportunidade conta **uma vez por evento**. Se a mesma oportunidade voltar para a etapa, a chamada repetida não vira outra conversão. Duas oportunidades diferentes do mesmo lead contam duas vezes nos eventos que podem se repetir, como a Compra. Lead e Lead qualificado continuam **uma vez por lead**, pela regra geral do catálogo.

## 5. Conferir no front (modo observação)

Uma chamada recebida sempre aparece na tela do cliente:

**Conversões → (regra "XMAX: ...") → Gerenciar → Eventos recebidos**

- No topo aparece a marca **"Em observação"**: nada vai para a Meta.
- Cada chamada aparece com a hora, o evento, o número do lead e o motivo. A chamada de um lead pago aparece como "Reconhecido sem envio"; a de um orgânico aparece com "Contato não é lead de anúncio".
- Em **Gerenciar → URL** ficam o passo a passo e o corpo de exemplo.

Mesmo que alguém tente ativar o envio, a API recusa enquanto o leitor estiver em observação.
