import { supabase } from '@/lib/supabaseClient';
import { formatInvoiceNumber } from '@/lib/invoiceNumber';

/**
 * Renumber all draft invoices for an academy or trainer using the current numbering settings.
 * Paid/sent invoices are never touched.
 *
 * Returns the count of updated invoices, or -1 on error.
 */
export async function renumberDraftInvoices(opts: {
  /** 'academy' or 'trainer' */
  ownerType: 'academy' | 'trainer';
  /** academy_profile_id or trainer_profile.id */
  ownerId: string;
  prefix: string;
  includeYear: boolean;
  startNumber: number;
}): Promise<{ updated: number; nextNumber: number; error?: string }> {
  const { ownerType, ownerId, prefix, includeYear, startNumber } = opts;

  // Fetch all draft invoices ordered by invoice_date, then created_at
  const filterCol = ownerType === 'academy' ? 'academy_profile_id' : 'trainer_id';

  const { data: drafts, error: fetchError } = await supabase
    .from('invoices')
    .select('id, invoice_number')
    .eq(filterCol, ownerId)
    .eq('status', 'draft')
    .order('invoice_date', { ascending: true })
    .order('created_at', { ascending: true });

  if (fetchError) {
    return { updated: 0, nextNumber: startNumber, error: fetchError.message };
  }

  if (!drafts || drafts.length === 0) {
    return { updated: 0, nextNumber: startNumber };
  }

  const year = new Date().getFullYear();
  let seq = startNumber;
  let updatedCount = 0;

  for (const draft of drafts) {
    const newNumber = formatInvoiceNumber(prefix, year, seq, includeYear);

    if (draft.invoice_number !== newNumber) {
      const { error: updateError } = await supabase
        .from('invoices')
        .update({ invoice_number: newNumber, pdf_url: null } as any)
        .eq('id', draft.id);

      if (!updateError) {
        updatedCount++;
      }
    }
    seq++;
  }

  return { updated: updatedCount, nextNumber: seq };
}
