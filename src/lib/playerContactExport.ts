/**
 * Academy Players contact export (PTF option A, E1): EVERY person matching the list's search + filters
 * as a local Excel-compatible CSV of name / email / phone. The PTF-specific parts live here — the
 * academy-scoped server call and its response contract, the frozen list inputs and the contact column
 * spec; the file mechanics (formatting, formula safety, download, failure vocabulary) are the shared
 * @/lib/csvExport.
 *
 * ONE call to get_players_overview_export. The server authorizes the academy and evaluates the list's
 * own filter authority once, in one statement, so the total and the rows describe one database state:
 * there is no client paging and no cross-call drift to detect. The file is either complete or not written:
 * - Inputs are frozen when the export starts; later filter edits never reach a running export.
 * - More than EXPORT_MAX_ROWS matches: the server refuses (SQLSTATE 54000) → `over_limit`.
 * - A response whose total, length or person ids disagree → `failed` (never a partial file).
 * - An aborted signal (Cancel, academy switch, unmount) → `cancelled`; an RPC failure → `failed`.
 */
import { supabase } from '@/lib/supabaseClient';
import { filtersToRpcJson, type PlayersOverviewParams } from '@/lib/playersOverview';
import { ExportError, buildCsv, type CsvColumn } from '@/lib/csvExport';

/** The server's bound (get_players_overview_export refuses above it); used here for messages only. */
export const EXPORT_MAX_ROWS = 20_000;

export interface ExportContact {
  personId: string;
  fullName: string;
  email: string;
  phone: string;
}

/** What the list shows: search, filters and order. */
export type ExportInputs = Readonly<Pick<PlayersOverviewParams, 'search' | 'filters' | 'sort' | 'sortDir'>>;

/** A frozen copy: mutating the caller's objects after the export starts cannot change it. */
export function freezeExportInputs(inputs: ExportInputs): ExportInputs {
  return Object.freeze({
    search: inputs.search,
    sort: inputs.sort,
    sortDir: inputs.sortDir,
    filters: Object.freeze({ ...(inputs.filters ?? {}) }),
  });
}

export interface ExportRpcArgs {
  p_academy: string;
  p_search?: string;
  p_filters: Record<string, unknown>;
  p_sort: string;
  p_sort_dir: string;
}
export interface ExportRpcResult {
  data: unknown;
  error: { code?: string; details?: string; message?: string } | null;
}
export type ExportRpc = (args: ExportRpcArgs, signal?: AbortSignal) => Promise<ExportRpcResult>;

const callExportRpc: ExportRpc = async (args, signal) => {
  const query = supabase.rpc('get_players_overview_export', { ...args, p_filters: args.p_filters as never });
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  return { data, error };
};

export interface FetchContactsOptions {
  signal?: AbortSignal;
  /** Injectable RPC (tests); defaults to get_players_overview_export. */
  rpc?: ExportRpc;
}

export async function fetchContactsForExport(
  academyId: string,
  inputs: ExportInputs,
  { signal, rpc = callExportRpc }: FetchContactsOptions = {},
): Promise<ExportContact[]> {
  const frozen = freezeExportInputs(inputs);
  const throwIfCancelled = () => {
    if (signal?.aborted) throw new ExportError('cancelled');
  };
  throwIfCancelled();

  let result: ExportRpcResult;
  try {
    result = await rpc({
      p_academy: academyId,
      p_search: frozen.search?.trim() || undefined,
      p_filters: filtersToRpcJson(frozen.filters),
      p_sort: frozen.sort ?? 'name',
      p_sort_dir: frozen.sortDir ?? 'asc',
    }, signal);
  } catch (cause) {
    throwIfCancelled();
    throw new ExportError('failed', { cause });
  }
  throwIfCancelled();

  const { data, error } = result;
  if (error) {
    if (error.code === '54000') {
      const m = /total=(\d+) max=(\d+)/.exec(error.details ?? '');
      throw new ExportError('over_limit', {
        total: m ? Number(m[1]) : undefined,
        max: m ? Number(m[2]) : EXPORT_MAX_ROWS,
        cause: error,
      });
    }
    throw new ExportError('failed', { cause: error });
  }

  // One row { total, rows }. Anything that does not add up is refused, never written partially.
  const row = (Array.isArray(data) ? data[0] : data) as { total?: unknown; rows?: unknown } | null | undefined;
  const total = Number(row?.total);
  const rows = row?.rows;
  if (!Number.isSafeInteger(total) || !Array.isArray(rows) || rows.length !== total || total > EXPORT_MAX_ROWS) {
    throw new ExportError('failed', { total: Number.isSafeInteger(total) ? total : undefined });
  }
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const seen = new Set<string>();
  return rows.map((r: { person_id?: unknown; full_name?: unknown; email?: unknown; phone?: unknown }) => {
    const personId = text(r?.person_id);
    if (!personId || seen.has(personId)) throw new ExportError('failed', { total });
    seen.add(personId);
    return { personId, fullName: text(r.full_name), email: text(r.email), phone: text(r.phone) };
  });
}

/** The contact file's columns: name, email, phone (kept as text). Headers come from the page (i18n). */
export function contactCsvColumns(headers: { name: string; email: string; phone: string }): CsvColumn<ExportContact>[] {
  return [
    { header: headers.name, value: (c) => c.fullName },
    { header: headers.email, value: (c) => c.email },
    { header: headers.phone, value: (c) => c.phone, kind: 'phone' },
  ];
}

export function buildContactsCsv(
  contacts: readonly ExportContact[],
  headers: { name: string; email: string; phone: string },
): string {
  return buildCsv(contacts, contactCsvColumns(headers));
}
