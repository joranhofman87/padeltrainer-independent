import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';

export type InvoiceStatusEvent = {
  old_status: string | null;
  new_status: string | null;
  changed_by: string | null;
  changed_by_name: string | null;
  changed_at: string;
  reason: string | null;
};

export async function fetchInvoiceStatusHistory(invoiceId: string): Promise<InvoiceStatusEvent[]> {
  const { data, error } = await supabase.rpc('get_invoice_status_history', { p_invoice_id: invoiceId });
  if (error) throw error;
  return (data ?? []) as InvoiceStatusEvent[];
}

export function invoiceStatusHistoryQueryKey(invoiceId: string | null | undefined) {
  return ['invoice-status-history', invoiceId ?? null] as const;
}

export function useInvoiceStatusHistory(invoiceId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: invoiceStatusHistoryQueryKey(invoiceId),
    queryFn: () => fetchInvoiceStatusHistory(invoiceId!),
    enabled: enabled && Boolean(invoiceId),
    staleTime: 30 * 1000,
  });
}

/** Attach a reason to the caller's most-recent status change on this invoice (last 30s).
 *  Best-effort: failures are swallowed so the underlying status change is never blocked. */
export async function annotateInvoiceStatusReason(invoiceId: string, reason: string): Promise<void> {
  const r = reason.trim();
  if (!r) return;
  const { error } = await supabase.rpc('annotate_invoice_status_reason', { p_invoice_id: invoiceId, p_reason: r });
  if (error) throw error;
}
