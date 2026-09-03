import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import type { ExternalMysqlCredentialsInputDto } from "@wpptrack/shared";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";

export const EXTERNAL_CONNECTOR_DNS_LOOKUP = Symbol(
  "EXTERNAL_CONNECTOR_DNS_LOOKUP",
);

export type ExternalConnectorDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

const blockedHostnames = new Set([
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "169.254.169.254",
]);

/**
 * External database credentials are an egress capability. Unlike the BYO
 * WhatsApp adapters, external databases do not need access to Docker/VPC
 * networks, so this policy accepts only public DNS destinations and MySQL's
 * classic TCP port.
 */
@Injectable()
export class ExternalConnectorEgressPolicyService {
  constructor(
    @Optional()
    @Inject(EXTERNAL_CONNECTOR_DNS_LOOKUP)
    private readonly dnsLookup: ExternalConnectorDnsLookup = lookup,
    @Optional()
    @Inject(RUNTIME_ENV)
    private readonly env: RuntimeEnv = process.env,
  ) {}

  /**
   * Resolves a permitted destination once and returns credentials pinned to
   * that numeric address. Callers must use the returned value for the TCP
   * connection, rather than the original hostname, to avoid DNS rebinding.
   */
  async resolveAllowed(
    credentials: ExternalMysqlCredentialsInputDto,
  ): Promise<ExternalMysqlCredentialsInputDto> {
    const hostname = credentials.host
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, "");

    if (credentials.port !== 3306 || this.isBlockedHostname(hostname)) {
      throw new BadRequestException("Destino MySQL nao permitido");
    }

    const literalFamily = isIP(hostname);
    if (literalFamily) {
      if (this.isBlockedAddress(hostname, literalFamily)) {
        throw new BadRequestException("Destino MySQL nao permitido");
      }
      return { ...credentials, host: hostname };
    }

    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await this.lookupWithDeadline(hostname);
    } catch {
      throw new BadRequestException("Destino MySQL nao permitido");
    }

    if (
      addresses.length === 0 ||
      addresses.some(({ address, family }) =>
        this.isBlockedAddress(address, family),
      )
    ) {
      throw new BadRequestException("Destino MySQL nao permitido");
    }

    return { ...credentials, host: addresses[0]!.address };
  }

  async assertAllowed(
    credentials: ExternalMysqlCredentialsInputDto,
  ): Promise<void> {
    await this.resolveAllowed(credentials);
  }

  private isBlockedHostname(hostname: string): boolean {
    return (
      !hostname ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      blockedHostnames.has(hostname)
    );
  }

  private isBlockedAddress(address: string, family: number): boolean {
    if (family === 4) {
      return this.isBlockedIpv4(address);
    }

    if (family !== 6 || isIP(address) !== 6) return true;
    const value = this.ipv6ToBigInt(address);
    if (value === null) return true;

    // ::ffff:0:0/96 must be classified by the embedded IPv4 value, not by
    // string shape. This also catches expanded forms such as
    // 0:0:0:0:0:ffff:c0a8:1.
    if (value >> 32n === 0xffffn) {
      return this.isBlockedIpv4Number(Number(value & 0xffffffffn));
    }

    // Only globally-routable IPv6 unicast is allowed. This rejects loopback,
    // unspecified, unique-local, link-local, multicast, documentation, and
    // any other special-purpose representation regardless of compression.
    if (value >> 125n !== 1n) return true;
    const documentationStart = 0x20010db8000000000000000000000000n;
    const documentationEnd = documentationStart + (1n << 96n);
    return value >= documentationStart && value < documentationEnd;
  }

  private isBlockedIpv4(address: string): boolean {
    if (isIP(address) !== 4) return true;
    const parts = address.split(".").map(Number);
    return this.isBlockedIpv4Number(
      (((parts[0]! << 24) >>> 0) |
        (parts[1]! << 16) |
        (parts[2]! << 8) |
        parts[3]!) >>>
        0,
    );
  }

  private isBlockedIpv4Number(value: number): boolean {
    const first = value >>> 24;
    const second = (value >>> 16) & 0xff;
    const third = (value >>> 8) & 0xff;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0) ||
      (first === 192 && second === 2) ||
      (first === 192 && second === 88 && third === 99) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224
    );
  }

  private ipv6ToBigInt(address: string): bigint | null {
    const hasCompression = address.includes("::");
    const [left, right, ...extra] = address.split("::");
    if (extra.length > 0) return null;
    const leftParts = this.ipv6Parts(left ? left.split(":") : []);
    const rightParts = this.ipv6Parts(right ? right.split(":") : []);
    if (!leftParts || !rightParts) return null;
    const parts = [...leftParts, ...rightParts];
    if (parts.length > 8 || (!hasCompression && parts.length !== 8)) {
      return null;
    }
    const groups = [
      ...leftParts,
      ...Array.from({ length: 8 - parts.length }, () => "0"),
      ...rightParts,
    ];
    if (groups.length !== 8) return null;

    try {
      return groups.reduce(
        (value, group) => (value << 16n) | BigInt(`0x${group}`),
        0n,
      );
    } catch {
      return null;
    }
  }

  private ipv6Parts(parts: string[]): string[] | null {
    const ipv4 = parts.at(-1);
    if (!ipv4?.includes(".")) return parts;
    if (isIP(ipv4) !== 4) return null;
    const octets = ipv4.split(".").map(Number);
    return [
      ...parts.slice(0, -1),
      ((octets[0]! << 8) | octets[1]!).toString(16),
      ((octets[2]! << 8) | octets[3]!).toString(16),
    ];
  }

  private async lookupWithDeadline(
    hostname: string,
  ): Promise<Array<{ address: string; family: number }>> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.dnsLookup(hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("ExternalConnectorDnsTimeout")),
            this.dnsTimeoutMs(),
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private dnsTimeoutMs(): number {
    const value = Number(this.env.WPPTRACK_EXTERNAL_MYSQL_DNS_TIMEOUT_MS);
    if (!Number.isInteger(value) || value < 1) return 2_000;
    return Math.min(value, 5_000);
  }
}
