/**
 * Academy Players contact export (PTF option A, E1): EVERY person matching the list's search + filters
 * as a local Excel-compatible CSV: name / email / phone, current training, last / next training date,
 * past booking count (bookings, not attendance), birth date and associated clubs. The PTF-specific parts live here — the
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
  /** The list's own "Currently training" predicate, evaluated by the server for this person. */
  currentlyTraining: boolean;
  /** Academy-local `YYYY-MM-DD` of the latest ended academy session with a confirmed/completed booking; '' if none. */
  lastTrainingDate: string;
  /** Academy-local `YYYY-MM-DD` of the next in-progress/upcoming such session; '' if none. */
  nextTrainingDate: string;
  /** Distinct ended academy sessions with a confirmed/completed booking — bookings, not attendance. */
  pastBookingsCount: number;
  /** `YYYY-MM-DD` or ''. */
  birthDate: string;
  /** The person's authorized associated club names (the list's chips), deduplicated. */
  locationNames: string[];
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
  // its declared type, read only from plain records' OWN properties. Anything else is refused: a file is
  // never written from a response that does not add up (no coercion, no silently blanked field, no second
  // envelope ignored, no inherited field).
  if (!Array.isArray(data) || data.length !== 1 || !isPlainObject(data[0])) throw new ExportError('failed');
  const total = own(data[0], 'total');
  const rows = own(data[0], 'rows');
  const validTotal = typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 && total <= EXPORT_MAX_ROWS;
  if (!validTotal || !Array.isArray(rows) || rows.length !== total) {
    throw new ExportError('failed', { total: validTotal ? total : undefined });
  }
  const seen = new Set<string>();
  return rows.map((r: unknown) => {
    if (!isPlainObject(r)) throw new ExportError('failed', { total });
    const personId = own(r, 'person_id');
    if (typeof personId !== 'string' || !PG_UUID_TEXT.test(personId) || seen.has(personId)) {
      throw new ExportError('failed', { total });
    }
    seen.add(personId);
    const currentlyTraining = own(r, 'currently_training');
    const pastBookingsCount = own(r, 'past_bookings_count');
    if (typeof currentlyTraining !== 'boolean'
      || typeof pastBookingsCount !== 'number' || !Number.isSafeInteger(pastBookingsCount) || pastBookingsCount < 0) {
      throw new ExportError('failed', { total });
    }
    return {
      personId,
      fullName: nullableText(own(r, 'full_name'), total),
      email: nullableText(own(r, 'email'), total),
      phone: nullableText(own(r, 'phone'), total),
      currentlyTraining,
      lastTrainingDate: nullableDate(own(r, 'last_training_date'), total),
      nextTrainingDate: nullableDate(own(r, 'next_training_date'), total),
      pastBookingsCount,
      birthDate: nullableDate(own(r, 'birth_date'), total),
      locationNames: textList(own(r, 'location_names'), total),
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

/**
 * A plain JSON-style record: an ordinary or null-prototype object. Not an array, and not a class instance
 * or any other object with its own prototype chain (what JSON.parse of the PostgREST response yields).
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** A record's OWN property. An inherited or absent one reads as undefined, which no field accepts. */
function own(v: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(v, key) ? v[key] : undefined;
}

/** A contact field is text or SQL NULL (an empty cell); any other type refuses the export. */
function nullableText(v: unknown, total: number): string {
  if (typeof v === 'string') return v;
  if (v === null) return '';
  throw new ExportError('failed', { total });
}

/** A real calendar date as `YYYY-MM-DD` text, or SQL NULL (an empty cell); anything else refuses the export. */
function nullableDate(v: unknown, total: number): string {
  if (v === null) return '';
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d) return v as string;
  }
  throw new ExportError('failed', { total });
}

/**
 * A list of names: an array of text only. Names are kept VERBATIM (as the list shows them); only exact
 * duplicates are removed, order kept. Anything else refuses the export.
 */
function textList(v: unknown, total: number): string[] {
  if (!Array.isArray(v) || !v.every((n) => typeof n === 'string')) throw new ExportError('failed', { total });
  return [...new Set(v as string[])];
}

/** Column headers and the two training-status words; all come from the page (i18n). */
export interface ExportHeaders {
  name: string;
  email: string;
  phone: string;
  currentlyTraining: string;
  lastTrainingDate: string;
  nextTrainingDate: string;
  pastBookingsCount: string;
  birthDate: string;
  locations: string;
  yes: string;
  no: string;
}

/** Locations in one cell are separated by `; ` (the cell is quoted, so the file's `;` delimiter is safe). */
export const LOCATION_SEPARATOR = '; ';

/** The export file's columns. Phones stay text; dates are `YYYY-MM-DD`; a missing date is an empty cell. */
export function contactCsvColumns(headers: ExportHeaders): CsvColumn<ExportContact>[] {
  return [
    { header: headers.name, value: (c) => c.fullName },
    { header: headers.email, value: (c) => c.email },
    { header: headers.phone, value: (c) => c.phone, kind: 'phone' },
    { header: headers.currentlyTraining, value: (c) => (c.currentlyTraining ? headers.yes : headers.no) },
    { header: headers.lastTrainingDate, value: (c) => c.lastTrainingDate },
    { header: headers.nextTrainingDate, value: (c) => c.nextTrainingDate },
    { header: headers.pastBookingsCount, value: (c) => String(c.pastBookingsCount) },
    { header: headers.birthDate, value: (c) => c.birthDate },
    { header: headers.locations, value: (c) => c.locationNames.join(LOCATION_SEPARATOR) },
  ];
}

export function buildContactsCsv(
  contacts: readonly ExportContact[],
  headers: ExportHeaders,
): string {
  return buildCsv(contacts, contactCsvColumns(headers));
}
