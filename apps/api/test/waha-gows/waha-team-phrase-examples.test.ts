import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hashPhoneIdentityVariants,
  hashPhoneIdentity,
} from "../../src/common/phone/phone-identity";
import { matchProviderMessageTrigger } from "../../src/conversion-rules/structured-catalog-message.parser";
import {
  parseWahaV2Webhook,
  wahaV2UnresolvedTeamContactLid,
  withWahaResolvedTeamContactPhone,
} from "../../src/inbound-webhooks/providers/waha/waha-v2.parser";
import { wahaGowsFixture, wahaGowsFixturesDir } from "./helpers/fixtures";

/**
 * Exemplos reais anonimizados de mensagens da equipe em WAHA (message.any,
 * fromMe) com frase casada no Rastrackapp (set/2026). O Rastrackapp guarda só
 * o texto e o formato do telefone, então o envelope GoWS é o sintético do
 * repositório com o texto e o contato de cada exemplo.
 */
type Example = {
  id: string;
  event: string;
  eventName: string | null;
  phrase: string | null;
  text: string | null;
  occurrenceCase: string | null;
  originalLength: number | null;
  hasLineBreak: boolean;
  hasEmoji: boolean;
  hasUrl: boolean;
  contactPhone: string;
  contactPhoneFormat: string;
};

const examples = (
  JSON.parse(
    readFileSync(resolve(wahaGowsFixturesDir, "team-phrase-examples.json"), "utf8"),
  ) as { examples: Example[] }
).examples;

/**
 * The anonymized text is short; the real one was often long, with emoji,
 * URL and line breaks around the phrase. Rebuild that shape (phrase kept in
 * the middle) so the matcher sees what production sees.
 */
function productionShapedText(example: Example): string {
  const text = example.text ?? "";
  const before = [
    example.hasEmoji ? "Oi! 😊✨" : "Oi!",
    example.hasUrl ? "https://exemplo.invalid/pedido?id=123" : "",
  ]
    .filter(Boolean)
    .join(example.hasLineBreak ? "\n" : " ");
  let after = example.hasEmoji ? "Qualquer dúvida é só chamar 🙏" : "Obrigado.";
  const target = example.originalLength ?? 0;
  while (`${before} ${text} ${after}`.length < target) {
    after += " texto sintético de preenchimento";
  }
  return `${before}${example.hasLineBreak ? "\n" : " "}${text}${
    example.hasLineBreak ? "\n" : " "
  }${after}`;
}

function teamEnvelope(example: Example, text: string | null) {
  const body = wahaGowsFixture("message-any-team-recipient-alt");
  const phone = example.contactPhone;
  if (example.contactPhoneFormat === "lid_nao_resolvido") {
    body.payload.to = `${phone}@lid`;
    body.payload._data.Info.Chat = `${phone}@lid`;
    body.payload._data.Info.RecipientAlt = "";
  } else {
    body.payload.to = `${phone}@c.us`;
    body.payload._data.Info.Chat = `${phone}@s.whatsapp.net`;
    body.payload._data.Info.RecipientAlt = `${phone}@s.whatsapp.net`;
  }
  body.payload.id = `true_${phone}@c.us_3EB0${example.id.toUpperCase()}`;
  body.payload._data.Info.ID = `3EB0${example.id.toUpperCase()}`;
  if (text === null) {
    delete body.payload.body;
    body.payload.hasMedia = true;
    body.payload._data.Message = { audioMessage: { seconds: 4 } };
  } else {
    body.payload.body = text;
    body.payload._data.Message = { conversation: text };
  }
  return body;
}

