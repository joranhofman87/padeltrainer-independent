/** Trainer invoice edit — same route as TrainerInvoices and TrainerSlotDetail. */
export function buildTrainerInvoiceEditPath(invoiceId: string): string {
  return `/app/trainer/invoices/${encodeURIComponent(invoiceId)}/edit`;
}
