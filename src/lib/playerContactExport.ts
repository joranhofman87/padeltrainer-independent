/**
 * Academy Players contact export (PTF option A): EVERY person matching the list's search + filters,
 * across all pages, as a local Excel-compatible CSV of name / email / phone.
 *
 * Honesty contract — the file is either complete or not written:
 * - Inputs are frozen when the export starts; later filter edits never reach a running export.
 * - The RPC is offset-paged and re-evaluated per call (no snapshot across calls), so every page after
 *   the first OVERLAPS the previous one by one row. A shift anywhere before a boundary changes that
 *   overlap row, so a person who matched throughout can never be skipped silently; the per-row window
 *   total must stay constant, each page must have its expected length, and the canonical person ids
 *   must be unique and number exactly `total`. Any violation → `changed`, and nothing is downloaded.
 * - More than EXPORT_MAX_ROWS matches → `over_limit` before any further page is fetched.
 * - An aborted signal (Cancel, academy switch, unmount) → `cancelled`; an RPC failure → `failed`.
 * This is NOT a transactional snapshot and does not claim to be one.
 */
import { fetchPlayersOverview, type PlayersOverviewParams, type PlayersOverviewRow } from '@/lib/playersOverview';
import type { PlayerScope } from '@/lib/playerQueryKeys';

export const EXPORT_MAX_ROWS = 20_000;
/** get_players_overview clamps p_limit at 500; request that maximum. */
export const EXPORT_PAGE_SIZE = 500;

export type PlayerExportFailure = 'over_limit' | 'changed' | 'cancelled' | 'failed';

export class PlayerExportError extends Error {
  constructor(
    readonly reason: PlayerExportFailure,
    readonly detail: { total?: number; max?: number; cause?: unknown } = {},
  ) {
    super(`player export ${reason}`);
    this.name = 'PlayerExportError';
  }
}

export interface ExportContact {
  personId: string;
  fullName: string;
  email: string;
  phone: string;
}

/** What the list shows: search, filters and order. Paging is the exporter's own business. */
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

export interface FetchAllContactsOptions {
  signal?: AbortSignal;
  onProgress?: (fetched: number, total: number) => void;
  /** Injectable page fetcher (tests); defaults to the real overview RPC client. */
  fetchPage?: typeof fetchPlayersOverview;
}

export async function fetchAllContactsForExport(
  scope: PlayerScope,
  inputs: ExportInputs,
  { signal, onProgress, fetchPage = fetchPlayersOverview }: FetchAllContactsOptions = {},
): Promise<ExportContact[]> {
  const frozen = freezeExportInputs(inputs);
  const throwIfCancelled = () => {
    if (signal?.aborted) throw new PlayerExportError('cancelled');
  };

  const getPage = async (offset: number) => {
    throwIfCancelled();
    let page: { rows: PlayersOverviewRow[]; total: number };
    try {
      page = await fetchPage(scope, { ...frozen, pageSize: EXPORT_PAGE_SIZE, offset });
    } catch (cause) {
      throwIfCancelled();
      throw new PlayerExportError('failed', { cause });
    }
    throwIfCancelled();
    return page;
  };

  const first = await getPage(0);
  const total = first.total;
  if (total > EXPORT_MAX_ROWS) throw new PlayerExportError('over_limit', { total, max: EXPORT_MAX_ROWS });
  if (total === 0) {
    if (first.rows.length !== 0) throw new PlayerExportError('changed');
    return [];
  }

  const assertTotal = (rows: PlayersOverviewRow[]) => {
    if (rows.some((r) => Number(r.total_count) !== total)) throw new PlayerExportError('changed', { total });
  };
  assertTotal(first.rows);

  // The server may honour fewer than EXPORT_PAGE_SIZE rows; page by what it actually returned (the
  // overlap/length/uniqueness checks below still verify every page). Overlap needs >= 2 rows a page.
  const pageSize = first.rows.length;
  if (pageSize > total) throw new PlayerExportError('changed', { total });
  if (pageSize < total && pageSize < 2) throw new PlayerExportError('failed', { total });

  const collected: PlayersOverviewRow[] = [...first.rows];
  let covered = pageSize; // rows [0, covered) are collected
  let previousLast = first.rows[first.rows.length - 1];
  onProgress?.(covered, total);

  while (covered < total) {
    const offset = covered - 1; // overlap the previous page's last row
    const page = await getPage(offset);
    assertTotal(page.rows);
    if (page.rows.length !== Math.min(pageSize, total - offset)) throw new PlayerExportError('changed', { total });
    if (page.rows[0].player_key !== previousLast.player_key) throw new PlayerExportError('changed', { total });
    collected.push(...page.rows.slice(1));
    covered = offset + page.rows.length;
    previousLast = page.rows[page.rows.length - 1];
    onProgress?.(covered, total);
  }

  const seen = new Set<string>();
  const contacts: ExportContact[] = [];
  for (const row of collected) {
    if (!row.person_id) throw new PlayerExportError('failed', { total });
    if (seen.has(row.person_id)) throw new PlayerExportError('changed', { total });
    seen.add(row.person_id);
    contacts.push({
      personId: row.person_id,
      fullName: row.full_name ?? '',
      email: row.email ?? '',
      phone: row.phone ?? '',
    });
  }
  // Every page had exactly its expected length, so the loop collected exactly `total` rows; with the
  // uniqueness check above, contacts.length === total holds by construction.
  return contacts;
}

// ---- CSV (Excel-compatible: UTF-8 BOM, `;` separators and CRLF, as the intake export uses) ----

/** Leading characters a spreadsheet may evaluate (incl. full-width forms and leading blanks). */
const FORMULA_START = /^[\t\r]|^\s*[=+\-@＝＋－＠]/;

/** Prefix a cell that a spreadsheet would evaluate as a formula; the original text is kept whole. */
export function neutralizeCell(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/**
 * Phone numbers stay text: `+31…` is neutralised like any formula start, and an all-digit number gets
 * the same text marker so a spreadsheet keeps its leading zero instead of reading it as a number.
 */
export function phoneCell(value: string): string {
  return /^\d+$/.test(value) ? `'${value}` : neutralizeCell(value);
}

const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;

export function buildContactsCsv(
  contacts: readonly ExportContact[],
  headers: { name: string; email: string; phone: string },
): string {
  const lines = [
    [headers.name, headers.email, headers.phone].map(neutralizeCell),
    ...contacts.map((c) => [neutralizeCell(c.fullName), neutralizeCell(c.email), phoneCell(c.phone)]),
  ];
  return '﻿' + lines.map((cells) => cells.map(quote).join(';')).join('\r\n') + '\r\n';
}

/** Local download through the browser; nothing is sent anywhere. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