describe("WAHA: exemplos reais (anonimizados) de frase da equipe", () => {
  it("são 28, todos message.any do time, sem dado pessoal", () => {
    expect(examples).toHaveLength(28);
    for (const example of examples) {
      expect(example.event).toBe("message.any");
      // Synthetic numbers only (DDD 00 / zeroed LID).
      expect(example.contactPhone).toMatch(/^(55)?00\d+$|^0+\d+$/u);
    }
  });

  const withPhrase = examples.filter(
    (example) =>
      example.phrase &&
      example.text &&
      example.contactPhoneFormat !== "lid_nao_resolvido",
  );

  it.each(withPhrase.map((example) => [example.id, example] as const))(
    "%s: o parser lê a mensagem do time e a frase casa como na Uazapi (contém, sem caixa)",
    (_id, example) => {
      const text = productionShapedText(example);
      const parsed = parseWahaV2Webhook(teamEnvelope(example, text));
      const event = parsed.events[0];

      expect(parsed.classification).toBe("ignored_outbound");
      expect(event?.message.direction).toBe("outbound");
      expect(event?.message.authorType).toBe("organization_member");
      expect(event?.message.text).toBe(text.trim());
      expect(event?.contact.phoneNumber).toBe(example.contactPhone);
      expect(event?.ctwaClid).toBeNull();
      expect(
        matchProviderMessageTrigger(event!.message.text!, [example.phrase!]),
      ).toBe(example.phrase);
    },
  );

  it("casa sem diferenciar maiúsculas, com acento e markdown do WhatsApp", () => {
    const phrase = "Estamos felizes em confirmar sua *Consulta Inicial!*";
    expect(
      matchProviderMessageTrigger(
        "Bom dia!\nESTAMOS FELIZES EM CONFIRMAR SUA *CONSULTA INICIAL!* 🎉",
        [phrase],
      ),
    ).toBe(phrase);
    expect(
      matchProviderMessageTrigger("texto vou te enviar nosso CATÁLOGO pra você", [
        "Vou te enviar nosso catálogo",
      ]),
    ).toBe("Vou te enviar nosso catálogo");
    expect(
      matchProviderMessageTrigger("seu pedido saiu para entrega", [
        "SEU PEDIDO ESTÁ CONFIRMADO",
      ]),
    ).toBeNull();
  });

  it("contato só com LID: sem telefone, sem evento; o LID do contato é o que a WAHA resolve", () => {
    const lidOnly = examples.filter(
      (example) => example.contactPhoneFormat === "lid_nao_resolvido",
    );
    expect(lidOnly.length).toBeGreaterThan(0);
    for (const example of lidOnly) {
      const body = teamEnvelope(example, example.text ?? "texto sintético");
      const parsed = parseWahaV2Webhook(body);
      expect(parsed.events).toHaveLength(0);
      expect(parsed.classificationReason).toBe("contact_phone_unresolved");
      expect(wahaV2UnresolvedTeamContactLid(body)).toBe(example.contactPhone);

      const resolved = parseWahaV2Webhook(
        withWahaResolvedTeamContactPhone(body, "5511987654321"),
      );
      expect(resolved.events[0]?.contact.phoneNumber).toBe("5511987654321");
      expect(resolved.events[0]?.message.direction).toBe("outbound");
    }
  });

  it("nunca devolve o LID da própria loja como contato", () => {
    const body = wahaGowsFixture("message-any-team-recipient-alt");
    body.payload._data.Info.RecipientAlt = "";
    body.payload.to = "100000000009999@lid";
    body.payload._data.Info.Chat = "100000000009999@lid";
    expect(wahaV2UnresolvedTeamContactLid(body)).toBeNull();
    // An inbound message is never a team message.
    expect(
      wahaV2UnresolvedTeamContactLid(wahaGowsFixture("message-lid-without-sender-alt")),
    ).toBeNull();
  });

  it("mensagem do time sem texto (mídia, áudio, figurinha) chega sem texto", () => {
    const empty = examples.find((example) => example.text === null)!;
    const parsed = parseWahaV2Webhook(
      teamEnvelope({ ...empty, contactPhoneFormat: "br_celular_13dig", contactPhone: "5500900000101" }, null),
    );
    expect(parsed.events[0]?.message.direction).toBe("outbound");
    expect(parsed.events[0]?.message.text ?? null).toBeNull();
  });

  it("telefone de 12 dígitos (sem o nono) e de 13 são o mesmo lead", () => {
    const twelve = examples.filter(
      (example) => example.contactPhoneFormat === "br_12dig_sem_nono_digito",
    );
    expect(twelve.length).toBeGreaterThan(0);
    // Same line with a real area code (the anonymized DDD 00 is not one).
    const withoutNinth = "551187654321";
    const withNinth = "5511987654321";
    expect(hashPhoneIdentityVariants([withoutNinth])).toContain(
      hashPhoneIdentity(withNinth),
    );
    expect(hashPhoneIdentityVariants([withNinth])).toContain(
      hashPhoneIdentity(withoutNinth),
    );
  });
});
