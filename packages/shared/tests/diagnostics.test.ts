import { describe, expect, it } from "vitest";
import { diagnosticSourceSchema } from "../src/schemas/diagnostics";

describe("diagnostic source schema", () => {
  it("accepts inbound webhook observation diagnostics", () => {
    expect(diagnosticSourceSchema.parse("umbler")).toBe("umbler");
    expect(diagnosticSourceSchema.parse("gupshup")).toBe("gupshup");
    expect(diagnosticSourceSchema.parse("data_crazy")).toBe("data_crazy");
  });
});
