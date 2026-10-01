import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ExportError,
  buildCsv,
  csvFilename,
  downloadCsv,
  neutralizeCell,
  phoneCell,
  type CsvColumn,
} from './csvExport';

type Row = { name: string; email?: string | null; phone?: string | null; count?: number };
const COLUMNS: CsvColumn<Row>[] = [
  { header: 'Name', value: (r) => r.name },
  { header: 'Email', value: (r) => r.email },
  { header: 'Phone', value: (r) => r.phone, kind: 'phone' },
];
const csvOf = (rows: Row[], columns = COLUMNS) => buildCsv(rows, columns);

describe('buildCsv — Excel-compatible, deterministic', () => {
  it('writes a UTF-8 BOM, `;` separators, CRLF records, a header row and a final CRLF', () => {
    expect(csvOf([{ name: 'Ann', email: 'ann@x.nl', phone: '06 1234 5678' }]))
      .toBe('﻿"Name";"Email";"Phone"\r\n"Ann";"ann@x.nl";"06 1234 5678"\r\n');
  });

  it('keeps the given row and column order, and a header-only file for no rows', () => {
    const reversed = [...COLUMNS].reverse();
    expect(csvOf([{ name: 'B' }, { name: 'A' }], reversed))
      .toBe('﻿"Phone";"Email";"Name"\r\n"";"";"B"\r\n"";"";"A"\r\n');
    expect(csvOf([])).toBe('﻿"Name";"Email";"Phone"\r\n');
  });

  it('writes null / undefined values as empty cells, never "null"', () => {
    expect(csvOf([{ name: 'X', email: null, phone: undefined }])).toContain('"X";"";""');
  });

  it('escapes quotes, and keeps separators and line breaks inside one quoted cell', () => {
    const csv = csvOf([{ name: 'Jan "de" Vries;\r\nJr' }]);
    expect(csv).toContain('"Jan ""de"" Vries;\r\nJr"');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(3); // header + one record spanning a break
  });
});

describe('formula-injection protection', () => {
  it.each(['=SUM(A1)', '+cmd|x', '-2+3', '@SUM(1)', '\tx', '\rx', '  =1', '＝1', '＋1'])(
    'neutralises a formula start: %j',
    (value) => {
      expect(neutralizeCell(value)).toBe(`'${value}`);
      expect(csvOf([{ name: value }])).toContain(`"'${value}"`);
    },
  );

  it('leaves ordinary text untouched, including international characters', () => {
    for (const v of ['Zoë Łukasz-Øberg 😀', 'O\'Neill', 'ann@x.nl', 'a=b']) expect(neutralizeCell(v)).toBe(v);
    expect(csvOf([{ name: 'Zoë Łukasz-Øberg 😀' }])).toContain('"Zoë Łukasz-Øberg 😀"');
  });

  it('`phone` columns stay text: + and leading zeros survive, formatted numbers are untouched', () => {
    expect(phoneCell('+31612345678')).toBe("'+31612345678");
    expect(phoneCell('0612345678')).toBe("'0612345678");
    expect(phoneCell('612345678')).toBe("'612345678");
    expect(phoneCell('06 1234 5678')).toBe('06 1234 5678');
    expect(phoneCell('')).toBe('');
    expect(phoneCell('=1+1')).toBe("'=1+1");
    expect(csvOf([{ name: 'P', phone: '0612345678' }])).toContain('"P";"";"\'0612345678"');
    // a text column is NOT given the phone marker
    expect(csvOf([{ name: '0612345678' }])).toContain('"0612345678";"";""');
  });

  it('neutralises every column and the headers, not only the first column', () => {
    const csv = csvOf([{ name: 'Ok', email: '=HYPERLINK("x")', phone: '@1' }],
      [...COLUMNS, { header: '=Header', value: () => '' }]);
    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
    expect(csv).toContain('"\'@1"');
    expect(csv).toContain('"\'=Header"');
  });
});

describe('csvFilename / downloadCsv', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names the file <prefix>-yyyy-MM-dd.csv from the local date', () => {
    expect(csvFilename('players', new Date(2026, 8, 29, 23, 30))).toBe('players-2026-09-29.csv');
  });

  it('replaces characters a file system rejects, and never produces an empty prefix', () => {
    const d = new Date(2026, 0, 2);
    expect(csvFilename('a/b\\c:d*e?f"g<h>i|j\u0001k', d)).toBe('a-b-c-d-e-f-g-h-i-j-k-2026-01-02.csv');
    expect(csvFilename('   ', d)).toBe('export-2026-01-02.csv');
  });

  it('downloads locally as UTF-8 CSV through an object URL, then releases it', () => {
    const created: Blob[] = [];
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { created.push(b as Blob); return 'blob:x'; });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    downloadCsv('f.csv', 'a;b\r\n');
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(created[0].type).toBe('text/csv;charset=utf-8;');
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:x');
    expect(document.querySelector('a[download]')).toBeNull(); // the temporary link is removed
  });
});

describe('ExportError', () => {
  it('carries a reason and the size-limit numbers', () => {
    const e = new ExportError('over_limit', { total: 20001, max: 20000 });
    expect(e).toBeInstanceOf(Error);
    expect(e.reason).toBe('over_limit');
    expect(e.detail).toEqual({ total: 20001, max: 20000 });
    expect(new ExportError('cancelled').detail).toEqual({});
  });
});
