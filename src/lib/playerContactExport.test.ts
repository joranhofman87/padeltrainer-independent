import { describe, it, expect, vi } from 'vitest';
import {
  EXPORT_MAX_ROWS,
  buildContactsCsv,
  contactCsvColumns,
  fetchContactsForExport,
  freezeExportInputs,
  type ExportContact,
  type ExportRpc,
  type ExportRpcArgs,
  type ExportRpcResult,
} from './playerContactExport';
import { ExportError } from './csvExport';
import { filtersToRpcJson } from './playersOverview';
import { supabase } from '@/lib/supabaseClient';

vi.mock('@/lib/supabaseClient', () => ({ supabase: { rpc: vi.fn() } }));

const ACADEMY = 'acad-1';
const HEADERS = {
  name: 'Name', email: 'Email', phone: 'Phone', currentlyTraining: 'Currently training',
  lastTrainingDate: 'Last training date', nextTrainingDate: 'Next training date',
  pastBookingsCount: 'Past sessions booked (not attendance)', birthDate: 'Birth date', locations: 'Locations',
  yes: 'Yes', no: 'No',
};

type ServerRow = {
  person_id: unknown; full_name?: unknown; email?: unknown; phone?: unknown; currently_training?: unknown;
  last_training_date?: unknown; next_training_date?: unknown; past_bookings_count?: unknown; birth_date?: unknown;
  location_names?: unknown;
};
/** A canonical person uuid, as PostgreSQL prints it. */
const uid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const person = (i: number, extra: Partial<ServerRow> = {}): ServerRow => ({
  person_id: uid(i),
  full_name: `Player ${i}`,
  email: `p${i}@x.nl`,
  phone: '',
  currently_training: false,
  last_training_date: null,
  next_training_date: null,
  past_bookings_count: 0,
  birth_date: null,
  location_names: [],
  ...extra,
});
/** A complete row except its own `phone` field. */
const withoutPhone = (): ServerRow => {
  const r: ServerRow = person(1);
  delete r.phone;
  return r;
};
/** get_players_overview_export's PostgREST shape: ONE row { total, rows }. */
const ok = (rows: ServerRow[], total = rows.length): ExportRpcResult => ({ data: [{ total, rows }], error: null });

function fakeRpc(result: ExportRpcResult | (() => Promise<ExportRpcResult>)) {
  const calls: Array<{ args: ExportRpcArgs; signal?: AbortSignal }> = [];
  const rpc = vi.fn<ExportRpc>(async (args, signal) => {
    calls.push({ args: structuredClone(args), signal });
    return typeof result === 'function' ? result() : result;
  });
  return { rpc, calls };
}

const reasonOf = (p: Promise<unknown>) =>
  p.then(() => 'resolved', (e) => (e instanceof ExportError ? e.reason : `other:${String(e)}`));

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

