import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const wahaGowsFixturesDir = resolve(
  __dirname,
  "../../fixtures/waha-gows",
);

export type WahaGowsFixtureName =
  | "message-ctwa-clid"
  | "message-ctwa-source-id-only"
  | "message-organic"
  | "message-any-team-recipient-alt"
  | "message-any-team-no-recipient-alt"
  | "message-any-inbound-duplicate"
  | "message-jid-device-suffix"
  | "message-ctwa-image-first"
  | "message-ctwa-ephemeral"
  | "message-ctwa-view-once"
  | "message-group"
  | "message-status-broadcast"
  | "message-lid-without-sender-alt"
  | "session-status-working"
  | "session-status-scan-qr-code"
  | "session-status-failed"
  | "session-status-stopped";

/** Fresh copy of one synthetic GoWS fixture (safe to mutate per test). */
export function wahaGowsFixture(
  name: WahaGowsFixtureName,
): Record<string, any> {
  return JSON.parse(
    readFileSync(resolve(wahaGowsFixturesDir, `${name}.json`), "utf8"),
  );
}

export function wahaGowsFixtureFiles(): string[] {
  return readdirSync(wahaGowsFixturesDir).filter((file) =>
    file.endsWith(".json"),
  );
}

export const FIXTURE_SESSION = "aluno-sessao-teste";
export const FIXTURE_SELF_PHONE = "5500900009999";
