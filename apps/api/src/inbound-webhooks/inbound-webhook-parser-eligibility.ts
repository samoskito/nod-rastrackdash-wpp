import { ConflictException } from "@nestjs/common";
import type { RuntimeEnv } from "../common/runtime/runtime.module";
import { MetaCloudV1Parser } from "./providers/meta-cloud/meta-cloud-v1.parser";
import { InboundWebhookParserRegistry } from "./providers/inbound-webhook-parser.registry";
import { metaCloudAppSecretSource } from "./meta-cloud-app-secret";

/** A coluna é obrigatória no tipo: um select que a esqueça não compila. */
export type MetaCloudSigningConnection = {
  provider: string;
  metaAppSecretEncrypted: string | null;
};

type Release = { provider: string; version: string; status: string };
const builtInRegistry = new InboundWebhookParserRegistry();

/** Product validation applies only to this shipped implementation and exact version.
 * Persisted observation_only is kept intact on upgrades; retired always wins.
 * This is eligibility, never automatic activation or historical authorization.
 */
export function inboundParserProductionEligible(
  release: Release,
  registry: InboundWebhookParserRegistry = builtInRegistry,
): boolean {
  if (!["certified", "observation_only"].includes(release.status)) return false;
  // Existing per-release certification contracts (including automation parsers)
  // remain unchanged. No new built-in trust is granted to other providers.
  if (release.provider !== "meta_cloud")
    return (
      [
        "umbler",
        "gupshup",
        "data_crazy",
        "waha",
        "zapi",
        "uazapi",
        // Fase 4a: Payt sale parsers (certified by migration).
        "payt",
        // Fase 6.5: Braip sale parser (certified by migration: production direct).
        "braip",
        // Fase 6.7: Yampi sale parser (certified by migration: production direct).
        "yampi",
        // Fase 4b: Unnichat entry and automation parsers (certified by migration).
        "unnichat",
        // Fase 6.8: ROI Chat entry and purchase parsers (certified by
        // migration: validated with real payloads received in the SaaS).
        "roichat",
      ].includes(release.provider) && release.status === "certified"
    );
  try {
    const parser = registry.resolve({
      provider: release.provider,
      parserVersion: release.version,
      parserReleaseStatus: release.status,
    });
    return (
      release.provider === "meta_cloud" &&
      release.version === "v1" &&
      parser.constructor === MetaCloudV1Parser
    );
  } catch {
    return false;
  }
}

export function effectiveInboundParserStatus<T extends Release>(
  release: T,
): T["status"] {
  return inboundParserProductionEligible(release)
    ? "certified"
    : release.status;
}

export const missingMetaSigningSecretMessage =
  "Preencha o App Secret do seu próprio app Meta nesta conexão (Integrações → cartão da conexão → “App do Meta desta conexão”) ou, se a instalação usa um único app Meta, o META_APP_SECRET na configuração da API, antes de enviar. Não use o segredo PalmUP nem cole segredos no chat.";

/**
 * Portão único da assinatura Meta Cloud: vale o segredo da conexão; sem ele,
 * o META_APP_SECRET do ambiente (resolveMetaCloudAppSecret). Outros
 * provedores passam direto.
 */
export function assertMetaCloudSigningConfigured(
  connection: MetaCloudSigningConnection,
  env: RuntimeEnv,
): void {
  if (!metaCloudSigningConfigured(connection, env)) {
    throw new ConflictException(missingMetaSigningSecretMessage);
  }
}

export function metaCloudSigningConfigured(
  connection: MetaCloudSigningConnection,
  env: RuntimeEnv,
): boolean {
  return (
    connection.provider !== "meta_cloud" ||
    metaCloudAppSecretSource(connection, env) !== "none"
  );
}
