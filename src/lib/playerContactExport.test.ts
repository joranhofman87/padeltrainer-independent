import { describe, it, expect, vi } from 'vitest';
import {
  EXPORT_MAX_ROWS,
  EXPORT_PAGE_SIZE,
  PlayerExportError,
  buildContactsCsv,
  fetchAllContactsForExport,
  freezeExportInputs,
  neutralizeCell,
  phoneCell,
  type ExportContact,
} from './playerContactExport';
import {
  fetchPlayersOverview,
  filtersToRpcJson,
  type PlayersOverviewParams,
  type PlayersOverviewRow,
} from './playersOverview';
import { supabase } from '@/lib/supabaseClient';

vi.mock('@/lib/supabaseClient', () => ({ supabase: { rpc: vi.fn(async () => ({ data: [], error: null })) } }));

const SCOPE = { kind: 'academy' as const, id: 'acad-1' };

describe('fetchPlayersOverview — explicit offset for overlapping export pages', () => {
  it('sends offset as p_offset, and still defaults to page * pageSize', async () => {
    const rpc = vi.mocked(supabase.rpc);
    await fetchPlayersOverview(SCOPE, { pageSize: 500, offset: 499, filters: { currentTraining: true } });
    expect(rpc).toHaveBeenLastCalledWith('get_players_overview', expect.objectContaining({
      p_scope: 'academy', p_scope_id: 'acad-1', p_limit: 500, p_offset: 499, p_filters: { current_training: true },
    }));
    await fetchPlayersOverview(SCOPE, { pageSize: 50, page: 3 });
    expect(rpc).toHaveBeenLastCalledWith('get_players_overview', expect.objectContaining({ p_limit: 50, p_offset: 150 }));
  });
});
const HEADERS = { name: 'Name', email: 'Email', phone: 'Phone' };

type Fake = Pick<PlayersOverviewRow, 'player_key' | 'person_id' | 'full_name' | 'email' | 'phone'>;
const person = (i: number, extra: Partial<Fake> = {}): Fake => ({
  player_key: `k${String(i).padStart(6, '0')}`,
  person_id: `p${i}`,
  full_name: `Player ${i}`,
  email: `p${i}@x.nl`,
  phone: '',
  ...extra,
});

/**
 * A fake paged RPC over a mutable list: returns the offset window and stamps every row with the
 * window total, exactly like get_players_overview. `beforeCall(n, list)` mutates between calls.
 */
function fakeServer(initial: Fake[], opts: { honour?: number; beforeCall?: (n: number, list: Fake[]) => void } = {}) {
  const list = [...initial];
  const calls: PlayersOverviewParams[] = [];
  const fetchPage = vi.fn(async (_scope: unknown, params: PlayersOverviewParams = {}) => {
    opts.beforeCall?.(calls.length, list);
    calls.push(structuredClone(params));
    const size = Math.min(params.pageSize ?? 50, opts.honour ?? Infinity);
    const offset = params.offset ?? 0;
    const rows = list.slice(offset, offset + size).map((r) => ({ ...r, total_count: list.length }));
    return { rows: rows as unknown as PlayersOverviewRow[], total: rows.length ? list.length : 0 };
  });
  return { fetchPage, calls, list };
}

const reasonOf = (p: Promise<unknown>) =>
  p.then(() => 'resolved', (e) => (e instanceof PlayerExportError ? e.reason : `other:${String(e)}`));

describe('filtersToRpcJson — the two training keys', () => {
  it('maps currentTraining true/false and trainingLocationId; omits them when unset', () => {
    expect(filtersToRpcJson({ currentTraining: true })).toEqual({ current_training: true });
    expect(filtersToRpcJson({ currentTraining: false })).toEqual({ current_training: false });
    expect(filtersToRpcJson({ trainingLocationId: 'loc-9' })).toEqual({ training_location_id: 'loc-9' });
    expect(filtersToRpcJson({ currentTraining: null, trainingLocationId: null })).toEqual({});
  });

  it('keeps the existing location/cyclus keys independent of the training keys', () => {
    expect(filtersToRpcJson({ locationId: 'loc-1', hasActiveCyclus: true, trainingLocationId: 'loc-2' })).toEqual({
      location_id: 'loc-1', has_active_cyclus: true, training_location_id: 'loc-2',
    });
  });
});

