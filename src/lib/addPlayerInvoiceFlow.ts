import type { InvoiceAfterAddPlayerResult } from "@/lib/invoiceAfterAddPlayer";

/**
 * After add-player booking success: keep UI mounted until admin resolves
 * sent/pending invoice confirmation.
 */
export function shouldDeferAddPlayerClose(
  result: Pick<InvoiceAfterAddPlayerResult, "needsConfirmation">,
): boolean {
  return result.needsConfirmation;
}

/**
 * Show destructive "invoice not created" only for real auto-create failures.
 * Deduped/skipped/incomplete-business are non-fatal.
 */
export function shouldWarnInvoiceCreateFailure(
  result: Pick<
    InvoiceAfterAddPlayerResult,
    "created" | "failed" | "invoiceCreateAttempts" | "invoiceCreateSkipped"
  >,
): boolean {
  const attempts = result.invoiceCreateAttempts;
  if (attempts <= 0) return false;
  if (result.failed > 0) return true;
  if (result.created > 0) return false;
  if (result.invoiceCreateSkipped >= attempts) return false;
  return true;
}
