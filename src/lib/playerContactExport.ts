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
 * - A response that is not exactly one well-typed envelope, or whose total, length or person ids
 *   disagree, or with any field of the wrong type → `failed` (never a partial file).
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

  // Exactly ONE envelope — PostgREST's array holding the single { total, rows } row — and every field of
  // its declared type. Anything else is refused: a file is never written from a response that does
  // not add up (no coercion, no silently blanked field, no second envelope ignored).
  if (!Array.isArray(data) || data.length !== 1 || !isPlainObject(data[0])) throw new ExportError('failed');
  const { total, rows } = data[0];
  const validTotal = typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 && total <= EXPORT_MAX_ROWS;
  if (!validTotal || !Array.isArray(rows) || rows.length !== total) {
    throw new ExportError('failed', { total: validTotal ? total : undefined });
  }
  const seen = new Set<string>();
  return rows.map((r: unknown) => {
    if (!isPlainObject(r)) throw new ExportError('failed', { total });
    const personId = r.person_id;
    if (typeof personId !== 'string' || !PG_UUID_TEXT.test(personId) || seen.has(personId)) {
      throw new ExportError('failed', { total });
    }
    seen.add(personId);
    return {
      personId,
      fullName: nullableText(r.full_name, total),
      email: nullableText(r.email, total),
      phone: nullableText(r.phone, total),
    };
  });
}

/**
 * PostgreSQL's canonical uuid text (lower-case 8-4-4-4-12 hex, any version). Deliberately not
 * `isUuid` from academyPlayerTrainingLocations: that one admits RFC versions 1–5 only, and the
 * server's `uuid` column can hold any version (v7 is native in PostgreSQL 18; legacy ids vary) —
 * a valid export must not be refused over the id's version nibble.
 */
const PG_UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A contact field is text or SQL NULL (an empty cell); any other type refuses the export. */
function nullableText(v: unknown, total: number): string {
  if (typeof v === 'string') return v;
  if (v === null) return '';
  throw new ExportError('failed', { total });
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
