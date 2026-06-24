/**
 * Client for the server-paginated invoice lists (get_{academy,trainer}_invoices
 * + _summary RPCs) — P-RD-001. The pages used to fetch the WHOLE invoice set with
 * an unbounded `.select()` and sum `totalUnpaid` client-side, silently truncating
 * at PostgREST's 1000-row cap (oldest unpaid invoices dropped → understated
 * receivables). These helpers page the list server-side and read the exact
 * receivables scoreboard from a dedicated summary RPC that is always one row, so
 * the tiles render even when the visible tab/page is empty.
 */
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import type { Database } from '@/integrations/supabase/types';

export type AcademyInvoiceRow =
  Database['public']['Functions']['get_academy_invoices']['Returns'][number];
export type TrainerInvoiceRow =
  Database['public']['Functions']['get_trainer_invoices']['Returns'][number];

export interface InvoiceSummary {
  sumUnpaid: number;
  countUnpaid: number;
  countPaid: number;
  countDraft: number;
}

export interface AcademyInvoiceParams {
  tab?: 'unpaid' | 'paid';
  status?: string | null;
  search?: string | null;
  trainerId?: string | null;
  locationId?: string | null;
  noEmail?: boolean;
  delivery?: string | null; // 'undelivered' | 'bounced' | 'no_email' | 'delivered'
  sort?: string;
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface TrainerInvoiceParams {
  tab?: 'unpaid' | 'paid';
  status?: string | null;
  search?: string | null;
  delivery?: string | null; // 'undelivered' | 'bounced' | 'no_email' | 'delivered'
  sort?: string;
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export const INVOICE_PAGE_SIZE = 50;

/** Total page count for the server-paginated invoice lists (min 1, even when empty). */
export function invoiceListPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / INVOICE_PAGE_SIZE));
}

const SERVER_MAX_PAGE = 500; // get_*_invoices clamp p_limit at 500
const FETCH_ALL_MAX_ROWS = 20_000;
const FETCH_ALL_CONCURRENCY = 5;

const emptySummary: InvoiceSummary = { sumUnpaid: 0, countUnpaid: 0, countPaid: 0, countDraft: 0 };

// ---------------------------------------------------------------------------
// Academy
// ---------------------------------------------------------------------------
export async function fetchAcademyInvoices(
  academyId: string,
  params: AcademyInvoiceParams = {},
): Promise<{ rows: AcademyInvoiceRow[]; total: number }> {
  const pageSize = params.pageSize ?? INVOICE_PAGE_SIZE;
  const page = params.page ?? 0;
  const { data, error } = await supabase.rpc('get_academy_invoices', {
    p_academy_profile_id: academyId,
    p_tab: params.tab ?? 'unpaid',
    p_status: params.status ?? undefined,
    p_search: params.search?.trim() || undefined,
    p_trainer_id: params.trainerId ?? undefined,
    p_location_id: params.locationId ?? undefined,
    p_no_email: params.noEmail ?? false,
    p_delivery: params.delivery ?? undefined,
    p_sort: params.sort ?? 'created_at',
    p_sort_dir: params.sortDir ?? 'desc',
    p_limit: pageSize,
    p_offset: page * pageSize,
  });
  if (error) throw error;
  const rows = (data ?? []) as AcademyInvoiceRow[];
  return { rows, total: Number(rows[0]?.total_count ?? 0) };
}

function mapSummaryRow(data: unknown): InvoiceSummary {
  const r = (data as Record<string, unknown>[] | null ?? [])[0];
  return r
    ? {
        sumUnpaid: Number(r.sum_unpaid ?? 0),
        countUnpaid: Number(r.count_unpaid ?? 0),
        countPaid: Number(r.count_paid ?? 0),
        countDraft: Number(r.count_draft ?? 0),
      }
    : emptySummary;
}

// Cross-status tab-label totals: trainer + location only. Uses the original
// (stable, always-deployed) function so the tab counts never depend on the
// filtered-cards migration being applied.
export async function fetchAcademyInvoiceSummary(
  academyId: string,
  opts: { trainerId?: string | null; locationId?: string | null } = {},
): Promise<InvoiceSummary> {
  const { data, error } = await supabase.rpc('get_academy_invoice_summary', {
    p_academy_profile_id: academyId,
    p_trainer_id: opts.trainerId ?? undefined,
    p_location_id: opts.locationId ?? undefined,
  });
  if (error) throw error;
  return mapSummaryRow(data);
}

