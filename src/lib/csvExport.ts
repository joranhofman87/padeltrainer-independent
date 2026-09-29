/**
 * Shared CSV export mechanics for page exports: typed column definitions, deterministic Excel-compatible
 * formatting (UTF-8 BOM, `;` separators, CRLF records, every cell quoted — the convention intakeCsv
 * uses), formula-injection protection, the file name and the local download, and one failure vocabulary
 * for the loading / error / size-limit UX.
 *
 * It does NOT fetch or authorize anything. Each resource supplies its own authorized dataset (a server
 * call that enforces who may see which rows and bounds the size) and its own column spec; this module
 * only turns those typed rows into a file.
 */
import { format } from 'date-fns';

/** `phone` keeps numbers as text (leading zeros, `+`); everything else is plain text. */
export type CsvCellKind = 'text' | 'phone';

export interface CsvColumn<Row> {
  header: string;
  value: (row: Row) => string | null | undefined;
  kind?: CsvCellKind;
}

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
const cell = (value: string | null | undefined, kind: CsvCellKind = 'text') =>
  kind === 'phone' ? phoneCell(value ?? '') : neutralizeCell(value ?? '');

/** The whole file as one string: a header row, then one record per row, in the given order. */
export function buildCsv<Row>(rows: readonly Row[], columns: readonly CsvColumn<Row>[]): string {
  const lines = [
    columns.map((c) => cell(c.header)),
    ...rows.map((row) => columns.map((c) => cell(c.value(row), c.kind))),
  ];
  return '﻿' + lines.map((cells) => cells.map(quote).join(';')).join('\r\n') + '\r\n';
}

/** `<prefix>-yyyy-MM-dd.csv` (local date); characters a file system rejects become `-`. */
export function csvFilename(prefix: string, date: Date = new Date()): string {
  const safe = [...prefix].map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '-' : ch)).join('').trim();
  return `${safe || 'export'}-${format(date, 'yyyy-MM-dd')}.csv`;
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

/**
 * Why an export wrote no file: the resource's server bound was exceeded (`over_limit`, with the real
 * total when the server reports it), the user or a scope change cancelled it, or it failed (including a
 * response that does not add up). A file is either complete or not written.
 */
export type ExportFailure = 'over_limit' | 'cancelled' | 'failed';

export class ExportError extends Error {
  constructor(
    readonly reason: ExportFailure,
    readonly detail: { total?: number; max?: number; cause?: unknown } = {},
  ) {
    super(`export ${reason}`);
    this.name = 'ExportError';
  }
}
