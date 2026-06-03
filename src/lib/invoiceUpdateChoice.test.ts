import { describe, it, expect } from "vitest";
import {
  resolveInvoiceUpdateDecision,
  getRecalcStatusesForChoice,
  shouldRecalcSentInvoices,
} from "@/lib/invoiceUpdateChoice";

describe("resolveInvoiceUpdateDecision", () => {
  it("defaults to update_drafts_only when no sent invoices", () => {
    const d = resolveInvoiceUpdateDecision({
      draftInvoiceIds: ["d1"],
      sentOrPendingInvoiceIds: [],
      paidInvoiceIds: [],
      cancelledInvoiceIds: [],
    });
    expect(d.defaultChoice).toBe("update_drafts_only");
    expect(d.requiresConfirmation).toBe(false);
  });

  it("requires confirmation when sent invoices present", () => {
    const d = resolveInvoiceUpdateDecision({
      draftInvoiceIds: ["d1"],
      sentOrPendingInvoiceIds: ["s1"],
      paidInvoiceIds: [],
      cancelledInvoiceIds: [],
    });
    expect(d.requiresConfirmation).toBe(true);
  });

  it("reports paid in summary", () => {
    const d = resolveInvoiceUpdateDecision({
      draftInvoiceIds: [],
      sentOrPendingInvoiceIds: [],
      paidInvoiceIds: ["p1"],
      cancelledInvoiceIds: [],
    });
    expect(d.summary.hasPaidUnchanged).toBe(true);
  });
});

describe("getRecalcStatusesForChoice", () => {
  it("draft only includes draft", () => {
    expect(getRecalcStatusesForChoice("update_drafts_only")).toEqual(["draft"]);
  });

  it("draft and sent includes sent statuses", () => {
    expect(getRecalcStatusesForChoice("update_drafts_and_sent")).toEqual([
      "draft",
      "sent",
      "pending",
      "overdue",
    ]);
  });

  it("skip returns empty", () => {
    expect(getRecalcStatusesForChoice("skip")).toEqual([]);
  });
});

describe("shouldRecalcSentInvoices", () => {
  it("is true only for update_drafts_and_sent", () => {
    expect(shouldRecalcSentInvoices("update_drafts_and_sent")).toBe(true);
    expect(shouldRecalcSentInvoices("update_drafts_only")).toBe(false);
    expect(shouldRecalcSentInvoices("skip")).toBe(false);
  });
});
