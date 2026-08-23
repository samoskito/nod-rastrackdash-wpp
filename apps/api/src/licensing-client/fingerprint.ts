import { createHash } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";

/**
 * Stable deploy fingerprint used to identify this installation to the license
 * server. Built from machine identifiers (hostname + MAC addresses) plus the
 * app's configured origin, so it stays stable across process restarts but
 * changes if the deploy is cloned to different hardware/origin.
 */
export function computeFingerprint(appOrigin: string): string {
  const macAddresses = Object.values(networkInterfaces())
    .flat()
    .filter((iface): iface is NonNullable<typeof iface> => Boolean(iface))
    .map((iface) => iface.mac)
    .filter((mac) => mac && mac !== "00:00:00:00:00:00")
    .sort();

  const material = [hostname(), macAddresses.join(","), appOrigin].join("|");
  return createHash("sha256").update(material).digest("hex");
}
