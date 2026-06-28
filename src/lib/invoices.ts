import { supabase } from '@/lib/supabaseClient';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

/**
 * Domain service for invoice delete/cancel writes. The "remove an invoice" rule
 * is the same everywhere — a DRAFT is hard-deleted, anything else is
 * soft-CANCELLED (status='cancelled') to preserve the financial audit trail —
 * but it was duplicated across six handlers in five files, any of which a future
 * edit could quietly get wrong and hard-delete a paid invoice. Routing every
 * remove through {@link deleteOrCancelInvoices} makes that mistake
 * UNREPRESENTABLE: the draft-vs-cancel partition is decided here from each
 * invoice's own status, never by the caller.
 */

/** The facade only needs id + status to decide delete-vs-cancel. */
export interface DeletableInvoice {
  id: string;
  status: string | null;
}

export interface DeleteOrCancelInvoicesResult {
  /** DRAFT invoices that were hard-deleted. */
  deletedIds: string[];
  /** Non-draft invoices that were soft-cancelled (status='cancelled'). */
  cancelledIds: string[];
  /** Raw error from the draft DELETE (null = nothing to delete or it succeeded). */
  deleteError: unknown | null;
  /** Raw error from the non-draft cancel UPDATE (null = nothing to cancel or it succeeded). */
  cancelError: unknown | null;
}

/**
 * Remove invoice(s): hard-delete the drafts, soft-cancel everything else.
 *
 * A `draft` invoice (never sent, no financial trail) is DELETEd; any other
 * status — sent / overdue / paid / cancelled — is UPDATEd to `status='cancelled'`
 * so the record (and its number) survives for the audit trail. A paid invoice
 * can therefore NEVER be hard-deleted through this path. The DELETE and the
 * cancel UPDATE are reported separately so callers can keep their own per-bucket
 * toasts / counts and annotate a cancel reason on `cancelledIds`. An empty list
 * is a no-op.
 */
export async function deleteOrCancelInvoices(
  invoices: DeletableInvoice[],
  client: SupabaseClient<Database> = supabase,
): Promise<DeleteOrCancelInvoicesResult> {
  const deletedIds = invoices.filter((i) => i.status === 'draft').map((i) => i.id);
  const cancelledIds = invoices.filter((i) => i.status !== 'draft').map((i) => i.id);

  let deleteError: unknown | null = null;
  let cancelError: unknown | null = null;

  if (deletedIds.length) {
    const { error } = await client.from('invoices').delete().in('id', deletedIds);
    deleteError = error ?? null;
  }
  if (cancelledIds.length) {
    const { error } = await client.from('invoices').update({ status: 'cancelled' }).in('id', cancelledIds);
    cancelError = error ?? null;
  }

  return { deletedIds, cancelledIds, deleteError, cancelError };
}
