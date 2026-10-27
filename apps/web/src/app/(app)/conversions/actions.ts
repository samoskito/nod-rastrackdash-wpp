"use server";

import {
  providerConversionAutomationAuditSchema,
  providerConversionAutomationPayloadSchema,
  providerConversionAutomationReprocessBatchInputSchema,
  providerConversionAutomationReprocessBatchResultSchema,
  providerConversionEndpointSecretResultSchema,
  providerConversionRuleAdaptInputSchema,
  providerConversionRuleBlockedReprocessResultSchema,
  providerConversionRuleExecutionAuditSchema,
  providerConversionRuleBulkRemoveInputSchema,
  providerConversionRuleBulkRemoveResultSchema,
  providerConversionRuleIdempotentCreateInputSchema,
  providerConversionRuleIdempotentCreateResultSchema,
  providerConversionRuleNumberActivationResultSchema,
  providerConversionRuleSchema,
  providerConversionRuleUnifyInputSchema,
  providerConversionRuleUnifyResultSchema,
  providerConversionRuleUpdateInputSchema,
  providerRuleCreateReceiptLookupResultSchema,
  providerRuleCreateRequestKeySchema,
  structuredCatalogTestMessageInputSchema,
  structuredCatalogTestMessageResultSchema,
  type ProviderConversionAutomationAuditDto,
  type ProviderConversionAutomationPayloadDto,
  type ProviderConversionAutomationReprocessBatchResultDto,
  type ProviderConversionRuleBlockedReprocessResultDto,
  type ProviderConversionRuleExecutionAuditDto,
  type ProviderConversionRuleBulkRemoveResultDto,
  type ProviderConversionRulePendingNumberDto,
  type ProviderConversionRulePendingNumberReasonDto,
  type StructuredCatalogTestMessageResultDto,
} from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import { licenseLockedMessageFor } from "../../../lib/license-locked-message";
import { isApiRequestError, serverApiFetch } from "../../../lib/server-api";

/**
 * Server actions da tela Conversões. Toda escrita trata o 423 da licença
 * (nada foi alterado, mostra o aviso de licença bloqueada); a criação sempre
 * leva Idempotency-Key: repetir o MESMO pedido depois de uma resposta incerta
 * nunca cria uma segunda regra.
 */

export type ConversionScreenActionResult = {
  ok: boolean;
  message: string;
  /** A API recusou com 423: a licença está bloqueada e nada foi alterado. */
  licenseLocked?: boolean;
  /** O pedido pode ter sido aplicado; confira antes de repetir. */
  outcomeUnknown?: boolean;
  /** 503: recusado antes de processar; tente de novo (a criação reenvia a mesma chave). */
  unavailable?: boolean;
  authFailure?: boolean;
  ruleId?: string;
  /** Endereço assinado de uma regra de automação nova, exibido uma vez. */
  webhookUrl?: string;
  /** O mesmo pedido já tinha sido respondido: o endereço não aparece de novo. */
  replayed?: boolean;
  /** Conferência de uma criação incerta: a API não tem registro do pedido. */
  receiptAbsent?: boolean;
  /**
   * "Todos os números": números cobertos pela regra que ainda não enviam
   * (conexão fora de produção / canal inativo), com o motivo.
   */
  pendingNumbers?: ProviderConversionRulePendingNumberDto[];
  ruleMode?: "observation" | "production";
  /** "Ativar envio neste número": o que aconteceu com o número. */
  numberActivation?: {
    outcome: "promoted" | "already_live" | "pending";
    reason: ProviderConversionRulePendingNumberReasonDto | null;
  };
  /** "Reprocessar bloqueadas": contagens da rodada. */
  reprocess?: ProviderConversionRuleBlockedReprocessResultDto;
  /** "Excluir selecionadas": what happened to each rule. */
  bulkRemove?: ProviderConversionRuleBulkRemoveResultDto;
  unify?: {
    outcome: "created" | "reused_existing" | "replayed";
    ruleId: string;
    ruleName: string;
    deactivatedRuleIds: string[];
    newlyCoveredChannelIds: string[];
    duplicatePhoneChannelIds: string[];
  };
};

export type ProviderConversionRuleOneTimeSecret = {
  ruleId: string;
  webhookUrl: string;
};

export type ProviderConversionRuleActionResult = {
  ok: boolean;
  message: string;
  licenseLocked?: boolean;
  authFailure?: boolean;
  outcomeUnknown?: boolean;
  oneTimeSecret?: ProviderConversionRuleOneTimeSecret;
  testResult?: StructuredCatalogTestMessageResultDto;
  automationAudit?: ProviderConversionAutomationAuditDto;
  automationPayload?: ProviderConversionAutomationPayloadDto;
  automationReprocess?: ProviderConversionAutomationReprocessBatchResultDto;
  executionAudit?: ProviderConversionRuleExecutionAuditDto;
};

const conversionsPath = "/conversions";
const invalidMessage = "Revise os dados da regra e tente de novo.";
const createUnknownMessage =
  "Não deu para confirmar se a regra foi criada. Use “Conferir e concluir”: repetir este mesmo pedido nunca cria uma regra duplicada.";
const unifyUnknownMessage =
  "Não deu para confirmar a unificação. Confira a lista antes de tentar de novo; repetir o mesmo pedido não duplica nada.";
