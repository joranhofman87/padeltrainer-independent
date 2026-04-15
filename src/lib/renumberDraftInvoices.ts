import { supabase } from '@/lib/supabaseClient';
import { formatInvoiceNumber } from '@/lib/invoiceNumber';

export type RenumberStatus = 'draft' | 'sent' | 'overdue';

/**
 * Renumber invoices for an academy or trainer using the current numbering settings.
 * Only the selected statuses are touched. "overdue" = sent invoices past due_date.
 * Paid invoices are never touched.
 */
export async function renumberInvoices(opts: {
  ownerType: 'academy' | 'trainer';
  ownerId: string;
  prefix: string;
  includeYear: boolean;
  startNumber: number;
  statuses: RenumberStatus[];
}): Promise<{ updated: number; nextNumber: number; error?: string }> {
  const { ownerType, ownerId, prefix, includeYear, startNumber, statuses } = opts;

  const filterCol = ownerType === 'academy' ? 'academy_profile_id' : 'trainer_id';
  const today = new Date().toISOString().slice(0, 10);

  // Build query for the selected statuses
  const dbStatuses: string[] = [];
  if (statuses.includes('draft')) dbStatuses.push('draft');
  if (statuses.includes('sent') || statuses.includes('overdue')) dbStatuses.push('sent');

  if (dbStatuses.length === 0) {
    return { updated: 0, nextNumber: startNumber };
  }

  const { data: invoices, error: fetchError } = await supabase
    .from('invoices')
    .select('id, invoice_number, status, due_date')
    .eq(filterCol, ownerId)
    .in('status', dbStatuses)
    .order('invoice_date', { ascending: true })
    .order('created_at', { ascending: true });

  if (fetchError) {
    return { updated: 0, nextNumber: startNumber, error: fetchError.message };
  }

  if (!invoices || invoices.length === 0) {
    return { updated: 0, nextNumber: startNumber };
  }

  // Filter based on selected statuses
  const wantDraft = statuses.includes('draft');
  const wantSent = statuses.includes('sent');
  const wantOverdue = statuses.includes('overdue');

  const filtered = invoices.filter((inv) => {
    if (inv.status === 'draft') return wantDraft;
    if (inv.status === 'sent') {
      const isOverdue = inv.due_date && inv.due_date < today;
      if (isOverdue) return wantOverdue;
      return wantSent;
    }
    return false;
  });

  if (filtered.length === 0) {
    return { updated: 0, nextNumber: startNumber };
  }

  const year = new Date().getFullYear();
  let seq = startNumber;
  let updatedCount = 0;

  for (const inv of filtered) {
    const newNumber = formatInvoiceNumber(prefix, year, seq, includeYear);

    if (inv.invoice_number !== newNumber) {
      const { error: updateError } = await supabase
        .from('invoices')
        .update({ invoice_number: newNumber, pdf_url: null } as any)
        .eq('id', inv.id);

      if (!updateError) {
        updatedCount++;
      }
    }
    seq++;
  }

  return { updated: updatedCount, nextNumber: seq };
}
