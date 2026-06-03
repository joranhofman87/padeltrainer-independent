import { describe, it, expect } from "vitest";
import {
  shouldDeferAddPlayerClose,
  shouldWarnInvoiceCreateFailure,
} from "@/lib/addPlayerInvoiceFlow";
import type { InvoiceAfterAddPlayerResult } from "@/lib/invoiceAfterAddPlayer";

function result(
  overrides: Partial<InvoiceAfterAddPlayerResult>,
): InvoiceAfterAddPlayerResult {
  return {
    created: 0,
    skipped: 0,
    failed: 0,
    invoiceCreateAttempts: 0,
    invoiceCreateSkipped: 0,
    nonChargeableBookings: 0,
    needsConfirmation: false,
    classification: {
      draftInvoiceIds: [],
      sentOrPendingInvoiceIds: [],
      paidInvoiceIds: [],
      cancelledInvoiceIds: [],
    },
    paidUnchangedCount: 0,
    draftsRecalculated: false,
    sentRecalculated: false,
    ...overrides,
  };
}

describe("shouldDeferAddPlayerClose", () => {
  it("defers close when confirmation is required", () => {
    expect(shouldDeferAddPlayerClose(result({ needsConfirmation: true }))).toBe(true);
  });

  it("closes immediately when no confirmation is required", () => {
    expect(shouldDeferAddPlayerClose(result({ needsConfirmation: false }))).toBe(false);
  });
});

describe("shouldWarnInvoiceCreateFailure", () => {
  it("does not warn when all create attempts were skipped/deduped", () => {
    expect(
      shouldWarnInvoiceCreateFailure(
        result({
          invoiceCreateAttempts: 1,
          invoiceCreateSkipped: 1,
          created: 0,
          failed: 0,
        }),
      ),
    ).toBe(false);
  });

  it("does not warn when there were no chargeable invoice attempts", () => {
    expect(
      shouldWarnInvoiceCreateFailure(
        result({ invoiceCreateAttempts: 0, created: 0, failed: 0 }),
      ),
    ).toBe(false);
  });

  it("warns on invoke failures", () => {
    expect(
      shouldWarnInvoiceCreateFailure(
        result({ invoiceCreateAttempts: 1, failed: 1, created: 0 }),
      ),
    ).toBe(true);
  });

  it("warns when chargeable but neither created nor skipped", () => {
    expect(
      shouldWarnInvoiceCreateFailure(
        result({
          invoiceCreateAttempts: 1,
          invoiceCreateSkipped: 0,
          created: 0,
          failed: 0,
        }),
      ),
    ).toBe(true);
  });
});
