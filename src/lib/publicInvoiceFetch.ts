/** Maps get-public-invoice invoke results to UI error codes. */
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
  result: { error?: string; invoice?: unknown } | null,
  fnError: unknown,
): PublicInvoiceErrorCode | null {
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
