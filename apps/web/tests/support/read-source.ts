import { readFileSync as readRawFileSync } from "node:fs";

// Drop-in for tests that assert on source text: Windows checkouts with
// core.autocrlf=true read files as CRLF, while the assertions expect LF.
export function readFileSync(
  path: Parameters<typeof readRawFileSync>[0],
  encoding: "utf8",
): string {
  return readRawFileSync(path, encoding).replace(/\r\n/g, "\n");
}