const changeUnknownMessage =
  "Não deu para confirmar a mudança. Atualize a página para conferir.";
const unavailableMessage =
  "Serviço indisponível no momento. Tente de novo em alguns instantes.";
const sessionExpiredMessage = "Sua sessão expirou. Entre de novo para continuar.";
const noPermissionMessage =
  "Você não tem mais permissão para gerenciar conversões.";

/**
 * Mensagens da API (sem acento) que são seguras e úteis de mostrar, na versão
 * acentuada. Qualquer outra mensagem vira o texto padrão da ação.
 */
const curatedMessages: Readonly<Record<string, string>> = {
  "Conexao nao encontrada": "Conexão não encontrada.",
  "Conexao invalida": "Conexão inválida.",
  "Regra de conversao do provedor nao encontrada":
    "Regra de conversão não encontrada. Atualize a página.",
  "Regra de conversao nao encontrada":
    "Regra de conversão não encontrada. Atualize a página.",
  "Parser da conexao ainda nao esta disponivel":
    "A conexão ainda não está pronta para receber regras.",
  "Informe ao menos uma etiqueta para automacao por tag UAZAPI":
    "Informe ao menos uma etiqueta.",
  "Informe a conexao que recebe o webhook desta automacao":
    "Escolha a conexão que chama o endereço desta regra.",
  "Um ou mais canais nao pertencem a esta conexao e workspace":
    "Um dos números escolhidos não pertence a esta conexão.",
  "Um ou mais canais nao pertencem a este workspace":
    "Um dos números escolhidos não pertence a esta conta.",
  "Um ou mais canais não pertencem a esta conexão e workspace":
    "Um dos números escolhidos não pertence a esta conexão.",
  "Um ou mais canais não pertencem a este workspace":
    "Um dos números escolhidos não pertence a esta conta.",
  "Etiquetas so estao disponiveis em numeros com etiquetas do WhatsApp":
    "Etiquetas só funcionam em números Uazapi, que têm etiquetas do WhatsApp.",
  "Um ou mais numeros nao suportam esta origem de regra":
    "Um dos números escolhidos ainda não funciona com esta origem de regra.",
  "Cada combinacao de atributos do catalogo deve ser unica":
    "Cada opção do catálogo deve ser única.",
  "Regras de conversao de provedores estao desativadas":
    "As regras de conversão estão desligadas nesta instalação.",
  "Eventos de conversao por provedor ainda nao estao habilitados":
    "As regras de conversão estão desligadas nesta instalação.",
  "Selecione ao menos duas regras": "Escolha ao menos duas regras iguais.",
  "Selecione ao menos um numero": "Escolha ao menos um número.",
  "Algumas destas regras ja foram unificadas; atualize a lista":
    "Algumas destas regras já foram unificadas. Atualize a lista.",
  "Estas regras foram unificadas em regras diferentes":
    "Estas regras foram unificadas em regras diferentes. Atualize a lista.",
  "Somente regras ativas, especificas e identicas podem ser unificadas":
    "Só regras ativas, de números específicos e idênticas podem ser unificadas.",
  "Esta regra ja esta vinculada a um provedor":
    "Esta regra já está conectada aos números.",
  "Somente regras antigas de compra por palavra-chave podem ser adaptadas":
    "Só regras antigas de compra por palavra podem ser conectadas aos números.",
  "Configure produto e valor antes de adaptar esta regra":
    "Informe produto e valor da regra antiga antes de conectá-la aos números.",
  // Mensagem da API anterior à Fase 5.1 (moeda obrigatória).
  "Configure produto, valor e moeda antes de adaptar esta regra":
    "Informe produto e valor da regra antiga antes de conectá-la aos números.",
  "Esta regra e gerenciada em Conversoes; edite-a pela regra do provedor":
    "Esta regra já está conectada aos números e é editada pela lista de regras.",
  "Regras com valor fixo precisam manter um valor positivo":
    "Regras com valor fixo precisam de um valor maior que zero.",
  "Informe o valor medio antes de voltar para o modo de valor fixo":
    "Informe o valor médio antes de voltar para valor fixo.",
  "Nenhum numero valido na regra; reconecte o WhatsApp ou selecione outro numero":
    "Nenhum número válido na regra. Reconecte o WhatsApp ou escolha outro número.",
  "Certifique o parser antes de ativar esta regra em producao":
    "Esta conexão ainda não pode enviar eventos para a Meta.",
  "Ative a regra antes de promover para producao":
    "Reative a regra antes de ativar o envio automático.",
  "Envio automatico de webhooks ainda nao esta habilitado":
    "O envio automático está desligado nesta instalação.",
  "Materializacao de conversoes por provedor ainda nao esta habilitada":
    "O envio automático está desligado nesta instalação.",
  "O catalogo desta regra nao esta ativo": "O catálogo desta regra não está ativo.",
  "Catalogo estruturado nao configurado":
    "Esta regra ainda não tem catálogo configurado.",
  "O teste de mensagem exige uma regra de catalogo estruturado":
    "O teste de pedido só existe para regras de catálogo.",
  "A Payt envia compra aprovada, Pix/boleto gerado ou carrinho abandonado":
    "A Payt envia compra aprovada, Pix/boleto gerado ou carrinho abandonado.",
  "A Braip envia compra aprovada, Pix/boleto gerado ou carrinho abandonado":
    "A Braip envia compra aprovada, boleto/Pix gerado ou checkout abandonado.",
  "A Yampi envia compra aprovada, Pix/boleto gerado ou carrinho abandonado":
    "A Yampi envia pedido pago, pedido aguardando pagamento (boleto/Pix) ou carrinho abandonado.",
  "Escolha a conexao de WhatsApp dos numeros desta regra":
    "Escolha números de uma conexão de WhatsApp para esta regra.",
  "Configure a Meta deste número (página e pixel do workspace ou rotas próprias) antes de ativar o canal":
    "Configure a Meta deste número (página e pixel do workspace ou rotas próprias) antes de ativar o canal.",
  "Conexões Unnichat exigem o número de WhatsApp do cliente":
    "As conexões do Unnichat precisam do número de WhatsApp do cliente.",
  "Sem permissao para gerenciar integracoes": noPermissionMessage,
  "Este workspace tem canais demais para unificar regras com segurança; mantenha as regras por número":
    "Este workspace tem canais demais para unificar regras com segurança. Mantenha as regras por número.",
};

