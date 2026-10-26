// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  StudentInboundReplayPreviewDto,
  StudentInboundReplayResultDto,
} from "@wpptrack/shared";
import { InboundRecoveryPanel } from "../src/app/(app)/integrations/inbound-recovery-panel";
import {
  previewInboundRecoveryAction,
  retryInboundRecoveryAction,
} from "../src/app/(app)/integrations/inbound-recovery-actions";

/**
 * Fase 6.1c (porte do SaaS #91): "Reenviar os que falharam" na recuperação
 * do aluno, só para falhas com o payload original ainda guardado.
 */
vi.mock("../src/app/(app)/integrations/inbound-recovery-actions", () => ({
  authorizeInboundRecoveryAction: vi.fn(),
  inboundRecoveryResultAction: vi.fn(),
  previewInboundRecoveryAction: vi.fn(),
  retryInboundRecoveryAction: vi.fn(),
}));

const failed = (
  change: Partial<StudentInboundReplayResultDto> = {},
): StudentInboundReplayResultDto => ({
  batchId: "batch",
  selection: "canary_1",
  state: "failed",
  total: 1,
  delivered: 0,
  failed: 1,
  pending: 0,
  unknown: 0,
  retryableFailed: 1,
  items: [{ id: "item", state: "failed" }],
  ...change,
});
const preview = (
  latestBatch: StudentInboundReplayResultDto,
): StudentInboundReplayPreviewDto => ({
  connectionId: "connection",
  channelId: "channel",
  eligible: 0,
  scanned: 1,
  scanLimit: 2500,
  batchLimit: 500,
  previewToken: null,
  expiresAt: null,
  unavailableReason: null,
  canSendRemaining: false,
  latestBatch,
});

async function mount() {
  render(
    createElement(InboundRecoveryPanel, {
      connectionId: "connection",
      channelId: "channel",
      connectionName: "Meta oficial",
    }),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Recuperar CTWAs anteriores" }));
  });
}

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("reenviar os itens que falharam", () => {
  it("pede o nome da conexão e a confirmação antes de reenviar", async () => {
    vi.mocked(previewInboundRecoveryAction).mockResolvedValue({
      ok: true,
      data: preview(failed()),
    });
    vi.mocked(retryInboundRecoveryAction).mockResolvedValue({
      ok: true,
      data: failed({ state: "pending", failed: 0, pending: 1, retryableFailed: 0 }),
    });
    await mount();
    expect(screen.getByText(/1 item que falhou ainda pode ser reenviado/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "Reenviar os que falharam" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(
      screen.getByLabelText("Nome da conexão para confirmar o reenvio"),
      { target: { value: "Meta oficial" } },
    );
    await act(async () => {
      fireEvent.click(button);
    });
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("conversão CTWA real"),
    );
    expect(retryInboundRecoveryAction).toHaveBeenCalledWith(
      "connection",
      "channel",
      "batch",
      { confirmation: "Meta oficial" },
    );
    expect(screen.getByRole("status").textContent).toContain("Pendente");
  });

  it("falha sem payload guardado não oferece reenvio", async () => {
    vi.mocked(previewInboundRecoveryAction).mockResolvedValue({
      ok: true,
      data: preview(failed({ retryableFailed: 0 })),
    });
    await mount();
    expect(
      screen.queryByRole("button", { name: "Reenviar os que falharam" }),
    ).toBeNull();
    expect(
      screen.getByText(/o payload\s+original já não está guardado/),
    ).toBeTruthy();
  });

  it("mostra a recusa da API (ex.: licença) sem mudar o lote", async () => {
    vi.mocked(previewInboundRecoveryAction).mockResolvedValue({
      ok: true,
      data: preview(failed()),
    });
    vi.mocked(retryInboundRecoveryAction).mockResolvedValue({
      ok: false,
      message: "A licença precisa estar utilizável antes de recuperar CTWAs",
    });
    await mount();
    fireEvent.change(
      screen.getByLabelText("Nome da conexão para confirmar o reenvio"),
      { target: { value: "Meta oficial" } },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reenviar os que falharam" }));
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "A licença precisa estar utilizável",
    );
    expect(screen.getByRole("button", { name: "Reenviar os que falharam" })).toBeTruthy();
  });
});