describe('buildContactsCsv — Excel-compatible, formula-safe', () => {
  const csvOf = (contacts: Partial<ExportContact>[]) =>
    buildContactsCsv(contacts.map((c, i) => ({ personId: `p${i}`, fullName: '', email: '', phone: '', ...c })), HEADERS);

  it('writes a UTF-8 BOM, `;` separators, CRLF records and a header row', () => {
    const csv = csvOf([{ fullName: 'Ann', email: 'ann@x.nl', phone: '06 1234 5678' }]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toBe('﻿"Name";"Email";"Phone"\r\n"Ann";"ann@x.nl";"06 1234 5678"\r\n');
  });

  it('escapes quotes, and keeps separators and line breaks inside one quoted cell', () => {
    const csv = csvOf([{ fullName: 'Jan "de" Vries;\r\nJr' }]);
    expect(csv).toContain('"Jan ""de"" Vries;\r\nJr"');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(3); // header + one record spanning a break
  });

  it.each(['=SUM(A1)', '+cmd|x', '-2+3', '@SUM(1)', '\tx', '\rx', '  =1', '＝1', '＋1'])(
    'neutralises a formula start: %j',
    (value) => {
      expect(neutralizeCell(value)).toBe(`'${value}`);
      expect(csvOf([{ fullName: value }])).toContain(`"'${value}"`);
    },
  );

  it('leaves ordinary text untouched, including international characters', () => {
    for (const v of ['Zoë Łukasz-Øberg 😀', 'O\'Neill', 'ann@x.nl', 'a=b']) expect(neutralizeCell(v)).toBe(v);
    expect(csvOf([{ fullName: 'Zoë Łukasz-Øberg 😀' }])).toContain('"Zoë Łukasz-Øberg 😀"');
  });

  it('keeps phone numbers as text: + and leading zeros survive, formatted numbers are untouched', () => {
    expect(phoneCell('+31612345678')).toBe("'+31612345678");
    expect(phoneCell('0612345678')).toBe("'0612345678");
    expect(phoneCell('612345678')).toBe("'612345678");
    expect(phoneCell('06 1234 5678')).toBe('06 1234 5678');
    expect(phoneCell('')).toBe('');
    expect(phoneCell('=1+1')).toBe("'=1+1");
  });

  it('neutralises every column, not only the name', () => {
    const csv = csvOf([{ fullName: 'Ok', email: '=HYPERLINK("x")', phone: '@1' }]);
    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
    expect(csv).toContain('"\'@1"');
  });
});

describe('fetchAllContactsForExport — complete or refused', () => {
  const inputs = freezeExportInputs({ search: 'an', filters: { currentTraining: true }, sort: 'name', sortDir: 'asc' });

  it('one page: every person, canonical ids, one call with the frozen inputs', async () => {
    const srv = fakeServer([person(1, { phone: '+31611' }), person(2)]);
    const contacts = await fetchAllContactsForExport(SCOPE, inputs, { fetchPage: srv.fetchPage });
    expect(contacts).toEqual([
      { personId: 'p1', fullName: 'Player 1', email: 'p1@x.nl', phone: '+31611' },
      { personId: 'p2', fullName: 'Player 2', email: 'p2@x.nl', phone: '' },
    ]);
    expect(srv.calls).toEqual([
      { search: 'an', filters: { currentTraining: true }, sort: 'name', sortDir: 'asc', pageSize: EXPORT_PAGE_SIZE, offset: 0 },
    ]);
  });

  it('every page overlaps the previous one by one row and all people arrive once, in order', async () => {
    const srv = fakeServer(Array.from({ length: 1200 }, (_, i) => person(i)));
    const progress: Array<[number, number]> = [];
    const contacts = await fetchAllContactsForExport(SCOPE, inputs, {
      fetchPage: srv.fetchPage, onProgress: (d, t) => progress.push([d, t]),
    });
    expect(srv.calls.map((c) => c.offset)).toEqual([0, 499, 998]);
    expect(contacts.map((c) => c.personId)).toEqual(Array.from({ length: 1200 }, (_, i) => `p${i}`));
    expect(progress).toEqual([[500, 1200], [999, 1200], [1200, 1200]]);
  });

  it('pages by what the server honours when it returns fewer rows than asked', async () => {
    const srv = fakeServer(Array.from({ length: 450 }, (_, i) => person(i)), { honour: 200 });
    const contacts = await fetchAllContactsForExport(SCOPE, inputs, { fetchPage: srv.fetchPage });
    expect(srv.calls.map((c) => c.offset)).toEqual([0, 199, 398]);
    expect(new Set(contacts.map((c) => c.personId)).size).toBe(450);
  });

  it('inputs are frozen: mutating the caller objects mid-export never reaches later pages', async () => {
    const filters = { currentTraining: true as boolean | null, trainingLocationId: 'loc-1' as string | null };
    const live = { search: 'an', filters, sort: 'name' as const, sortDir: 'asc' as const };
    const srv = fakeServer(Array.from({ length: 700 }, (_, i) => person(i)), {
      beforeCall: (n) => { if (n === 1) { filters.currentTraining = false; filters.trainingLocationId = null; live.search = 'zz'; } },
    });
    await fetchAllContactsForExport(SCOPE, live, { fetchPage: srv.fetchPage });
    for (const c of srv.calls) {
      expect(c.filters).toEqual({ currentTraining: true, trainingLocationId: 'loc-1' });
      expect(c.search).toBe('an');
    }
  });

  it('refuses over the cap after the first page, before fetching any other page', async () => {
    const srv = fakeServer(Array.from({ length: EXPORT_MAX_ROWS + 1 }, (_, i) => person(i)));
    const err = await fetchAllContactsForExport(SCOPE, inputs, { fetchPage: srv.fetchPage }).catch((e) => e);
    expect(err).toBeInstanceOf(PlayerExportError);
    expect(err.reason).toBe('over_limit');
    expect(err.detail).toEqual({ total: EXPORT_MAX_ROWS + 1, max: EXPORT_MAX_ROWS });
    expect(srv.calls).toHaveLength(1);
  });

  it('exactly the cap is still exported in full', async () => {
    const srv = fakeServer(Array.from({ length: EXPORT_MAX_ROWS }, (_, i) => person(i)));
    expect(await fetchAllContactsForExport(SCOPE, inputs, { fetchPage: srv.fetchPage })).toHaveLength(EXPORT_MAX_ROWS);
  });

  it('an empty match is an empty result, not an error', async () => {
    const srv = fakeServer([]);
    expect(await fetchAllContactsForExport(SCOPE, inputs, { fetchPage: srv.fetchPage })).toEqual([]);
  });

  it('refuses when the total changes between pages (someone left the filter)', async () => {
    const srv = fakeServer(Array.from({ length: 700 }, (_, i) => person(i)), {
      beforeCall: (n, list) => { if (n === 1) list.splice(10, 1); },
    });
    expect(await reasonOf(fetchAllContactsForExport(SCOPE, inputs, { fetchPage: srv.fetchPage }))).toBe('changed');
  });

  it('refuses a join during export even when every page still looks full (only the total shows it)', async () => {
    // 999 rows → pages [0..499] and [499..998]; the second page is exactly full whether or not
    // someone joined at the end, so only the window total reveals the change.
    const srv = fakeServer(Array.from({ length: 999 }, (_, i) => person(i)), {
      beforeCall: (n, list) => { if (n === 1) list.push(person(5000)); },
    });
    expect(await reasonOf(fetchAllContactsForExport(SCOPE, inputs, { fetchPage: srv.fetchPage }))).toBe('changed');
  });

  it('refuses a shift that keeps the total equal (leave before + join after the boundary)', async () => {
    // Without the overlap row this silently skips person 500 and still "adds up" to 700.
    const srv = fakeServer(Array.from({ length: 700 }, (_, i) => person(i)), {
      beforeCall: (n, list) => { if (n === 1) { list.splice(10, 1); list.push(person(9999)); } },
    });
    expect(await reasonOf(fetchAllContactsForExport(SCOPE, inputs, { fetchPage: srv.fetchPage }))).toBe('changed');
  });

  it('refuses a duplicated person (one person must be one row)', async () => {
    const srv = fakeServer([person(1), person(2, { person_id: 'p1' })]);
    expect(await reasonOf(fetchAllContactsForExport(SCOPE, inputs, { fetchPage: srv.fetchPage }))).toBe('changed');
  });

  it('refuses a row without a canonical person id', async () => {
    const srv = fakeServer([person(1), person(2, { person_id: null as unknown as string })]);
    expect(await reasonOf(fetchAllContactsForExport(SCOPE, inputs, { fetchPage: srv.fetchPage }))).toBe('failed');
  });

  it('refuses a short page while the total claims more rows', async () => {
    const srv = fakeServer(Array.from({ length: 700 }, (_, i) => person(i)), { honour: 500 });
    const fetchPage = vi.fn(async (s: unknown, p: PlayersOverviewParams = {}) => {
      const res = await srv.fetchPage(s, p);
      return p.offset ? { ...res, rows: res.rows.slice(0, -1) } : res;
    });
    expect(await reasonOf(fetchAllContactsForExport(SCOPE, inputs, { fetchPage }))).toBe('changed');
  });

  it('an RPC failure is `failed`, with the cause kept', async () => {
    const boom = new Error('rpc down');
    const err = await fetchAllContactsForExport(SCOPE, inputs, { fetchPage: vi.fn().mockRejectedValue(boom) }).catch((e) => e);
    expect(err.reason).toBe('failed');
    expect(err.detail.cause).toBe(boom);
  });

  it('cancel before start fetches nothing; cancel mid-export stops before the next page', async () => {
    const pre = new AbortController();
    pre.abort();
    const srv0 = fakeServer([person(1)]);
    expect(await reasonOf(fetchAllContactsForExport(SCOPE, inputs, { fetchPage: srv0.fetchPage, signal: pre.signal }))).toBe('cancelled');
    expect(srv0.calls).toHaveLength(0);

    const ctl = new AbortController();
    const srv = fakeServer(Array.from({ length: 1200 }, (_, i) => person(i)), {
      beforeCall: (n) => { if (n === 1) ctl.abort(); },
    });
    expect(await reasonOf(fetchAllContactsForExport(SCOPE, inputs, { fetchPage: srv.fetchPage, signal: ctl.signal }))).toBe('cancelled');
    expect(srv.calls).toHaveLength(2);
  });
});
