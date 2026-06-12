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
  | 'cancelled'
  // Network drop or 5xx: the invoice may be fine — offer a retry, never "not found".
  | 'transient';

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
  const status = getFnErrorStatus(fnError);
  if (status === 401) return 'unavailable';
  // get-public-invoice only returns 403 for drafts; the body is unavailable on
  // non-2xx invoke errors, so map the status itself.
  if (status === 403) return 'draft_invoice';
  if (status !== undefined && status >= 500) return 'transient';
  if (result?.error) return 'not_found';
  if (fnError) {
    // Remaining 4xx is a definitive answer from the function; an error without
    // any HTTP status means the request never completed (network failure).
    return status !== undefined ? 'not_found' : 'transient';
  }
  return null;
}

/** True when the API returned a full unpaid invoice payload. */
export function isPublicInvoiceDetailPayload(
  result: PublicInvoiceLoadResult,
): result is { invoice: unknown } {
  return !!result && typeof result === 'object' && 'invoice' in result && result.invoice != null;
}
