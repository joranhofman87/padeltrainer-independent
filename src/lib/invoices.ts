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

/**
 * The statuses a generic "delete" may soft-cancel. An allow-list, not `!== 'draft'`: a destructive
 * bulk action must refuse what it does not recognise rather than assume it is safe to cancel.
 */
const CANCELLABLE_STATUSES = new Set(['sent', 'overdue', 'cancelled']);

export interface DeleteOrCancelInvoicesResult {
  /** DRAFT invoices that were hard-deleted. */
  deletedIds: string[];
  /** Non-draft invoices that were soft-cancelled (status='cancelled'). */
  cancelledIds: string[];
  /**
   * Invoices this path REFUSED to touch — paid ones, and any status it does not recognise.
   * Never empty silently: the caller must tell the user which rows were left alone and why,
   * or a bulk action reports success for work it deliberately did not do.
   */
  refusedIds: string[];
  /** Raw error from the draft DELETE (null = nothing to delete or it succeeded). */
  deleteError: unknown | null;
  /** Raw error from the non-draft cancel UPDATE (null = nothing to cancel or it succeeded). */
  cancelError: unknown | null;
}

/**
 * Remove invoice(s): hard-delete the drafts, soft-cancel the unpaid ones, REFUSE the paid ones.
 *
 * A `draft` invoice (never sent, no financial trail) is DELETEd. `sent`, `overdue` and an already
 * `cancelled` one are UPDATEd to `status='cancelled'` so the record and its number survive for the
 * audit trail.
 *
 * A **paid** invoice is neither, and that is the point (A1-A7 F6). This function used to fold every
 * non-draft status into `cancelled`, so an ordinary bulk "delete" in a list view could make a
 * genuinely paid invoice read as cancelled — money received, provider evidence intact, and the
 * financial record now saying the opposite. Cancelling is not a refund; the two must not be reachable
 * by the same click. Paid ids come back as `refusedIds` for the caller to report, and the correction
 * for a paid invoice is an explicit, audited refund/credit flow reconciled against the provider.
 *
 * The bucket rule is an ALLOW-LIST, deliberately. For a destructive action the safe default is to
 * refuse what it does not recognise: a status added later (a partial payment, a refund in progress)
 * must not inherit "cancellable" by being merely non-draft.
 *
 * The DELETE and the cancel UPDATE are reported separately so callers can keep their own per-bucket
 * toasts / counts and annotate a cancel reason on `cancelledIds`. An empty list is a no-op.
 */
export async function deleteOrCancelInvoices(
  invoices: DeletableInvoice[],
  client: SupabaseClient<Database> = supabase,
): Promise<DeleteOrCancelInvoicesResult> {
  const deletedIds = invoices.filter((i) => i.status === 'draft').map((i) => i.id);
  const cancelledIds = invoices
    .filter((i) => CANCELLABLE_STATUSES.has(i.status ?? ''))
    .map((i) => i.id);
  // everything else — paid today, and anything financial added later
  const refusedIds = invoices
    .filter((i) => i.status !== 'draft' && !CANCELLABLE_STATUSES.has(i.status ?? ''))
    .map((i) => i.id);

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

  return { deletedIds, cancelledIds, refusedIds, deleteError, cancelError };
}

/**
 * Mark invoice(s) as sent: stamp `sent_at = now` + `status = 'sent'`.
 *
 * This is the STATUS write only — it deliberately does NOT send the email. The
 * caller owns the actual delivery (the `send-invoice-email` invoke) and calls
 * this ONLY after a confirmed success, because a failed or address-less send
 * must never record the invoice as issued. The same `{ sent_at, status }` write
 * was duplicated across seven send/mark-as-sent handlers in the two list pages;
 * routing them here keeps that one transition in a single place. Accepts one or
 * many ids (single send passes `[id]`). An empty list is a no-op.
 */
export async function markInvoicesSent(
  ids: string[],
  client: SupabaseClient<Database> = supabase,
): Promise<{ error: unknown | null }> {
  if (!ids.length) return { error: null };
  const { error } = await client
    .from('invoices')
    .update({ sent_at: new Date().toISOString(), status: 'sent' })
    .in('id', ids);
  return { error: error ?? null };
}

export interface RevertInvoicesToDraftResult {
  /** Non-paid invoices reset to draft (`sent_at` + `paid_at` cleared). */
  revertedIds: string[];
  /** PAID invoices skipped — resetting them was refused (see below). */
  skippedPaidIds: string[];
  /** Raw error from the reset UPDATE (null = nothing to reset or it succeeded). */
  error: unknown | null;
}

/**
 * Revert invoice(s) to draft (clears `sent_at` + `paid_at`) — but NEVER a PAID
 * invoice.
 *
 * Resetting a paid invoice would erase `paid_at`, the only local record that
 * money was received (it then survives solely at Mollie), and re-sending it
 * renumbers + emails a dead pay link. Paid rows are therefore filtered out here
 * (returned as {@link RevertInvoicesToDraftResult.skippedPaidIds}) AND a
 * `.neq('status','paid')` guard backs the UPDATE at the DB layer, so "reset a
 * paid invoice to draft" is UNREPRESENTABLE through this path — mirroring the
 * draft-vs-cancel invariant in {@link deleteOrCancelInvoices}. An all-paid /
 * empty list does no write and returns `revertedIds: []`.
 */
export async function revertInvoicesToDraft(
  invoices: DeletableInvoice[],
  client: SupabaseClient<Database> = supabase,
): Promise<RevertInvoicesToDraftResult> {
  const revertedIds = invoices.filter((i) => i.status !== 'paid').map((i) => i.id);
  const skippedPaidIds = invoices.filter((i) => i.status === 'paid').map((i) => i.id);
  if (!revertedIds.length) return { revertedIds, skippedPaidIds, error: null };
  const { error } = await client
    .from('invoices')
    .update({ status: 'draft', sent_at: null, paid_at: null })
    .in('id', revertedIds)
    .neq('status', 'paid');
  return { revertedIds, skippedPaidIds, error: error ?? null };
}

/** Set the due date (`YYYY-MM-DD`) on invoice(s). An empty list is a no-op. */
export async function setInvoicesDueDate(
  ids: string[],
  dueDate: string,
  client: SupabaseClient<Database> = supabase,
): Promise<{ error: unknown | null }> {
  if (!ids.length) return { error: null };
  const { error } = await client.from('invoices').update({ due_date: dueDate }).in('id', ids);
  return { error: error ?? null };
}
