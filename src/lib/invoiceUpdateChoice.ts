import type { AffectedInvoicesClassification, AffectedInvoicesSummary } from "@/lib/affectedInvoices";
import { buildAffectedInvoicesSummary } from "@/lib/affectedInvoices";

export type InvoiceUpdateChoice =
  | "update_drafts_only"
  | "update_drafts_and_sent"
  | "skip";

export type InvoiceUpdateDecision = {
  defaultChoice: InvoiceUpdateChoice;
  requiresConfirmation: boolean;
  summary: AffectedInvoicesSummary;
};

/** Whether admin must confirm before updating sent/pending invoices. */
export function resolveInvoiceUpdateDecision(
  classification: AffectedInvoicesClassification,
): InvoiceUpdateDecision {
  const summary = buildAffectedInvoicesSummary(classification);
  return {
    defaultChoice: "update_drafts_only",
    requiresConfirmation: summary.requiresConfirmation,
    summary,
  };
}

/** Invoice statuses to recalculate for a given admin choice. Paid/cancelled are never included. */
export function getRecalcStatusesForChoice(choice: InvoiceUpdateChoice): string[] {
  switch (choice) {
    case "update_drafts_only":
      return ["draft"];
    case "update_drafts_and_sent":
      return ["draft", "sent", "pending", "overdue"];
    case "skip":
      return [];
    default:
      return ["draft"];
  }
}

/** Statuses used for the automatic draft pass after a change (always drafts). */
export function getAutomaticDraftRecalcStatuses(): string[] {
  return ["draft"];
}

/** Extra statuses to recalc when admin confirms sent/pending update. */
export function getSentRecalcStatuses(): string[] {
  return ["sent", "pending", "overdue"];
}

export function shouldRecalcSentInvoices(choice: InvoiceUpdateChoice): boolean {
  return choice === "update_drafts_and_sent";
}
