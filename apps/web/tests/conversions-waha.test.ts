// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { setupUser } from "./user-shim";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversionScreenActionResult } from "../src/app/(app)/conversions/actions";
import {
  ineligibleNumbers,
  numbersForOrigin,
  type ConversionConnection,
  type ConversionNumber,
} from "../src/app/(app)/conversions/conversion-rules-view";
import {
  originChannelProviders,
  ruleOriginDefinition,
} from "../src/app/(app)/conversions/conversion-origins";
import { NewRuleFlow } from "../src/app/(app)/conversions/new-rule-flow";
import { capabilities, connections, numbers } from "./conversions-fixtures";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.style.overflow = "";
});

/** A WAHA (GoWS) number, bridged as the inbound connection "waha". */
const wahaConnection: ConversionConnection = {
  id: "conn_waha",
  provider: "waha",
  displayName: "WAHA Loja",
  status: "observation",
};
const wahaNumber: ConversionNumber = {
  id: "ch_waha",
  connectionId: "conn_waha",
  provider: "waha",
  connectionName: "WAHA Loja",
  label: "WAHA Loja",
  phone: "+5511987650099",
  whatsappInstanceId: "inst_waha",
  routeIds: [],
  status: "discovered",
};

type Action = (formData: FormData) => Promise<ConversionScreenActionResult>;

function renderFlow(createAction: Action) {
  return render(
    createElement(NewRuleFlow, {
      offeredOrigins: ["message_phrase", "whatsapp_label"],
      numbers: [...numbers, wahaNumber],
      connections: [...connections, wahaConnection],
      capabilities,
      comingSoonNumbers: [],
      licenseLocked: false,
      createAction,
      confirmAction: vi.fn(),
      onFinished: () => undefined,
    }),
  );
}

describe("WAHA nas regras de frase", () => {
  it("a WAHA é origem de frase da equipe e não oferece etiqueta", () => {
    expect(originChannelProviders("message_phrase", capabilities)).toContain("waha");
    expect(originChannelProviders("whatsapp_label", capabilities)).not.toContain("waha");
    expect(ruleOriginDefinition("message_phrase").fallbackChannelProviders).toContain("waha");
    expect(ruleOriginDefinition("whatsapp_label").fallbackChannelProviders).not.toContain("waha");
    expect(ruleOriginDefinition("whatsapp_label").description).not.toMatch(/QR/u);
    expect(numbersForOrigin("message_phrase", [wahaNumber], null, capabilities)).toHaveLength(1);
    expect(numbersForOrigin("whatsapp_label", [wahaNumber], null, capabilities)).toHaveLength(0);
    // Not in "sem regras": WAHA runs phrase rules.
    expect(ineligibleNumbers([wahaNumber], capabilities)).toEqual([]);
  });

  it("Nova regra de frase deixa escolher o número da WAHA", async () => {
    const user = setupUser();
    const createAction = vi.fn(async () => ({
      ok: true,
      ruleId: "rule_waha",
      message: "Regra criada.",
    }));
    renderFlow(createAction);

    await user.click(screen.getByRole("radio", { name: /Frase na conversa/ }));
    await user.click(screen.getByRole("button", { name: /Continuar/ }));
    await user.click(screen.getByRole("button", { name: /Continuar/ }));
    await user.click(screen.getByRole("radio", { name: /Números específicos/ }));

    const waha = screen.getByRole("checkbox", { name: /WAHA Loja/ });
    await user.click(waha);
    expect((waha as HTMLInputElement).checked).toBe(true);
    const without = screen.queryByLabelText("Números sem regras");
    if (without) {
      expect(within(without).queryByText(/WAHA/u)).toBeNull();
    }
  });
});
