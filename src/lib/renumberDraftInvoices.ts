import { supabase } from '@/lib/supabaseClient';
import { allocateInvoiceNumber, isInvoiceNumberCollision } from '@/lib/invoiceNumber';

export interface RenumberFailure {
  invoiceId: string;
  /** The number the draft had before the failed renumber attempt. */
  invoiceNumber: string | null;
  message: string;
}

export interface RenumberResult {
  updated: number;
  failures: RenumberFailure[];
  /**
   * Counter value after the last allocation (last sequence + 1), for mirroring
   * into settings forms. Null when no numbers were allocated. The DB counter
   * itself is already advanced by the RPC — do NOT write it back manually.
   */
  nextNumber: number | null;
  /** Set when the initial draft fetch failed; no rows were touched. */
  error?: string;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

/**
 * Renumber DRAFT invoices for an academy or trainer using the current
 * numbering settings (M-23). Sent/paid/cancelled invoices are issued legal
 * documents and are never touched.
 *
 * Every draft gets a fresh number from the atomic next_invoice_sequence
 * counter via allocateInvoiceNumber, which floors at (max existing number in
 * the prefix/year scheme + 1) — so a renumbered draft can never collide with
 * ANY invoice in the same numbering scope (trainer or academy), including
 * paid and cancelled ones. A consequence: drafts can only be renumbered
 * forward, never onto numbers below an existing invoice in the same scheme.
 *
 * Per-row failures are collected and returned instead of being swallowed.
 * The RPC is the single source of truth for the counter; callers must not
 * persist invoice_next_number themselves after a renumber.
 */
export async function renumberDraftInvoices(opts: {
  ownerType: 'academy' | 'trainer';
  /** trainer_profiles.id or academy_profiles.id — the invoice numbering scope. */
  ownerId: string;
  prefix: string;
  includeYear: boolean;
}): Promise<RenumberResult> {
  const { ownerType, ownerId, prefix, includeYear } = opts;
  const filterCol = ownerType === 'academy' ? 'academy_profile_id' : 'trainer_id';

  const { data: drafts, error: fetchError } = await supabase
    .from('invoices')
    .select('id, invoice_number')
    .eq(filterCol, ownerId)
    .eq('status', 'draft')
    .order('invoice_date', { ascending: true })
    .order('created_at', { ascending: true });

  if (fetchError) {
    return { updated: 0, failures: [], nextNumber: null, error: fetchError.message };
  }
  if (!drafts || drafts.length === 0) {
    return { updated: 0, failures: [], nextNumber: null };
  }

  let updated = 0;
  let nextNumber: number | null = null;
  const failures: RenumberFailure[] = [];

  for (const draft of drafts) {
    try {
      // Same pattern as the create-invoice paths: on the rare collision with
      // a concurrent creator (or the cross-scope trainer/academy constraint),
      // allocate a fresh number and retry.
      for (let attempt = 0; ; attempt++) {
        const allocation = await allocateInvoiceNumber({
          profileType: ownerType,
          profileId: ownerId,
          prefix,
          includeYear,
        });
        nextNumber = allocation.sequence + 1;

        // pdf_url + render_path both null: the number IS the storage key, so the old renders no
        // longer belong to this invoice. Regeneration stamps the new path; the orphaned old
        // objects are unmatched by any render_path and the storage GC reaps them after the grace
        // period (Theme B) — a client-side caller cannot storage.remove them itself (RLS).
        const { error: updateError } = await supabase
          .from('invoices')
          .update({ invoice_number: allocation.invoiceNumber, pdf_url: null, render_path: null })
          .eq('id', draft.id);

        if (!updateError) {
          updated++;
          break;
        }
        if (!isInvoiceNumberCollision(updateError) || attempt >= 2) throw updateError;
      }
    } catch (err) {
      failures.push({
        invoiceId: draft.id,
        invoiceNumber: draft.invoice_number ?? null,
        message: errorMessage(err),
      });
    }
  }

  return { updated, failures, nextNumber };
}
