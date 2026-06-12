import { supabase } from '@/lib/supabaseClient';

/**
 * Build an invoice number from prefix, year, and sequence.
 * Supports flexible formatting:
 *
 *   formatInvoiceNumber('INV', 2026, 153)           → "INV-2026-0153"
 *   formatInvoiceNumber('INV', 2026, 153, false)     → "INV-0153"
 *   formatInvoiceNumber('',    2026, 153)            → "2026-0153"
 *   formatInvoiceNumber('',    2026, 153, false)     → "0153"
 *   formatInvoiceNumber(null,  2026, 10001, false)   → "10001"
 */
export function formatInvoiceNumber(
  prefix: string | null | undefined,
  year: number,
  sequence: number,
  includeYear = true,
): string {
  const seq = String(sequence).padStart(4, '0');
  const trimmed = (prefix ?? '').trim();
  const parts: string[] = [];
  if (trimmed) parts.push(trimmed);
  if (includeYear) parts.push(String(year));
  parts.push(seq);
  return parts.join('-');
}

/** Build the LIKE pattern matching numbers in the current prefix/year scheme. */
export function invoiceNumberLikePattern(
  prefix: string | null | undefined,
  year: number,
  includeYear = true,
): string {
  const trimmed = (prefix ?? '').trim();
  if (trimmed) return includeYear ? `${trimmed}-${year}-%` : `${trimmed}-%`;
  return includeYear ? `${year}-%` : '%';
}

/** Parse the trailing sequence out of an invoice number ("INV-2026-0153" → 153). */
export function parseInvoiceSequence(invoiceNumber: string): number | null {
  const parts = invoiceNumber.split('-');
  const seq = parseInt(parts[parts.length - 1] || '', 10);
  return Number.isFinite(seq) ? seq : null;
}

export type InvoiceNumberAllocation = { sequence: number; invoiceNumber: string };

/**
 * Atomically allocate the next invoice number for a trainer or academy profile
 * via the next_invoice_sequence RPC (M-10). Replaces the old client-side
 * read-increment-write, which could mint the same legal invoice number twice
 * under concurrency. The DB GREATESTs the stored counter against `minSequence`
 * (max existing number + 1) so legacy numbers ahead of the counter are skipped.
 */
export async function allocateInvoiceNumber(opts: {
  profileType: 'trainer' | 'academy';
  profileId: string;
  prefix: string | null | undefined;
  includeYear?: boolean;
}): Promise<InvoiceNumberAllocation> {
  const includeYear = opts.includeYear ?? true;
  const year = new Date().getFullYear();
  const pattern = invoiceNumberLikePattern(opts.prefix, year, includeYear);

  const scanColumn = opts.profileType === 'academy' ? 'academy_profile_id' : 'trainer_id';
  const { data: lastInvoice } = await supabase
    .from('invoices')
    .select('invoice_number')
    .eq(scanColumn, opts.profileId)
    .like('invoice_number', pattern)
    .order('invoice_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  let minSequence = 1;
  if (lastInvoice?.invoice_number) {
    const lastSeq = parseInvoiceSequence(lastInvoice.invoice_number);
    if (lastSeq != null) minSequence = lastSeq + 1;
  }

  const { data, error } = await supabase.rpc('next_invoice_sequence' as never, {
    p_profile_type: opts.profileType,
    p_profile_id: opts.profileId,
    p_min: minSequence,
  } as never);
  if (error) throw error;
  const sequence = data as unknown as number;
  if (typeof sequence !== 'number') {
    throw new Error('next_invoice_sequence returned no sequence');
  }
  return { sequence, invoiceNumber: formatInvoiceNumber(opts.prefix, year, sequence, includeYear) };
}

/** True when an insert failed because the allocated number collided (retryable). */
export function isInvoiceNumberCollision(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; message?: string; details?: string };
  if (e.code !== '23505') return false;
  const text = `${e.message ?? ''} ${e.details ?? ''}`;
  return /unique_invoice_number_per_(trainer|academy)/.test(text);
}
