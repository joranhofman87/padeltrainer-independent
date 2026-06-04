/** Maps get-public-invoice invoke results to UI error codes. */

export type PublicInvoiceLoadResult = {
  status?: string;
  error?: string;
  invoice?: unknown;
} | null;

export type PublicInvoiceErrorCode =
  | 'not_found'
  | 'unavailable'
  | 'draft_invoice'
  | 'already_paid'
  | 'cancelled';

function getFnErrorStatus(fnError: unknown): number | undefined {
  const err = fnError as { context?: { status?: number }; status?: number };
  return err?.context?.status ?? err?.status;
}

export function resolvePublicInvoiceLoadError(
  result: PublicInvoiceLoadResult,
  fnError: unknown,
): PublicInvoiceErrorCode | null {
  if (result?.status === 'paid') return 'already_paid';
  if (result?.status === 'cancelled') return 'cancelled';
  if (result?.error === 'already_paid') return 'already_paid';
  if (result?.error === 'cancelled') return 'cancelled';
  if (result?.error === 'draft_invoice') return 'draft_invoice';
  if (result?.error) return 'not_found';
  if (fnError) {
    if (getFnErrorStatus(fnError) === 401) return 'unavailable';
    return 'not_found';
  }
  return null;
}

/** True when the API returned a full unpaid invoice payload. */
export function isPublicInvoiceDetailPayload(
  result: PublicInvoiceLoadResult,
): result is { invoice: unknown } {
  return !!result && typeof result === 'object' && 'invoice' in result && result.invoice != null;
}