function revalidateRules() {
  try {
    revalidatePath(conversionsPath);
    revalidatePath("/integrations");
  } catch {
    // O cliente atualiza a tela por conta própria.
  }
}

function apiCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return isApiRequestError(error) && typeof code === "string" ? code : null;
}

function apiStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return isApiRequestError(error) && typeof status === "number" ? status : null;
}

function curatedMessage(error: unknown): string | null {
  const message = (error as Error | null)?.message?.trim() ?? "";
  return curatedMessages[message] ?? null;
}

type Failure = {
  ok: false;
  message: string;
  licenseLocked?: boolean;
  authFailure?: boolean;
  outcomeUnknown?: boolean;
  unavailable?: boolean;
};

function failure(error: unknown, fallback: string, unknownMessage: string): Failure {
  // 423: a licença recusou a escrita antes de qualquer alteração.
  const locked = licenseLockedMessageFor(error);
  if (locked) return { ok: false, licenseLocked: true, message: locked };

  const status = apiStatus(error);

  if (status === 401 || status === 403) {
    return {
      ok: false,
      authFailure: true,
      message: status === 401 ? sessionExpiredMessage : noPermissionMessage,
    };
  }
  // 503 é a API recusando antes de processar: "tente de novo", não "incerto".
  if (status === 503) {
    return { ok: false, unavailable: true, message: unavailableMessage };
  }
  // Só um 4xx recusado (exceto 408) é "com certeza não aplicado".
  if (status === null || status >= 500 || status === 408) {
    return { ok: false, outcomeUnknown: true, message: unknownMessage };
  }

  return { ok: false, message: curatedMessage(error) ?? fallback };
}