describe('the contact column spec (the shared mechanics are in csvExport.test.ts)', () => {
  const contact = (c: Partial<ExportContact>): ExportContact => ({
    personId: 'p', fullName: '', email: '', phone: '', currentlyTraining: false, lastTrainingDate: '',
    nextTrainingDate: '', pastBookingsCount: 0, birthDate: '', locationNames: [], ...c,
  });
  const HEAD = '"Name";"Email";"Phone";"Currently training";"Last training date";"Next training date";'
    + '"Past sessions booked (not attendance)";"Birth date";"Locations"';

  it('all nine columns in order, with the page headers; the person id is never written', () => {
    expect(contactCsvColumns(HEADERS).map((c) => c.header)).toEqual([
      'Name', 'Email', 'Phone', 'Currently training', 'Last training date', 'Next training date',
      'Past sessions booked (not attendance)', 'Birth date', 'Locations',
    ]);
    expect(buildContactsCsv([contact({
      personId: 'secret-id', fullName: 'Ann', email: 'ann@x.nl', phone: '06 1234 5678', currentlyTraining: true,
      lastTrainingDate: '2026-09-24', nextTrainingDate: '2026-10-08', pastBookingsCount: 12, birthDate: '2012-03-04',
      locationNames: ['Club A', 'Club B'],
    })], HEADERS)).toBe(`\uFEFF${HEAD}\r\n"Ann";"ann@x.nl";"06 1234 5678";"Yes";"2026-09-24";"2026-10-08";"12";"2012-03-04";"Club A; Club B"\r\n`);
  });

  it('missing dates, birth date and locations are empty cells; a zero count is written as 0; not training is No', () => {
    expect(buildContactsCsv([contact({ fullName: 'Bo' })], HEADERS))
      .toBe(`\uFEFF${HEAD}\r\n"Bo";"";"";"No";"";"";"0";"";""\r\n`);
  });

  it('a location name that looks like a formula is neutralised in its cell', () => {
    expect(buildContactsCsv([contact({ locationNames: ['=Club'] })], HEADERS)).toContain('"\'=Club"');
  });

  it('the phone column keeps numbers as text; name and email are formula-safe text', () => {
    const csv = buildContactsCsv([contact({ fullName: '=cmd', email: '@x', phone: '0612345678' })], HEADERS);
    expect(csv).toContain('"\'=cmd";"\'@x";"\'0612345678"');
  });
});