// Scoreboard cards: mirrors the table filters. Targets the additive
// get_academy_invoice_summary_filtered function — throws (PGRST202) until that
// migration is applied to prod, which the caller catches and falls back from.
export async function fetchAcademyInvoiceSummaryFiltered(
  academyId: string,
  opts: {
    trainerId?: string | null;
    locationId?: string | null;
    status?: string | null;
    search?: string | null;
    noEmail?: boolean;
    delivery?: string | null;
  } = {},
): Promise<InvoiceSummary> {
  // Optional filter params have DB defaults → drop-undefined is the intended
  // optional-filter pattern (unlike the required-param get_player_locations bug).
  const { data, error } = await supabase.rpc('get_academy_invoice_summary_filtered', {
    p_academy_profile_id: academyId,
    p_trainer_id: opts.trainerId ?? undefined,
    p_location_id: opts.locationId ?? undefined,
    p_status: opts.status ?? undefined,
    p_search: opts.search?.trim() || undefined,
    p_no_email: opts.noEmail ?? undefined,
    p_delivery: opts.delivery ?? undefined,
  });
  if (error) throw error;
  return mapSummaryRow(data);
}

// Count of cancelled invoices (trainer/location-scoped) — drives the Geannuleerd
// tab label. Additive function; throws (PGRST202) until its migration is applied.
export async function fetchAcademyInvoiceCancelledCount(
  academyId: string,
  opts: { trainerId?: string | null; locationId?: string | null } = {},
): Promise<number> {
  const { data, error } = await supabase.rpc('get_academy_invoice_cancelled_count', {
    p_academy_profile_id: academyId,
    p_trainer_id: opts.trainerId ?? undefined,
    p_location_id: opts.locationId ?? undefined,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

/**
 * Every matching academy invoice, by paging the RPC at the server max page size.
 * Used by bulk paths (e.g. "send all drafts") whose reach must NOT shrink to the
 * current page. Deterministic server order; deduped by id; hard safety cap.
 */
export async function fetchAllAcademyInvoices(
  academyId: string,
  params: Omit<AcademyInvoiceParams, 'page' | 'pageSize'> = {},
): Promise<AcademyInvoiceRow[]> {
  const first = await fetchAcademyInvoices(academyId, { ...params, page: 0, pageSize: SERVER_MAX_PAGE });
  return pageThrough(first, (page, size) => fetchAcademyInvoices(academyId, { ...params, page, pageSize: size }));
}

// ---------------------------------------------------------------------------
// Trainer (standalone invoices: academy_profile_id IS NULL)
// ---------------------------------------------------------------------------
export async function fetchTrainerInvoices(
  trainerId: string,
  params: TrainerInvoiceParams = {},
): Promise<{ rows: TrainerInvoiceRow[]; total: number }> {
  const pageSize = params.pageSize ?? INVOICE_PAGE_SIZE;
  const page = params.page ?? 0;
  const { data, error } = await supabase.rpc('get_trainer_invoices', {
    p_trainer_id: trainerId,
    p_tab: params.tab ?? 'unpaid',
    p_status: params.status ?? undefined,
    p_search: params.search?.trim() || undefined,
    p_delivery: params.delivery ?? undefined,
    p_sort: params.sort ?? 'created_at',
    p_sort_dir: params.sortDir ?? 'desc',
    p_limit: pageSize,
    p_offset: page * pageSize,
  });
  if (error) throw error;
  const rows = (data ?? []) as TrainerInvoiceRow[];
  return { rows, total: Number(rows[0]?.total_count ?? 0) };
}

export async function fetchTrainerInvoiceSummary(trainerId: string): Promise<InvoiceSummary> {
  const { data, error } = await supabase.rpc('get_trainer_invoice_summary', { p_trainer_id: trainerId });
  if (error) throw error;
  const r = (data ?? [])[0];
  return r
    ? {
        sumUnpaid: Number(r.sum_unpaid ?? 0),
        countUnpaid: Number(r.count_unpaid ?? 0),
        countPaid: Number(r.count_paid ?? 0),
        countDraft: Number(r.count_draft ?? 0),
      }
    : emptySummary;
}

export async function fetchAllTrainerInvoices(
  trainerId: string,
  params: Omit<TrainerInvoiceParams, 'page' | 'pageSize'> = {},
): Promise<TrainerInvoiceRow[]> {
  const first = await fetchTrainerInvoices(trainerId, { ...params, page: 0, pageSize: SERVER_MAX_PAGE });
  return pageThrough(first, (page, size) => fetchTrainerInvoices(trainerId, { ...params, page, pageSize: size }));
}

// ---------------------------------------------------------------------------
// shared paging-to-completion (mirrors fetchAllPlayersOverview)
// ---------------------------------------------------------------------------
async function pageThrough<T extends { id: string }>(
  first: { rows: T[]; total: number },
  fetchPage: (page: number, size: number) => Promise<{ rows: T[]; total: number }>,
): Promise<T[]> {
  if (first.total > FETCH_ALL_MAX_ROWS) {
    throw new Error('fetchAll invoices: exceeded safety cap (20k rows)');
  }
  if (first.rows.length === 0 || first.rows.length >= first.total) return first.rows;
  const effectiveSize = first.rows.length;
  const pageCount = Math.ceil(first.total / effectiveSize);
  const pages: T[][] = [first.rows];
  for (let batchStart = 1; batchStart < pageCount; batchStart += FETCH_ALL_CONCURRENCY) {
    const batchEnd = Math.min(batchStart + FETCH_ALL_CONCURRENCY, pageCount);
    const batch: Promise<void>[] = [];
    for (let page = batchStart; page < batchEnd; page++) {
      batch.push(fetchPage(page, effectiveSize).then(({ rows }) => { pages[page] = rows; }));
    }
    await Promise.all(batch);
  }
  const seen = new Set<string>();
  const all: T[] = [];
  for (const rows of pages) {
    for (const row of rows ?? []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      all.push(row);
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// hooks — keys prefixed with the page's invalidation root so the existing
// invalidateQueries(['academy-invoices' | 'trainer-invoices']) refreshes both
// the list AND the scoreboard tiles after a send/mark-paid/delete mutation.
// ---------------------------------------------------------------------------
export function useAcademyInvoices(academyId: string | null | undefined, params: AcademyInvoiceParams) {
  return useQuery({
    queryKey: ['academy-invoices', 'list', academyId, params],
    queryFn: () => fetchAcademyInvoices(academyId!, params),
    enabled: Boolean(academyId),
    placeholderData: keepPreviousData,
  });
}

// Tab-label totals (trainer + location only).
export function useAcademyInvoiceSummary(
  academyId: string | null | undefined,
  opts: { trainerId?: string | null; locationId?: string | null },
) {
  return useQuery({
    queryKey: ['academy-invoices', 'summary', academyId, opts.trainerId ?? null, opts.locationId ?? null],
    queryFn: () => fetchAcademyInvoiceSummary(academyId!, opts),
    enabled: Boolean(academyId),
    placeholderData: keepPreviousData,
  });
}

// Scoreboard cards — follows every active filter (status/search/delivery + trainer/location).
export function useAcademyInvoiceSummaryFiltered(
  academyId: string | null | undefined,
  opts: {
    trainerId?: string | null;
    locationId?: string | null;
    status?: string | null;
    search?: string | null;
    noEmail?: boolean;
    delivery?: string | null;
  },
) {
  return useQuery({
    queryKey: [
      'academy-invoices', 'summary-filtered', academyId,
      opts.trainerId ?? null, opts.locationId ?? null,
      opts.status ?? null, opts.search ?? null, opts.noEmail ?? null, opts.delivery ?? null,
    ],
    queryFn: () => fetchAcademyInvoiceSummaryFiltered(academyId!, opts),
    enabled: Boolean(academyId),
    placeholderData: keepPreviousData,
    retry: false, // pre-migration this 404s; don't spam retries before the fallback kicks in
  });
}

// Cancelled-invoice count for the Geannuleerd tab label.
export function useAcademyInvoiceCancelledCount(
  academyId: string | null | undefined,
  opts: { trainerId?: string | null; locationId?: string | null },
) {
  return useQuery({
    queryKey: ['academy-invoices', 'cancelled-count', academyId, opts.trainerId ?? null, opts.locationId ?? null],
    queryFn: () => fetchAcademyInvoiceCancelledCount(academyId!, opts),
    enabled: Boolean(academyId),
    placeholderData: keepPreviousData,
    retry: false, // additive fn; 404s until its migration is applied
  });
}

export interface InvoiceDeliverySummary {
  total: number;
  noEmail: number;
  bounced: number;
  delivered: number;
  pending: number;
}

export async function fetchAcademyInvoiceDeliverySummary(
  academyId: string,
  opts: { tab?: 'unpaid' | 'paid'; trainerId?: string | null; locationId?: string | null } = {},
): Promise<InvoiceDeliverySummary> {
  const { data, error } = await supabase.rpc('get_academy_invoice_delivery_summary', {
    p_academy_profile_id: academyId,
    p_tab: opts.tab ?? 'unpaid',
    p_trainer_id: opts.trainerId ?? undefined,
    p_location_id: opts.locationId ?? undefined,
  });
  if (error) throw error;
  const r = (data ?? [])[0];
  return {
    total: Number(r?.total ?? 0),
    noEmail: Number(r?.no_email ?? 0),
    bounced: Number(r?.bounced ?? 0),
    delivered: Number(r?.delivered ?? 0),
    pending: Number(r?.pending ?? 0),
  };
}

export function useAcademyInvoiceDeliverySummary(
  academyId: string | null | undefined,
  opts: { tab?: 'unpaid' | 'paid'; trainerId?: string | null; locationId?: string | null },
) {
  return useQuery({
    queryKey: ['academy-invoices', 'delivery-summary', academyId, opts.tab ?? 'unpaid', opts.trainerId ?? null, opts.locationId ?? null],
    queryFn: () => fetchAcademyInvoiceDeliverySummary(academyId!, opts),
    enabled: Boolean(academyId),
    placeholderData: keepPreviousData,
  });
}

export function useTrainerInvoices(trainerId: string | null | undefined, params: TrainerInvoiceParams) {
  return useQuery({
    queryKey: ['trainer-invoices', 'list', trainerId, params],
    queryFn: () => fetchTrainerInvoices(trainerId!, params),
    enabled: Boolean(trainerId),
    placeholderData: keepPreviousData,
  });
}

export function useTrainerInvoiceSummary(trainerId: string | null | undefined) {
  return useQuery({
    queryKey: ['trainer-invoices', 'summary', trainerId],
    queryFn: () => fetchTrainerInvoiceSummary(trainerId!),
    enabled: Boolean(trainerId),
    placeholderData: keepPreviousData,
  });
}

export async function fetchTrainerInvoiceDeliverySummary(
  trainerId: string,
  opts: { tab?: 'unpaid' | 'paid' } = {},
): Promise<InvoiceDeliverySummary> {
  const { data, error } = await supabase.rpc('get_trainer_invoice_delivery_summary', {
    p_trainer_id: trainerId,
    p_tab: opts.tab ?? 'unpaid',
  });
  if (error) throw error;
  const r = (data ?? [])[0];
  return {
    total: Number(r?.total ?? 0),
    noEmail: Number(r?.no_email ?? 0),
    bounced: Number(r?.bounced ?? 0),
    delivered: Number(r?.delivered ?? 0),
    pending: Number(r?.pending ?? 0),
  };
}

export function useTrainerInvoiceDeliverySummary(
  trainerId: string | null | undefined,
  opts: { tab?: 'unpaid' | 'paid' },
) {
  return useQuery({
    queryKey: ['trainer-invoices', 'delivery-summary', trainerId, opts.tab ?? 'unpaid'],
    queryFn: () => fetchTrainerInvoiceDeliverySummary(trainerId!, opts),
    enabled: Boolean(trainerId),
    placeholderData: keepPreviousData,
  });
}
