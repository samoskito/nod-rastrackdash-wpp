import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  maskPersonalValue,
  maskSensitivePayload,
  maskSensitiveText,
} from "../../src/inbound-webhooks/integration-event-inspection";
import { RejectionWriteLimiter } from "../../src/inbound-webhooks/integration-endpoints.service";

/**
 * Revisão do #121 (BAIXA): "Ver dados recebidos" mascara documento, e-mail e
 * endereço do comprador (LGPD), e a URL única não grava uma recusa sem token
 * a cada requisição. Dados sintéticos.
 */
describe("Ver dados recebidos: dados pessoais com máscara parcial", () => {
  it("documento (CPF, CNPJ, document, client_documment): só os 2 últimos", () => {
    const masked = maskSensitivePayload({
      cpf: "123.456.789-09",
      cnpj: "12345678000190",
      customer: { document: "12345678909", doc: "99" },
      client_documment: "98765432100",
      producer_document: "11222333000181",
    }) as Record<string, any>;
    expect(masked.cpf).toBe("••••••09");
    expect(masked.cnpj).toBe("••••••90");
    expect(masked.customer.document).toBe("••••••09");
    expect(masked.customer.doc).toBe("•••");
    expect(masked.client_documment).toBe("••••••00");
    expect(masked.producer_document).toBe("••••••81");
    expect(JSON.stringify(masked)).not.toContain("123.456.789");
  });

  it("e-mail: primeira letra e domínio", () => {
    const masked = maskSensitivePayload({
      email: "comprador@example.test",
      client_email: "x@example.test",
    }) as Record<string, string>;
    expect(masked.email).toBe("c•••@example.test");
    expect(masked.client_email).toBe("x•••@example.test");
  });

  it("endereço: começo da rua e do bairro, CEP com 5 dígitos; cidade e estado legíveis", () => {
    const masked = maskSensitivePayload({
      address: {
        street: "Rua das Flores",
        street_number: "123",
        complement: "Apto 45",
        neighborhood: "Centro",
        zipcode: "01310-100",
        city: "São Paulo",
        state: "SP",
      },
      client_address: "Avenida Paulista, 1000",
      client_zip_code: "01310100",
      client_address_city: "São Paulo",
    }) as Record<string, any>;
    expect(masked.address).toEqual({
      street: "Rua•••",
      street_number: "•••",
      complement: "Apt•••",
      neighborhood: "Cen•••",
      zipcode: "01310-•••",
      city: "São Paulo",
      state: "SP",
    });
    expect(masked.client_address).toBe("Ave•••");
    expect(masked.client_zip_code).toBe("01310-•••");
    expect(masked.client_address_city).toBe("São Paulo");
  });

  it("o resto do recibo continua legível (produto, valor, status)", () => {
    const payload = {
      product_name: "Curso Exemplo",
      trans_value: 19700,
      trans_status: "Pagamento Aprovado",
      IsDocumentWithCaption: false,
    };
    expect(maskSensitivePayload(payload)).toEqual(payload);
    expect(maskPersonalValue("product_name", "Curso")).toBeNull();
  });

  it("corpo de formulário (não JSON) também mascara", () => {
    const text = maskSensitiveText(
      "data%5Bclient_documment%5D=98765432100&data%5Bclient_email%5D=comprador%40example.test&data%5Bproduct_name%5D=Curso",
    );
    expect(text).not.toContain("98765432100");
    expect(text).not.toContain("comprador%40");
    expect(decodeURIComponent(text)).toContain("client_documment]=••••••00");
    expect(decodeURIComponent(text)).toContain("client_email]=c•••@example.test");
    expect(text).toContain("product_name%5D=Curso");
  });
});

describe("URL única: recusas sem token não gravam a cada requisição", () => {
  it("uma gravação por endpoint, IP e motivo por janela", () => {
    const limiter = new RejectionWriteLimiter(60_000, 100);
    const t0 = 1_000_000;
    expect(limiter.allow("e1|1.2.3.4|token_invalid", t0)).toBe(true);
    for (let i = 1; i <= 50; i++)
      expect(limiter.allow("e1|1.2.3.4|token_invalid", t0 + i * 100)).toBe(false);
    // Outro IP, outro motivo ou outro endpoint: grava.
    expect(limiter.allow("e1|5.6.7.8|token_invalid", t0)).toBe(true);
    expect(limiter.allow("e1|1.2.3.4|token_missing", t0)).toBe(true);
    expect(limiter.allow("e2|1.2.3.4|token_invalid", t0)).toBe(true);
    // Depois da janela, grava de novo.
    expect(limiter.allow("e1|1.2.3.4|token_invalid", t0 + 60_000)).toBe(true);
  });

  it("não cresce sem limite com muitos chamadores diferentes", () => {
    const limiter = new RejectionWriteLimiter(60_000, 10);
    for (let i = 0; i < 1_000; i++) limiter.allow(`e1|ip${i}|token_invalid`, 5);
    expect((limiter as any).lastWrite.size).toBeLessThanOrEqual(10);
  });

  it("o serviço só grava a recusa sem token quando o limitador deixa", () => {
    const source = readFileSync(
      resolve(
        __dirname,
        "../../src/inbound-webhooks/integration-endpoints.service.ts",
      ),
      "utf8",
    );
    expect(source).toMatch(
      /if \(rejection\) \{\s+if \(\s+this\.rejectionLimiter\.allow\(/u,
    );
  });
});
