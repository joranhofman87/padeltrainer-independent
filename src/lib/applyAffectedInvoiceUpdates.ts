import { syncInvoicesAfterPriceChange } from "@/lib/invoiceSync";
import {
  fetchAffectedInvoicesBySlotIds,
  buildAffectedInvoicesSummary,
  type AffectedInvoicesClassification,
} from "@/lib/affectedInvoices";
import {
  getAutomaticDraftRecalcStatuses,
  getRecalcStatusesForChoice,
  shouldRecalcSentInvoices,
  type InvoiceUpdateChoice,
} from "@/lib/invoiceUpdateChoice";
import { logger } from "@/lib/logger";

export type ApplyAffectedInvoiceUpdatesResult = {
  classification: AffectedInvoicesClassification;
  draftsRecalculated: boolean;
  sentRecalculated: boolean;
  needsConfirmation: boolean;
  paidUnchangedCount: number;
};

/**
 * Recalculate affected invoices after a slot/cyclus change.
 * Phase 1: always recalc drafts. Sent/pending only when choice allows.
 */
export async function applyAffectedInvoiceUpdates(
  slotIds: string[],
  choice: InvoiceUpdateChoice = "update_drafts_only",
): Promise<ApplyAffectedInvoiceUpdatesResult> {
  const classification = await fetchAffectedInvoicesBySlotIds(slotIds);
  const summary = buildAffectedInvoicesSummary(classification);

  let draftsRecalculated = false;
  let sentRecalculated = false;

  if (choice !== "skip" && slotIds.length > 0) {
    try {
      await syncInvoicesAfterPriceChange(slotIds, {
        statuses: getAutomaticDraftRecalcStatuses(),
      });
      draftsRecalculated = classification.draftInvoiceIds.length > 0;
    } catch (err) {
      logger.warn("Draft invoice recalc failed", {
        component: "applyAffectedInvoiceUpdates",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (shouldRecalcSentInvoices(choice)) {
      try {
        await syncInvoicesAfterPriceChange(slotIds, {
          statuses: getRecalcStatusesForChoice("update_drafts_and_sent").filter(
            (s) => s !== "draft",
          ),
        });
        sentRecalculated = classification.sentOrPendingInvoiceIds.length > 0;
      } catch (err) {
        logger.warn("Sent/pending invoice recalc failed", {
          component: "applyAffectedInvoiceUpdates",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    classification,
    draftsRecalculated,
    sentRecalculated,
    needsConfirmation: summary.requiresConfirmation && !shouldRecalcSentInvoices(choice),
    paidUnchangedCount: summary.paidCount,
  };
}
