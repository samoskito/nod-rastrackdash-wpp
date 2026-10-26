import { describe, expect, it } from "vitest";
import {
  executionReasonLabel,
  purchaseReviewReasonLabel,
} from "../src/app/(app)/settings/provider-conversion-labels";

describe("cross-number dedupe reason label", () => {
  it("explains in Portuguese an execution not sent because another number converted the lead", () => {
    expect(executionReasonLabel("lead_already_converted_other_number")).toBe(
      "Lead já convertido por outro número: nada novo enviado à Meta",
    );
    // Purchase reviews fall back to the execution labels.
    expect(
      purchaseReviewReasonLabel("lead_already_converted_other_number"),
    ).toBe("Lead já convertido por outro número: nada novo enviado à Meta");
    expect(executionReasonLabel("lead_already_converted_other_source")).toBe(
      "Lead já convertido pela entrada do anúncio: nada novo enviado à Meta",
    );
  });
});
