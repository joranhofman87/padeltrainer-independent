import { isAfter, parseISO } from 'date-fns';

/**
 * Canonical invoice status values used across the app (trainer, academy, player).
 */
export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled';

export interface DerivableInvoice {
  status: string;
  due_date?: string | null;
}

/**
 * Derive the display status of an invoice.
 *
 * This is the single source of truth for the "sent + past-due → overdue" rule
 * that was previously copy-pasted in PlayerInvoicesTab, trainer InvoiceList and
 * AcademyInvoices. Terminal states (paid, cancelled) are never reclassified.
 */
export function deriveInvoiceStatus(
  invoice: DerivableInvoice,
  now: Date = new Date(),
): InvoiceStatus {
  const { status, due_date } = invoice;

  if (status === 'paid') return 'paid';
  if (status === 'cancelled') return 'cancelled';

  if (status === 'sent' && due_date) {
    const due = parseISO(due_date);
    if (!Number.isNaN(due.getTime()) && isAfter(now, due)) {
      return 'overdue';
    }
  }

  if (status === 'draft') return 'draft';
  if (status === 'sent') return 'sent';
  if (status === 'overdue') return 'overdue';

  return 'draft';
}