describe('fetchContactsForExport — one server call, complete or refused', () => {
  const inputs = freezeExportInputs({ search: '  an ', filters: { currentTraining: true }, sort: 'email', sortDir: 'desc' });

  it('ONE call with the frozen list inputs; every person in server order, canonical ids', async () => {
    const srv = fakeRpc(ok([person(2, { phone: '+31611' }), person(1)]));
    const contacts = await fetchContactsForExport(ACADEMY, inputs, { rpc: srv.rpc });
    expect(contacts).toEqual([
      expect.objectContaining({ personId: uid(2), fullName: 'Player 2', email: 'p2@x.nl', phone: '+31611' }),
      expect.objectContaining({ personId: uid(1), fullName: 'Player 1', email: 'p1@x.nl', phone: '' }),
    ]);
    expect(srv.calls.map((c) => c.args)).toEqual([{
      p_academy: ACADEMY, p_search: 'an', p_filters: { current_training: true }, p_sort: 'email', p_sort_dir: 'desc',
    }]);
  });

  it('defaults: no search is sent as undefined, sort name/asc, no filters {}', async () => {
    const srv = fakeRpc(ok([]));
    await fetchContactsForExport(ACADEMY, { search: '   ' }, { rpc: srv.rpc });
    expect(srv.calls[0].args).toEqual({
      p_academy: ACADEMY, p_search: undefined, p_filters: {}, p_sort: 'name', p_sort_dir: 'asc',
    });
  });

  it('the default transport is get_players_overview_export, with the abort signal attached', async () => {
    const builder = {
      abortSignal: vi.fn(function (this: unknown) { return this; }),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve({ data: [{ total: 1, rows: [person(7)] }], error: null }).then(res, rej),
    };
    vi.mocked(supabase.rpc).mockReturnValueOnce(builder as never);
    const ctl = new AbortController();
    const contacts = await fetchContactsForExport(ACADEMY, inputs, { signal: ctl.signal });
    expect(contacts.map((c) => c.personId)).toEqual([uid(7)]);
    expect(supabase.rpc).toHaveBeenLastCalledWith('get_players_overview_export', {
      p_academy: ACADEMY, p_search: 'an', p_filters: { current_training: true }, p_sort: 'email', p_sort_dir: 'desc',
    });
    expect(builder.abortSignal).toHaveBeenCalledWith(ctl.signal);
  });

  it('inputs are frozen: editing the caller objects while the call runs changes nothing', async () => {
    const filters = { currentTraining: true as boolean | null, trainingLocationId: 'loc-1' as string | null };
    const live = { search: 'an', filters, sort: 'name' as const, sortDir: 'asc' as const };
    let release!: () => void;
    const srv = fakeRpc(() => new Promise((r) => { release = () => r(ok([person(1)])); }));
    const running = fetchContactsForExport(ACADEMY, live, { rpc: srv.rpc });
    filters.currentTraining = false;
    filters.trainingLocationId = null;
    live.search = 'zz';
    release();
    expect(await running).toHaveLength(1);
    expect(srv.calls[0].args.p_filters).toEqual({ current_training: true, training_location_id: 'loc-1' });
    expect(srv.calls[0].args.p_search).toBe('an');
    const frozen = freezeExportInputs(live);
    expect(Object.isFrozen(frozen) && Object.isFrozen(frozen.filters)).toBe(true);
  });

  it('the server refusal above the bound is `over_limit`, with its total and max', async () => {
    const srv = fakeRpc({ data: null, error: { code: '54000', details: 'total=20001 max=20000', message: 'too large' } });
    const err = await fetchContactsForExport(ACADEMY, inputs, { rpc: srv.rpc }).catch((e) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect(err.reason).toBe('over_limit');
    expect(err.detail).toMatchObject({ total: 20001, max: 20000 });
  });

  it('`over_limit` even when the refusal detail is missing (max falls back to the known bound)', async () => {
    const srv = fakeRpc({ data: null, error: { code: '54000' } });
    const err = await fetchContactsForExport(ACADEMY, inputs, { rpc: srv.rpc }).catch((e) => e);
    expect(err.reason).toBe('over_limit');
    expect(err.detail).toMatchObject({ total: undefined, max: EXPORT_MAX_ROWS });
  });

  it('exactly the bound is exported in full; an empty match is an empty result', async () => {
    const full = Array.from({ length: EXPORT_MAX_ROWS }, (_, i) => person(i));
    expect(await fetchContactsForExport(ACADEMY, inputs, { rpc: fakeRpc(ok(full)).rpc })).toHaveLength(EXPORT_MAX_ROWS);
    expect(await fetchContactsForExport(ACADEMY, inputs, { rpc: fakeRpc(ok([])).rpc })).toEqual([]);
  });

  it('SQL NULL name / email / phone become empty cells, never "null"', async () => {
    const srv = fakeRpc(ok([person(1, { full_name: null, email: null, phone: null })]));
    expect(await fetchContactsForExport(ACADEMY, inputs, { rpc: srv.rpc })).toEqual([
      {
        personId: uid(1), fullName: '', email: '', phone: '', currentlyTraining: false, lastTrainingDate: '',
        nextTrainingDate: '', pastBookingsCount: 0, birthDate: '', locationNames: [],
      },
    ]);
  });

  it('reads the training, birth-date and location fields; names are deduplicated in order', async () => {
    const srv = fakeRpc(ok([person(1, {
      currently_training: true, last_training_date: '2026-09-24', next_training_date: '2026-10-08',
      past_bookings_count: 7, birth_date: '2012-03-04', location_names: ['Club B', 'Club A', 'Club B', ' '],
    })]));
    expect(await fetchContactsForExport(ACADEMY, inputs, { rpc: srv.rpc })).toEqual([{
      personId: uid(1), fullName: 'Player 1', email: 'p1@x.nl', phone: '', currentlyTraining: true,
      lastTrainingDate: '2026-09-24', nextTrainingDate: '2026-10-08', pastBookingsCount: 7, birthDate: '2012-03-04',
      locationNames: ['Club B', 'Club A'],
    }]);
  });

  it('any uuid version PostgreSQL can hold is a valid person id (v7 included)', async () => {
    const v7 = '0192d4e6-7c1a-7b3e-9f00-0a0b0c0d0e0f';
    const nilVersion = '9a000000-0000-0000-0000-000000000001';
    const srv = fakeRpc(ok([person(1, { person_id: v7 }), person(2, { person_id: nilVersion })]));
    expect((await fetchContactsForExport(ACADEMY, inputs, { rpc: srv.rpc })).map((c) => c.personId)).toEqual([v7, nilVersion]);
  });

  const refuses = async (result: ExportRpcResult) =>
    expect(await reasonOf(fetchContactsForExport(ACADEMY, inputs, { rpc: fakeRpc(result).rpc }))).toBe('failed');

  // REGRESSORS against the validator before correction PTF-CORRECTION-94ED (commit 94ed2cec): each of
  // these was ACCEPTED there and must be refused now.
  it.each([
    ['two envelopes (the second was silently ignored)', { data: [{ total: 1, rows: [person(1)] }, { total: 1, rows: [person(2)] }], error: null }],
    ['an object instead of the one-row array (was accepted)', { data: { total: 1, rows: [person(3)] }, error: null }],
    ['a null total with no rows (was read as 0)', { data: [{ total: null, rows: [] }], error: null }],
    ['a string total (was coerced)', { data: [{ total: '1', rows: [person(1)] }], error: null }],
    ['a person id that is not a uuid (was accepted)', ok([person(1, { person_id: 'p1' })])],
    ['a non-canonical (upper-case) uuid (was accepted)', ok([person(1, { person_id: '0192D4E6-7C1A-7B3E-9F00-0A0B0C0D0E0F' })])],
    ['a numeric name (was blanked)', ok([person(1, { full_name: 42 })])],
    ['an object email (was blanked)', ok([person(1, { email: {} })])],
    ['an array phone (was blanked)', ok([person(1, { phone: [] })])],
    ['a missing contact field (was blanked)', ok([withoutPhone()])],
    ['a missing training field (an older server)', ok([{ person_id: uid(1), full_name: 'A', email: 'a@x.nl', phone: '' }])],
    ['a non-boolean currently_training', ok([person(1, { currently_training: 'true' })])],
    ['a negative booking count', ok([person(1, { past_bookings_count: -1 })])],
    ['a fractional booking count', ok([person(1, { past_bookings_count: 1.5 })])],
    ['a string booking count', ok([person(1, { past_bookings_count: '3' })])],
    ['a timestamp instead of a date', ok([person(1, { last_training_date: '2026-09-24T10:00:00Z' })])],
    ['a non-string birth date', ok([person(1, { birth_date: 20120304 })])],
    ['location names that are not an array', ok([person(1, { location_names: 'Club A' })])],
    ['a non-text location name', ok([person(1, { location_names: ['Club A', 7] })])],
  ] as Array<[string, ExportRpcResult]>)('refuses %s as `failed` — nothing is written', async (_label, result) => {
    await refuses(result);
  });

  // REGRESSORS against e4acc0ed (review round 5, P3-2): an injected transport's NON-PLAIN objects —
  // class instances, or records whose fields are only inherited — were accepted there. PostgREST's JSON
  // never produces them; the contract is now literally "plain records with their own fields".
  class EnvelopeLike { total = 1; rows = [person(1)]; }
  class RowLike { person_id = uid(1); full_name = 'A'; email = 'a@x.nl'; phone = ''; }
  const inheriting = <T extends object>(proto: T): T => Object.create(proto) as T;
  it.each([
    ['a class-instance envelope', { data: [new EnvelopeLike()], error: null }],
    ['an envelope whose total and rows are only inherited', { data: [inheriting({ total: 1, rows: [person(1)] })], error: null }],
    ['a class-instance row', { data: [{ total: 1, rows: [new RowLike()] }], error: null }],
    ['a row whose fields are only inherited', { data: [{ total: 1, rows: [inheriting(person(1))] }], error: null }],
  ] as Array<[string, ExportRpcResult]>)('refuses %s (injected transport) as `failed`', async (_label, result) => {
    await refuses(result);
  });

  it('reads only OWN fields: a field polluted onto Object.prototype never fills a missing one', async () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.phone = '0612345678';
    try {
      await refuses(ok([withoutPhone()])); // every other field present: only the phone is missing
    } finally {
      delete proto.phone;
    }
  });

  it('a null-prototype record with its own fields is a plain record (accepted)', async () => {
    const bare = <T extends object>(o: T): T => Object.assign(Object.create(null) as T, o);
    const srv = fakeRpc({ data: [bare({ total: 1, rows: [bare(person(1))] })], error: null });
    expect((await fetchContactsForExport(ACADEMY, inputs, { rpc: srv.rpc })).map((c) => c.personId)).toEqual([uid(1)]);
  });

  // RETAINED CONTRACT: already refused before the correction as well — kept as coverage, not claimed as
  // evidence that the correction changed behaviour.
  it.each([
    ['no row at all', { data: [], error: null }],
    ['a non-object envelope', { data: ['x'], error: null }],
    ['null data', { data: null, error: null }],
    ['a fractional total', { data: [{ total: 1.5, rows: [person(1)] }], error: null }],
    ['a negative total', { data: [{ total: -1, rows: [] }], error: null }],
    ['a non-numeric total', { data: [{ total: 'many', rows: [] }], error: null }],
    ['a total that disagrees with the rows', ok([person(1), person(2)], 3)],
    ['more rows than the total', ok([person(1), person(2)], 1)],
    ['a "successful" response above the bound', ok(Array.from({ length: EXPORT_MAX_ROWS + 1 }, (_, i) => person(i)))],
    ['rows that are not an array', { data: [{ total: 0, rows: {} }], error: null }],
    ['a row that is not an object', { data: [{ total: 1, rows: [null] }], error: null }],
    ['a duplicated person (one person must be one row)', ok([person(1), person(2, { person_id: uid(1) })])],
    ['a row without a canonical person id', ok([person(1), person(2, { person_id: null })])],
    ['a non-string person id', ok([person(1, { person_id: 42 })])],
  ] as Array<[string, ExportRpcResult]>)('refuses %s as `failed` (retained contract)', async (_label, result) => {
    await refuses(result);
  });

  it('any other RPC error or a rejected call is `failed`, with the cause kept', async () => {
    const pgErr = { code: '42501', message: 'not authorized for academy acad-1' };
    const err = await fetchContactsForExport(ACADEMY, inputs, { rpc: fakeRpc({ data: null, error: pgErr }).rpc }).catch((e) => e);
    expect(err.reason).toBe('failed');
    expect(err.detail.cause).toBe(pgErr);
    const boom = new Error('network down');
    const err2 = await fetchContactsForExport(ACADEMY, inputs, { rpc: vi.fn<ExportRpc>().mockRejectedValue(boom) }).catch((e) => e);
    expect(err2.reason).toBe('failed');
    expect(err2.detail.cause).toBe(boom);
  });

  it('cancel before start calls nothing; cancel during the call is `cancelled` whatever the call returns', async () => {
    const pre = new AbortController();
    pre.abort();
    const srv0 = fakeRpc(ok([person(1)]));
    expect(await reasonOf(fetchContactsForExport(ACADEMY, inputs, { rpc: srv0.rpc, signal: pre.signal }))).toBe('cancelled');
    expect(srv0.calls).toHaveLength(0);

    const ctl = new AbortController();
    const srv = fakeRpc(async () => { ctl.abort(); return ok([person(1)]); });
    expect(await reasonOf(fetchContactsForExport(ACADEMY, inputs, { rpc: srv.rpc, signal: ctl.signal }))).toBe('cancelled');
    expect(srv.calls[0].signal).toBe(ctl.signal);

    const ctl2 = new AbortController();
    const rejecting = vi.fn<ExportRpc>(async () => { ctl2.abort(); throw new DOMException('aborted', 'AbortError'); });
    expect(await reasonOf(fetchContactsForExport(ACADEMY, inputs, { rpc: rejecting, signal: ctl2.signal }))).toBe('cancelled');
  });
});
