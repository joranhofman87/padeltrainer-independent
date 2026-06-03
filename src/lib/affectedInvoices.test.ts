import { describe, it, expect } from "vitest";
import {
  classifyInvoiceStatus,
  classifyAffectedInvoices,
  buildAffectedInvoicesSummary,
} from "@/lib/affectedInvoices";

describe("classifyInvoiceStatus", () => {
  it("classifies draft", () => {
    expect(classifyInvoiceStatus("draft")).toBe("draft");
  });

  it("classifies sent and pending as sentOrPending", () => {
    expect(classifyInvoiceStatus("sent")).toBe("sentOrPending");
    expect(classifyInvoiceStatus("pending")).toBe("sentOrPending");
  });

  it("classifies overdue as sentOrPending", () => {
    expect(classifyInvoiceStatus("overdue")).toBe("sentOrPending");
  });

  it("classifies paid as paid", () => {
    expect(classifyInvoiceStatus("paid")).toBe("paid");
  });

  it("classifies cancelled as cancelled", () => {
    expect(classifyInvoiceStatus("cancelled")).toBe("cancelled");
  });

  it("treats unknown status as other (confirmation bucket)", () => {
    expect(classifyInvoiceStatus("unknown")).toBe("other");
  });
});

describe("classifyAffectedInvoices", () => {
  it("sorts mixed statuses into buckets", () => {
    const c = classifyAffectedInvoices([
      { id: "d1", status: "draft" },
      { id: "s1", status: "sent" },
      { id: "p1", status: "pending" },
      { id: "o1", status: "overdue" },
      { id: "paid1", status: "paid" },
      { id: "c1", status: "cancelled" },
    ]);
    expect(c.draftInvoiceIds).toEqual(["d1"]);
    expect(c.sentOrPendingInvoiceIds).toEqual(["s1", "p1", "o1"]);
    expect(c.paidInvoiceIds).toEqual(["paid1"]);
    expect(c.cancelledInvoiceIds).toEqual(["c1"]);
  });
});

describe("buildAffectedInvoicesSummary", () => {
  it("requires confirmation when sent/pending exist", () => {
    const summary = buildAffectedInvoicesSummary({
      draftInvoiceIds: ["d1"],
      sentOrPendingInvoiceIds: ["s1"],
      paidInvoiceIds: [],
      cancelledInvoiceIds: [],
    });
    expect(summary.requiresConfirmation).toBe(true);
    expect(summary.sentOrPendingCount).toBe(1);
  });

  it("does not require confirmation for draft-only", () => {
    const summary = buildAffectedInvoicesSummary({
      draftInvoiceIds: ["d1"],
      sentOrPendingInvoiceIds: [],
      paidInvoiceIds: [],
      cancelledInvoiceIds: [],
    });
    expect(summary.requiresConfirmation).toBe(false);
  });

  it("flags paid unchanged", () => {
    const summary = buildAffectedInvoicesSummary({
      draftInvoiceIds: [],
      sentOrPendingInvoiceIds: [],
      paidInvoiceIds: ["p1"],
      cancelledInvoiceIds: [],
    });
    expect(summary.hasPaidUnchanged).toBe(true);
    expect(summary.paidCount).toBe(1);
  });
});
