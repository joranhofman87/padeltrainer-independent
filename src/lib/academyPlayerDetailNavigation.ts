/** Academy invoice edit — same route as AcademyInvoices and AcademySlotDetail. */
export function buildAcademyInvoiceEditPath(invoiceId: string): string {
  return `/app/academy/invoices/${encodeURIComponent(invoiceId)}/edit`;
}

/** Fallback when no per-invoice edit route is available (not used today; academy has edit pages). */
export function buildAcademyInvoicesListPath(): string {
  return '/app/academy/invoices';
}