function formText(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formId(formData: FormData, key: string): string | null {
  const value = formText(formData, key);

  if (!value || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return null;
  }

  return value;
}

function parseJson(value: string | null): unknown {
  if (!value || value.length > 500_000) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Criar e conferir
// ---------------------------------------------------------------------------

export async function createConversionRuleAction(
  formData: FormData,
): Promise<ConversionScreenActionResult> {
  const requestKey = providerRuleCreateRequestKeySchema.safeParse(
    formData.get("requestKey"),
  );
  const input = providerConversionRuleIdempotentCreateInputSchema.safeParse(
    parseJson(formText(formData, "payload")),
  );

  if (!requestKey.success || !input.success) {
    return { ok: false, message: invalidMessage };
  }

  try {
    const response = await serverApiFetch<unknown>(
      "/conversion-rules/providers",
      {
        method: "POST",
        headers: { "Idempotency-Key": requestKey.data },
        body: JSON.stringify(input.data),
      },
    );
    const result =
      providerConversionRuleIdempotentCreateResultSchema.safeParse(response);
    // Regra sem conexão (todos os números ou vários provedores) tem recibo sem
    // conexão; qualquer outra precisa bater com o que foi enviado.
    const expectedConnectionId = input.data.connectionId ?? null;

    if (
      !result.success ||
      result.data.receipt.connectionId !== expectedConnectionId ||
      (result.data.outcome === "created" &&
        result.data.rule.id !== result.data.receipt.ruleId)
    ) {
      return { ok: false, outcomeUnknown: true, message: createUnknownMessage };
    }

    revalidateRules();

    if (result.data.outcome === "replayed") {
      return {
        ok: true,
        replayed: true,
        ruleId: result.data.receipt.ruleId,
        message:
          "Esta regra já tinha sido criada. Se ela usa endereço de automação, gere um novo em “Gerenciar” > “Endereço e configuração” (o anterior não é exibido de novo).",
      };
    }

    return {
      ok: true,
      ruleId: result.data.rule.id,
      ruleMode: result.data.rule.mode,
      pendingNumbers: result.data.rule.pendingNumbers ?? [],
      ...(result.data.webhookUrl ? { webhookUrl: result.data.webhookUrl } : {}),
      message: createdRuleMessage(
        result.data.rule.mode,
        Boolean(result.data.webhookUrl),
      ),
    };
  } catch (error) {
    const message = (error as Error | null)?.message?.trim() ?? "";
    if (apiStatus(error) === 409) {
      if (message === "Chave de tentativa ja usada com outra solicitacao") {
        return {
          ok: false,
          message:
            "Este pedido já foi usado com outros dados. Confira a lista de regras; nenhuma regra nova foi criada.",
        };
      }
      if (message === "Recurso da tentativa removido; a chave permanece reservada") {
        return {
          ok: false,
          message:
            "A regra deste pedido foi criada e depois removida. Nada foi recriado.",
        };
      }
    }
    return failure(error, "Não foi possível criar a regra.", createUnknownMessage);
  }
}

/**
 * "Conferir e concluir" depois de uma criação incerta: pergunta à API se ela
 * guardou o pedido (GET providers/create-receipt). Só leitura; nunca chamada
 * depois de um 423 (recusa definitiva da licença, nada foi criado).
 */
export async function confirmConversionRuleCreateAction(
  formData: FormData,
): Promise<ConversionScreenActionResult> {
  const requestKey = providerRuleCreateRequestKeySchema.safeParse(
    formData.get("requestKey"),
  );
  const connectionId = formId(formData, "connectionId");

  if (!requestKey.success) {
    return { ok: false, message: invalidMessage };
  }

  try {
    const query = connectionId
      ? `?connectionId=${encodeURIComponent(connectionId)}`
      : "";
    const response = await serverApiFetch<unknown>(
      `/conversion-rules/providers/create-receipt${query}`,
      { headers: { "Idempotency-Key": requestKey.data } },
    );
    const result =
      providerRuleCreateReceiptLookupResultSchema.safeParse(response);

    if (!result.success) {
      return { ok: false, outcomeUnknown: true, message: createUnknownMessage };
    }
    if (result.data.outcome === "absent") {
      return {
        ok: false,
        receiptAbsent: true,
        message:
          "A regra não foi criada. Você pode tentar de novo com segurança: o pedido não vai duplicar nada.",
      };
    }

    revalidateRules();
    return {
      ok: true,
      replayed: true,
      ruleId: result.data.receipt.ruleId,
      message:
        "A regra foi criada. Se ela usa endereço de automação, gere um novo em “Gerenciar” > “Endereço e configuração” (o primeiro não é exibido de novo).",
    };
  } catch (error) {
    const failed = failure(
      error,
      "Não foi possível conferir a regra agora.",
      createUnknownMessage,
    );
    return failed.outcomeUnknown || failed.unavailable
      ? { ...failed, outcomeUnknown: true, message: createUnknownMessage }
      : failed;
  }
}

// ---------------------------------------------------------------------------
// Unificar
// ---------------------------------------------------------------------------

export async function unifyConversionRulesAction(
  formData: FormData,
): Promise<ConversionScreenActionResult> {
  const input = providerConversionRuleUnifyInputSchema.safeParse({
    ruleIds: formData.getAll("ruleId").filter((id) => typeof id === "string"),
    ...(formText(formData, "name") ? { name: formText(formData, "name") } : {}),
    ...(formText(formData, "acknowledgeDifferences") === "true"
      ? { acknowledgeDifferences: true }
      : {}),
  });

  if (!input.success) {
    return { ok: false, message: "Escolha as regras iguais que quer unificar." };
  }

  try {
    const response = await serverApiFetch<unknown>(
      "/conversion-rules/providers/unify",
      { method: "POST", body: JSON.stringify(input.data) },
    );
    const result = providerConversionRuleUnifyResultSchema.safeParse(response);

    if (!result.success) {
      return { ok: false, outcomeUnknown: true, message: unifyUnknownMessage };
    }

    revalidateRules();
    const { outcome, rule } = result.data;
    const automation =
      rule.origin === "automation_unnichat" ||
      rule.origin === "automation_umbler";
    return {
      ok: true,
      ruleId: rule.id,
      message:
        automation && outcome !== "replayed"
          ? `Pronto: agora uma regra vale para todos os números ${rule.origin === "automation_umbler" ? "da Umbler" : "do Unnichat"}, de todas as conexões. As URLs antigas continuam funcionando e entregam nesta regra; quando puder, troque-as pela URL do evento.`
          : outcome === "created"
          ? "Pronto: agora uma regra vale para todos os números. As regras antigas foram pausadas e o histórico delas continua salvo. Dá para voltar atrás: retome as regras pausadas e pause a regra para todos os números."
          : outcome === "reused_existing"
            ? "Já existia uma regra igual para todos os números. As regras por número foram pausadas e ela segue valendo."
            : "Estas regras já tinham sido unificadas. Nada mudou.",
      unify: {
        outcome,
        ruleId: rule.id,
        ruleName: rule.conversionRule.name,
        deactivatedRuleIds: result.data.deactivatedRuleIds,
        newlyCoveredChannelIds: result.data.newlyCoveredChannelIds,
        duplicatePhoneChannelIds: rule.duplicatePhoneChannelIds ?? [],
      },
    };
  } catch (error) {
    if (apiStatus(error) === 409 && apiCode(error) === "provider_rule_unify_differences") {
      return {
        ok: false,
        message:
          "As regras têm valores ou modos diferentes. Confira quais vão valer e confirme antes de unificar.",
      };
    }
    return failure(error, "Não foi possível unificar as regras.", unifyUnknownMessage);
  }
}

const bulkRemoveUnknownMessage =
  "Não deu para confirmar a exclusão. Atualize a página para ver quais regras saíram.";

/**
 * "Excluir selecionadas": removes several rules; the API answers per rule so
 * a partial success is reported, never hidden. A rule other unified rules
 * point to only goes when its id is also sent as "confirmTargetId".
 */
export async function removeConversionRulesAction(
  formData: FormData,
): Promise<ConversionScreenActionResult> {
  const ruleIds = formData
    .getAll("ruleId")
    .filter((id): id is string => typeof id === "string" && id.trim() !== "");
  const confirmTargetRuleIds = formData
    .getAll("confirmTargetId")
    .filter((id): id is string => typeof id === "string" && id.trim() !== "");
  const input = providerConversionRuleBulkRemoveInputSchema.safeParse({
    ruleIds,
    ...(confirmTargetRuleIds.length > 0 ? { confirmTargetRuleIds } : {}),
  });

  if (!input.success) {
    return { ok: false, message: "Escolha as regras que quer excluir." };
  }

  try {
    const response = await serverApiFetch<unknown>(
      "/conversion-rules/providers/bulk-delete",
      { method: "POST", body: JSON.stringify(input.data) },
    );
    const result =
      providerConversionRuleBulkRemoveResultSchema.safeParse(response);

    if (!result.success) {
      return { ok: false, outcomeUnknown: true, message: bulkRemoveUnknownMessage };
    }

    revalidateRules();
    const { removedCount, results } = result.data;
    return {
      ok: removedCount === results.length,
      bulkRemove: result.data,
      message:
        removedCount === results.length
          ? `${removedCount} ${removedCount === 1 ? "regra excluída" : "regras excluídas"}. O histórico continua salvo.`
          : `${removedCount} de ${results.length} excluídas. Veja abaixo o que ficou.`,
    };
  } catch (error) {
    return failure(
      error,
      "Não foi possível excluir as regras selecionadas.",
      bulkRemoveUnknownMessage,
    );
  }
}

// ---------------------------------------------------------------------------
// "Todos os números": ativar um número e reprocessar bloqueadas
// ---------------------------------------------------------------------------

const activationUnknownMessage =
  "Não deu para confirmar a ativação. Atualize a página para conferir o número.";
const reprocessUnknownMessage =
  "Não deu para confirmar o reprocessamento. Atualize as execuções: repetir não envia nada duas vezes.";

/**
 * "Ativar envio neste número" de uma regra para todos os números: a mesma
 * ativação de Integrações. Conexão pausada ou conexão WhatsApp não ativa voltam
 * pendentes e são resolvidos em Integrações. Trata o 423 da licença.
 */
export async function activateRuleNumberAction(
  formData: FormData,
): Promise<ConversionScreenActionResult> {
  const ruleId = formId(formData, "ruleId");
  const channelId = formId(formData, "channelId");
  if (!ruleId || !channelId) return { ok: false, message: invalidMessage };

  try {
    const response = await serverApiFetch<unknown>(
      `/conversion-rules/providers/${encodeURIComponent(ruleId)}/numbers/${encodeURIComponent(channelId)}/activate`,
      { method: "POST" },
    );
    const result =
      providerConversionRuleNumberActivationResultSchema.safeParse(response);
    if (!result.success) {
      return { ok: false, outcomeUnknown: true, message: activationUnknownMessage };
    }
    revalidateRules();
    const { outcome, reason, rule } = result.data;
    return {
      ok: outcome !== "pending",
      ruleId: rule.id,
      ruleMode: rule.mode,
      pendingNumbers: rule.pendingNumbers ?? [],
      numberActivation: { outcome, reason },
      message:
        outcome === "promoted"
          ? "Envio ativado neste número. As próximas conversas dele já vão para a Meta."
          : outcome === "already_live"
            ? "Este número já estava com o envio ativo."
            : reason === "whatsapp_connection_inactive"
              ? "A conexão WhatsApp deste número não está ativa (suspensa ou removida). Reative-a em Integrações e tente de novo."
              : reason === "meta_route_missing"
                ? "Falta uma rota Meta válida para este número. Configure em Integrações e tente de novo."
                : reason === "connection_paused"
                  ? "A conexão deste número está pausada. Ela só volta a enviar quando for retomada em Integrações."
                  : "Não deu para ativar este número agora. Confira a conexão em Integrações e tente de novo.",
    };
  } catch (error) {
    if (apiStatus(error) === 409) {
      return {
        ok: false,
        message: "Ative o envio automático da regra antes de ativar um número.",
      };
    }
    return failure(error, "Não foi possível ativar este número.", activationUnknownMessage);
  }
}

/**
 * "Reprocessar bloqueadas": reenvia as execuções da regra bloqueadas só
 * porque o número ainda não enviava (últimos 7 dias, nunca em dobro). Trata
 * o 423 da licença.
 */
export async function reprocessBlockedExecutionsAction(
  formData: FormData,
): Promise<ConversionScreenActionResult> {
  const ruleId = formId(formData, "ruleId");
  if (!ruleId) return { ok: false, message: invalidMessage };

  try {
    const response = await serverApiFetch<unknown>(
      `/conversion-rules/providers/${encodeURIComponent(ruleId)}/reprocess-blocked`,
      { method: "POST" },
    );
    const result =
      providerConversionRuleBlockedReprocessResultSchema.safeParse(response);
    if (!result.success) {
      return { ok: false, outcomeUnknown: true, message: reprocessUnknownMessage };
    }
    revalidateRules();
    return {
      ok: true,
      ruleId,
      reprocess: result.data,
      message: reprocessSummary(result.data),
    };
  } catch (error) {
    const status = apiStatus(error);
    if (status === 429) {
      return {
        ok: false,
        message:
          "Acabamos de reprocessar esta regra. Aguarde alguns segundos e tente de novo.",
      };
    }
    if (status === 409) {
      return {
        ok: false,
        message:
          apiCode(error) === "provider_rule_reprocess_in_progress"
          ? "Já existe um reprocessamento em andamento para esta regra. Aguarde ele terminar."
          : "A regra está pausada ou com o envio desligado. Retome o envio da regra antes de reprocessar.",
      };
    }
    return failure(
      error,
      "Não foi possível reprocessar as execuções.",
      reprocessUnknownMessage,
    );
  }
}

/**
 * Fase 6.1c (produção direta): a regra de uma integração validada já nasce
 * enviando. Sem envio, só quando o servidor está com o envio de regras
 * desligado ou o leitor da integração ainda não foi validado.
 */
function createdRuleMessage(
  mode: "observation" | "production",
  hasWebhookUrl: boolean,
): string {
  const base =
    mode === "production"
      ? "Regra criada e enviando: cada conversão reconhecida vai para a Meta pelo destino de cada número."
      : "Regra criada sem envio: o envio de conversões está desligado na configuração da API, ou esta integração ainda não pode enviar. Depois de resolver, use “Ativar envio” nesta regra.";
  return hasWebhookUrl
    ? `${base} Copie o endereço agora: ele não é exibido de novo.`
    : base;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function reprocessSummary(
  result: ProviderConversionRuleBlockedReprocessResultDto,
): string {
  const parts = [
    result.reprocessed > 0
      ? `${plural(result.reprocessed, "conversa reenviada", "conversas reenviadas")} para a fila de envio`
      : "Nenhuma conversa pronta para reenviar",
  ];
  if (result.stillBlocked > 0) {
    parts.push(
      `${plural(result.stillBlocked, "fica como está", "ficam como estão")} (número ainda sem envio ativo, pausado de propósito na época ou que não é Uazapi/WAHA)`,
    );
  }
  if ((result.alreadyConverted ?? 0) > 0) {
    parts.push(
      `${plural(result.alreadyConverted ?? 0, "fica como está", "ficam como estão")} porque o lead já foi convertido por outro número ou pela entrada do anúncio (nada é enviado de novo à Meta)`,
    );
  }
  if (result.expired > 0) {
    parts.push(
      result.expired === 1
        ? `1 é mais antiga que ${result.windowDays} dias e não pode mais ser enviada à Meta`
        : `${result.expired} são mais antigas que ${result.windowDays} dias e não podem mais ser enviadas à Meta`,
    );
  }
  if (result.skipped + result.failed > 0) {
    parts.push(
      `${plural(result.skipped + result.failed, "não pôde ser reprocessada", "não puderam ser reprocessadas")} por aqui; confira os registros da API se precisar reenviá-las`,
    );
  }
  if (result.remaining > 0) {
    parts.push(`${plural(result.remaining, "ficou", "ficaram")} para o próximo lote`);
  }
  return `${parts.join(". ")}.`;
}

// ---------------------------------------------------------------------------
// Regras antigas (antes das conexões): valor, pausa e "conectar aos números"
// ---------------------------------------------------------------------------

function legacyProductItems(productName: string, valueCents: number | null) {
  if (!productName) return null;

  const id =
    productName
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "produto";

  return [
    {
      id,
      quantity: 1,
      ...(valueCents === null ? {} : { item_price: valueCents / 100 }),
    },
  ];
}

const legacyCurrencies = new Set(["BRL", "USD", "EUR"]);

/**
 * PATCH /conversion-rules/:id de uma regra antiga. `intent` "status" pausa ou
 * reativa; "value" salva produto, valor e moeda.
 */
export async function updateLegacyRuleAction(
  formData: FormData,
): Promise<ConversionScreenActionResult> {
  const ruleId = formText(formData, "ruleId");
  const intent = formText(formData, "intent");

  if (!ruleId || ruleId.length > 255 || (intent !== "status" && intent !== "value")) {
    return { ok: false, message: invalidMessage };
  }

  let body: Record<string, unknown>;
  if (intent === "status") {
    body = { active: formText(formData, "active") === "true" };
  } else {
    const productName = formText(formData, "productName") ?? "";
    const rawValue = formText(formData, "defaultValue");
    // "" = "Padrão do workspace" (null: herda a Moeda das conversões).
    const currency = (formText(formData, "defaultCurrency") ?? "").toUpperCase();
    let valueCents: number | null = null;
    if (rawValue) {
      const normalized = rawValue.includes(",")
        ? rawValue.replace(/\./g, "").replace(",", ".")
        : rawValue;
      const amount = Number(normalized.replace(/R\$\s*/iu, ""));
      if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, message: "Informe um valor maior que zero." };
      }
      valueCents = Math.round(amount * 100);
    }
    if (
      (currency && !legacyCurrencies.has(currency)) ||
      productName.length > 180
    ) {
      return { ok: false, message: invalidMessage };
    }
    body = {
      defaultValueCents: valueCents,
      defaultCurrency: valueCents === null ? null : currency || null,
      defaultContentName: productName || null,
      defaultItems: legacyProductItems(productName, valueCents),
    };
  }

  try {
    await serverApiFetch<unknown>(`/conversion-rules/${encodeURIComponent(ruleId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    revalidateRules();
    return {
      ok: true,
      ruleId,
      message:
        intent === "value"
          ? "Produto e valor salvos."
          : body.active
            ? "Regra antiga reativada."
            : "Regra antiga pausada.",
    };
  } catch (error) {
    return failure(error, "Não foi possível salvar a regra antiga.", changeUnknownMessage);
  }
}

/** POST /conversion-rules/providers/adapt/:ruleId: regra antiga vira "Frase na conversa". */
export async function adaptProviderConversionRuleAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const legacyRuleId = formId(formData, "legacyRuleId");
  const input = providerConversionRuleAdaptInputSchema.safeParse(
    parseJson(formText(formData, "payload")),
  );

  if (!legacyRuleId || !input.success) {
    return { ok: false, message: invalidMessage };
  }

  try {
    const response = await serverApiFetch<unknown>(
      `/conversion-rules/providers/adapt/${encodeURIComponent(legacyRuleId)}`,
      { method: "POST", body: JSON.stringify(input.data) },
    );
    const result = providerConversionRuleSchema.safeParse(response);

    if (!result.success) {
      return { ok: false, outcomeUnknown: true, message: changeUnknownMessage };
    }

    revalidateRules();
    return {
      ok: true,
      message:
        result.data.mode === "production"
          ? "Regra conectada aos números e enviando para a Meta."
          : "Regra conectada aos números, com o envio desligado.",
    };
  } catch (error) {
    return failure(
      error,
      "Não foi possível conectar a regra aos números.",
      changeUnknownMessage,
    );
  }
}

// ---------------------------------------------------------------------------
// Gerenciar uma regra de provedor
// ---------------------------------------------------------------------------

export async function updateProviderConversionRuleAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");
  const input = providerConversionRuleUpdateInputSchema.safeParse(
    parseJson(formText(formData, "payload")),
  );

  if (!ruleId || !input.success) {
    return { ok: false, message: invalidMessage };
  }

  try {
    const response = await serverApiFetch<unknown>(
      `/conversion-rules/providers/${encodeURIComponent(ruleId)}`,
      { method: "PATCH", body: JSON.stringify(input.data) },
    );
    const result = providerConversionRuleSchema.safeParse(response);

    if (!result.success || result.data.id !== ruleId) {
      return { ok: false, outcomeUnknown: true, message: changeUnknownMessage };
    }

    revalidateRules();
    return {
      ok: true,
      message: result.data.conversionRule.active
        ? "Regra atualizada."
        : "Regra pausada.",
    };
  } catch (error) {
    return failure(
      error,
      "Não foi possível atualizar a regra.",
      changeUnknownMessage,
    );
  }
}

export async function rotateProviderConversionRuleEndpointAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");
  if (!ruleId) return { ok: false, message: invalidMessage };

  try {
    const response = await serverApiFetch<unknown>(
      `/conversion-rules/providers/${encodeURIComponent(ruleId)}/rotate-endpoint`,
      { method: "POST", body: "{}" },
    );
    const result =
      providerConversionEndpointSecretResultSchema.safeParse(response);

    if (!result.success || result.data.endpoint.providerRuleId !== ruleId) {
      return {
        ok: false,
        outcomeUnknown: true,
        message:
          "Não deu para confirmar se um novo endereço foi gerado. Se a plataforma parar de enviar eventos, gere um novo endereço e cole de novo.",
      };
    }

    revalidateRules();
    return {
      ok: true,
      message:
        "Endereço trocado. Copie o novo endereço agora; o anterior parou de funcionar.",
      oneTimeSecret: { ruleId, webhookUrl: result.data.webhookUrl },
    };
  } catch (error) {
    return failure(
      error,
      "Não foi possível gerar um novo endereço.",
      "Não deu para confirmar se um novo endereço foi gerado. Se a plataforma parar de enviar eventos, gere um novo endereço e cole de novo.",
    );
  }
}

export async function removeProviderConversionRuleAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");
  if (!ruleId) return { ok: false, message: invalidMessage };

  try {
    await serverApiFetch<void>(
      `/conversion-rules/providers/${encodeURIComponent(ruleId)}`,
      { method: "DELETE" },
    );

    revalidateRules();
    return {
      ok: true,
      message: "Regra excluída. O histórico dela continua salvo.",
    };
  } catch (error) {
    // Porte do #161: a rule already removed (another tab, a bulk delete).
    if (apiStatus(error) === 404) {
      return {
        ok: false,
        message:
          "Esta regra não foi encontrada (talvez já tenha sido excluída). Atualize a página para conferir.",
      };
    }
    return failure(
      error,
      "Não foi possível excluir a regra.",
      "Não deu para confirmar a exclusão. Atualize a página para conferir.",
    );
  }
}

export async function testProviderCatalogMessageAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");
  const input = structuredCatalogTestMessageInputSchema.safeParse({
    messageText: formText(formData, "messageText"),
  });

  if (!ruleId || !input.success) {
    return { ok: false, message: invalidMessage };
  }

  try {
    const response = await serverApiFetch<unknown>(
      `/conversion-rules/providers/${encodeURIComponent(ruleId)}/test-message`,
      { method: "POST", body: JSON.stringify(input.data) },
    );
    const result = structuredCatalogTestMessageResultSchema.safeParse(response);

    if (!result.success) {
      return { ok: false, message: "Não foi possível testar esta mensagem." };
    }

    return {
      ok: true,
      message: result.data.matched
        ? "Mensagem reconhecida pelo catálogo."
        : "A mensagem foi bloqueada pelo catálogo.",
      testResult: result.data,
    };
  } catch (error) {
    return failure(
      error,
      "Não foi possível testar esta mensagem.",
      "Não foi possível testar esta mensagem.",
    );
  }
}

// ---------------------------------------------------------------------------
// Histórico: execuções e eventos recebidos (leituras)
// ---------------------------------------------------------------------------

export async function loadProviderConversionExecutionAuditAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");
  if (!ruleId) return { ok: false, message: invalidMessage };

  try {
    const query = new URLSearchParams({ page: "1", pageSize: "50" });
    const response = await serverApiFetch<unknown>(
      `/conversion-rules/providers/${encodeURIComponent(ruleId)}/executions?${query.toString()}`,
    );
    const result = providerConversionRuleExecutionAuditSchema.safeParse(response);
    if (!result.success || result.data.providerRuleId !== ruleId) {
      return { ok: false, message: "Não foi possível carregar as execuções desta regra." };
    }

    return {
      ok: true,
      message: "Execuções atualizadas.",
      executionAudit: result.data,
    };
  } catch (error) {
    return failure(
      error,
      "Não foi possível carregar as execuções desta regra.",
      "Não foi possível carregar as execuções desta regra.",
    );
  }
}

export async function loadProviderConversionAutomationAuditAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");
  if (!ruleId) return { ok: false, message: invalidMessage };

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/inbound-webhooks/provider-rules/${encodeURIComponent(ruleId)}/callbacks`,
    );
    const result = providerConversionAutomationAuditSchema.safeParse(response);
    if (!result.success || result.data.providerRuleId !== ruleId) {
      return { ok: false, message: "Não foi possível carregar os eventos recebidos desta regra." };
    }

    return {
      ok: true,
      message: "Eventos recebidos atualizados.",
      automationAudit: result.data,
    };
  } catch (error) {
    return failure(
      error,
      "Não foi possível carregar os eventos recebidos desta regra.",
      "Não foi possível carregar os eventos recebidos desta regra.",
    );
  }
}

export async function loadProviderConversionAutomationPayloadAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");
  const deliveryId = formId(formData, "deliveryId");
  if (!ruleId || !deliveryId) return { ok: false, message: invalidMessage };

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/inbound-webhooks/provider-rules/${encodeURIComponent(ruleId)}/callbacks/${encodeURIComponent(deliveryId)}/payload`,
    );
    const result = providerConversionAutomationPayloadSchema.safeParse(response);
    if (
      !result.success ||
      result.data.providerRuleId !== ruleId ||
      result.data.deliveryId !== deliveryId
    ) {
      return { ok: false, message: "Não foi possível abrir os dados deste evento." };
    }

    return {
      ok: true,
      message: "Dados carregados.",
      automationPayload: result.data,
    };
  } catch (error) {
    return failure(
      error,
      "Não foi possível abrir os dados deste evento.",
      "Não foi possível abrir os dados deste evento.",
    );
  }
}

export async function reprocessProviderConversionAutomationCallbacksAction(
  formData: FormData,
): Promise<ProviderConversionRuleActionResult> {
  const ruleId = formId(formData, "ruleId");
  const input = providerConversionAutomationReprocessBatchInputSchema.safeParse(
    parseJson(formText(formData, "payload")),
  );
  if (!ruleId || !input.success) return { ok: false, message: invalidMessage };

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/inbound-webhooks/provider-rules/${encodeURIComponent(ruleId)}/callbacks/reprocess`,
      { method: "POST", body: JSON.stringify(input.data) },
    );
    const result =
      providerConversionAutomationReprocessBatchResultSchema.safeParse(response);
    if (!result.success || result.data.providerRuleId !== ruleId) {
      return {
        ok: false,
        outcomeUnknown: true,
        message:
          "Não deu para confirmar o reprocessamento. Atualize a lista para conferir.",
      };
    }

    revalidateRules();
    return {
      ok: true,
      message: `${result.data.queued} encaminhado(s), ${result.data.blocked} bloqueado(s) e ${result.data.skipped} sem mudança.`,
      automationReprocess: result.data,
    };
  } catch (error) {
    return failure(
      error,
      "Não foi possível reprocessar os eventos selecionados.",
      "Não deu para confirmar o reprocessamento. Atualize a lista para conferir.",
    );
  }
}
