import type { ComponentType, ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PlayersOverviewParams, PlayersOverviewRow } from '@/lib/playersOverview';

/**
 * PTF option A on the Academy Players page: the two training filters reach the overview query; the
 * export makes ONE get_players_overview_export call with the filters FROZEN at click time, downloads a
 * local CSV with the exported count, and downloads nothing on cancel, academy switch or a refused
 * (over-limit / inconsistent) export; and the club dropdowns never offer another academy's clubs, even
 * when location responses arrive late or out of order. The membership / qualifying-session semantics are
 * proven on the real functions in playersOverviewCurrentTraining.pglite.test.ts; this file only proves
 * the page wiring.
 */

const LOCALES = resolve(__dirname, '../i18n/locales/en');
const bundles: Record<string, Record<string, unknown>> = {};
function lookup(ns: string, key: string): string | undefined {
  bundles[ns] ??= JSON.parse(readFileSync(resolve(LOCALES, `${ns}.json`), 'utf8'));
  let node: unknown = bundles[ns];
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}
vi.mock('react-i18next', () => ({
  useTranslation: (ns = 'common') => ({
    t: (key: string, def?: string | Record<string, unknown>) => {
      const vars = typeof def === 'object' && def ? def : {};
      const fallback = typeof def === 'string' ? def : (vars.defaultValue as string | undefined);
      // i18next plural keys (`_one` / `_other`) when a numeric count is passed.
      const plural = typeof vars.count === 'number' ? lookup(ns, `${key}_${vars.count === 1 ? 'one' : 'other'}`) : undefined;
      const template = plural ?? lookup(ns, key) ?? fallback ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(vars[name] ?? ''));
    },
  }),
}));

// ── controllable academy + recorded overview/export calls ────────────────────────────────────
let academyId = 'acad-1';
// One stable object per academy, like the real context state (the page has effects keyed on it).
const academies: Record<string, { id: string; name: string }> = {};
vi.mock('@/components/academy/AcademyLayout', () => ({
  useAcademyContext: () => ({ activeAcademy: (academies[academyId] ??= { id: academyId, name: 'Academy' }) }),
}));

const overviewCalls: Array<PlayersOverviewParams & { scopeId: string }> = [];
// The overview RPC's total for the given query (the page's canonical totalFiltered).
let overviewTotal: (params: PlayersOverviewParams) => number = () => 2;
let overviewPlaceholderData: (params: PlayersOverviewParams) => boolean = () => false;

const listRow = (i: number) => ({
  player_key: `g_${i}`, player_type: 'guest', guest_player_id: `g${i}`, profile_id: null, person_id: `per-${i}`,
  full_name: `List Player ${i}`, email: '', phone: '', has_trained: false, created_at: '2026-01-15T10:00:00Z',
  rating_system: 'knltb', location_names: [], tag_ids: [], total_count: 2,
}) as unknown as PlayersOverviewRow;

vi.mock('@/lib/playersOverview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/playersOverview')>();
  return {
    ...actual,
    usePlayersOverview: (scope: { id: string }, params: PlayersOverviewParams) => {
      overviewCalls.push({ ...params, scopeId: scope.id });
      return {
        data: { rows: [listRow(1), listRow(2)], total: overviewTotal(params) },
        isLoading: false,
        isPlaceholderData: overviewPlaceholderData(params),
      };
    },
    fetchPlayersOverview: async () => ({ rows: [], total: 2 }), // header count query
    fetchAllPlayersOverview: async () => [],
  };
});

const downloads: Array<{ filename: string; csv: string }> = [];
vi.mock('@/lib/csvExport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/csvExport')>();
  return { ...actual, downloadCsv: (filename: string, csv: string) => downloads.push({ filename, csv }) };
});

const toasts = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock('sonner', () => ({ toast: { success: (m: string) => toasts.success(m), error: (m: string) => toasts.error(m), info: (m: string) => toasts.info(m) } }));

// Native select stand-in: the page wiring is under test, not Radix.
vi.mock('@/components/ui/select-filter', () => ({
  SelectFilter: (p: { value: string; onValueChange: (v: string) => void; allLabel: string; ariaLabel?: string;
    options: Array<{ value: string; label: ReactNode }> }) => (
    <select aria-label={p.ariaLabel ?? p.allLabel} value={p.value} onChange={(e) => p.onValueChange(e.target.value)}>
      <option value="all">{p.allLabel}</option>
      {p.options.map((o) => <option key={o.value} value={o.value}>{typeof o.label === 'string' ? o.label : o.value}</option>)}
    </select>
  ),
}));

type Result = { data: unknown; error: null };
function builder(result: Result) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'not', 'order', 'in', 'is']) b[m] = () => b;
  b.maybeSingle = () => Promise.resolve(result);
  b.then = (ok: (r: Result) => unknown, fail: (e: unknown) => unknown) => Promise.resolve(result).then(ok, fail);
  return b;
}

// get_players_overview_export: recorded args, a controllable result, and the abort signal it was given.
type ExportResult = { data: unknown; error: { code?: string; details?: string; message?: string } | null };
const exportCalls: Array<Record<string, unknown>> = [];
let exportImpl: (args: Record<string, unknown>) => Promise<ExportResult>;
const exportResponse = (rows: Array<Record<string, unknown>>, total = rows.length): ExportResult =>
  ({ data: [{ total, rows }], error: null });
vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: () => builder({ data: [], error: null }),
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn !== 'get_players_overview_export') throw new Error(`unexpected rpc ${fn}`);
      exportCalls.push(structuredClone(args));
      const result = exportImpl(args);
      const rpcBuilder = {
        abortSignal: () => rpcBuilder,
        then: (ok: (r: ExportResult) => unknown, fail: (e: unknown) => unknown) => result.then(ok, fail),
      };
      return rpcBuilder;
    },
  },
}));

// Academy clubs: acad-2 ALSO lists club id loc-1 (a club id alone does not say which academy chose it).
const CLUBS: Record<string, Array<{ location: { id: string; name: string } }>> = {
  'acad-1': [{ location: { id: 'loc-1', name: 'Club Noord' } }, { location: { id: 'loc-2', name: 'Club Zuid' } }],
  'acad-2': [{ location: { id: 'loc-1', name: 'Club Noord' } }, { location: { id: 'loc-3', name: 'Club Oost' } }],
};
let locationsImpl: (id: string) => Promise<Array<{ location: { id: string; name: string } }>>;
vi.mock('@/lib/academy', () => ({ getAcademyLocations: (id: string) => locationsImpl(id) }));
vi.mock('@/lib/trainerDisplayNames', () => ({ fetchTrainerDisplayNamesByProfileIds: async () => new Map() }));
vi.mock('@/components/players/PlayerTagsCell', () => ({ PlayerTagsCell: () => null }));
vi.mock('@/components/players/PlayerNotesCell', () => ({ PlayerNotesCell: () => null }));
vi.mock('@/components/players/AddPlayerDialog', () => ({ AddPlayerDialog: () => null }));
vi.mock('@/components/players/AddPlayerForm', () => ({ AddPlayerForm: () => null }));
vi.mock('@/components/players/ImportPlayersDialog', () => ({ ImportPlayersDialog: () => null }));
vi.mock('@/components/players/ManagePlayerTagsDialog', () => ({ ManagePlayerTagsDialog: () => null }));

import AcademyPlayers from '@/pages/academy/AcademyPlayers';

const person = (i: number, extra: Record<string, unknown> = {}) =>
  ({
    person_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, full_name: `Export ${i}`, email: `e${i}@x.nl`, phone: '',
    currently_training: false, last_training_date: null, next_training_date: null, past_bookings_count: 0,
    birth_date: null, location_names: [], ...extra,
  });

function deferred<T>() {
  let resolveFn!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolveFn = r; });
  return { promise, resolve: resolveFn };
}

function renderPage(Page: ComponentType = AcademyPlayers) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={qc}>
      <MemoryRouter><Page /></MemoryRouter>
    </QueryClientProvider>
  );
  const utils = render(tree());
  return { ...utils, rerenderPage: () => utils.rerender(tree()) };
}
const choose = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const lastFilters = () => overviewCalls[overviewCalls.length - 1].filters;
const clubOptions = () =>
  [...(screen.queryByLabelText('Training club')?.querySelectorAll('option') ?? [])].map((o) => o.textContent);

beforeEach(() => {
  academyId = 'acad-1';
  overviewCalls.length = 0;
  overviewTotal = () => 2;
  overviewPlaceholderData = () => false;
  exportCalls.length = 0;
  downloads.length = 0;
  Object.values(toasts).forEach((f) => f.mockReset());
  locationsImpl = async (id) => CLUBS[id] ?? [];
  exportImpl = async () =>
    exportResponse([person(1, { full_name: 'Ann', email: 'ann@x.nl', phone: '+31612345678' }), person(2)]);
});

describe('Academy Players — training filters', () => {
  it('status and club reach the overview query as the two training keys', async () => {
    renderPage();
    await screen.findByLabelText('Training club');
    expect(lastFilters()).toMatchObject({ currentTraining: null, trainingLocationId: null });

    choose('Training status', 'yes');
    expect(lastFilters()).toMatchObject({ currentTraining: true, trainingLocationId: null });
    choose('Training club', 'loc-2');
    expect(lastFilters()).toMatchObject({ currentTraining: true, trainingLocationId: 'loc-2' });
    choose('Training status', 'no');
    expect(lastFilters()).toMatchObject({ currentTraining: false });
    choose('Training status', 'all');
    choose('Training club', 'all');
    expect(lastFilters()).toMatchObject({ currentTraining: null, trainingLocationId: null });
  });

  it("an academy switch never carries the previous academy's training club — not even for one query", async () => {
    const { rerenderPage } = renderPage();
    await screen.findByLabelText('Training club');
    choose('Training club', 'loc-1');
    expect(lastFilters()).toMatchObject({ trainingLocationId: 'loc-1' });

    academyId = 'acad-2';
    rerenderPage();
    await within(await screen.findByLabelText('Training club')).findByRole('option', { name: 'Club Oost' }); // acad-2's clubs loaded
    const acad2Calls = overviewCalls.filter((c) => c.scopeId === 'acad-2');
    expect(acad2Calls.length).toBeGreaterThan(0);
    for (const c of acad2Calls) expect(c.filters?.trainingLocationId ?? null).toBeNull();
    expect((screen.getByLabelText('Training club') as HTMLSelectElement).value).toBe('all');
  });

  it('the training club filter lists the academy clubs and leaves the location filter alone', async () => {
    renderPage();
    const club = await screen.findByLabelText('Training club');
    expect([...club.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['All training clubs', 'Club Noord', 'Club Zuid']);
    choose('Training club', 'loc-1');
    expect(lastFilters()).toMatchObject({ trainingLocationId: 'loc-1', locationId: null });
  });
});

describe('Academy Players — visible filtered count', () => {
  const filteredCount = () => screen.getByTestId('academy-players-filtered-count').textContent;

  it("shows the overview RPC's total for the current filters, not the unfiltered header count", async () => {
    // The header count query answers 2; the filtered overview answers 37, then 5 once filtered.
    overviewTotal = (p) => (p.filters?.currentTraining === true ? 5 : 37);
    renderPage();
    await screen.findByLabelText('Training club');
    expect(filteredCount()).toBe('37 matching players');

    choose('Training status', 'yes');
    expect(lastFilters()).toMatchObject({ currentTraining: true });
    expect(filteredCount()).toBe('5 matching players');
  });

  it('uses the singular for one match and still shows a zero match', async () => {
    overviewTotal = (p) => (p.filters?.trainingLocationId === 'loc-2' ? 1 : p.filters?.currentTraining === false ? 0 : 2);
    renderPage();
    await screen.findByLabelText('Training club');
    expect(filteredCount()).toBe('2 matching players');

    choose('Training club', 'loc-2');
    expect(filteredCount()).toBe('1 matching player');

    choose('Training club', 'all');
    choose('Training status', 'no');
    expect(filteredCount()).toBe('0 matching players');
  });

  it('does not announce a previous filter total while the next overview is pending', async () => {
    overviewPlaceholderData = (p) => p.filters?.currentTraining === true;
    overviewTotal = (p) => (p.filters?.currentTraining === true ? 37 : 37);
    const { rerenderPage } = renderPage();
    await screen.findByLabelText('Training club');
    expect(filteredCount()).toBe('37 matching players');

    choose('Training status', 'yes');
    expect(filteredCount()).toBe('Updating matching players…');
    expect(screen.getByTestId('academy-players-filtered-count')).toHaveAttribute('aria-busy', 'true');

    overviewPlaceholderData = () => false;
    overviewTotal = (p) => (p.filters?.currentTraining === true ? 5 : 37);
    rerenderPage();
    expect(filteredCount()).toBe('5 matching players');
    expect(screen.getByTestId('academy-players-filtered-count')).toHaveAttribute('aria-busy', 'false');
  });
});

describe('Academy Players — club options across an academy switch (P2-3)', () => {
  it("after a switch the previous academy's clubs are gone at once, and its late response is dropped", async () => {
    const pending: Record<string, ReturnType<typeof deferred<(typeof CLUBS)[string]>>> = {};
    locationsImpl = (id) => (pending[id] = deferred()).promise;
    const { rerenderPage } = renderPage();
    await act(async () => pending['acad-1'].resolve(CLUBS['acad-1']));
    expect(clubOptions()).toEqual(['All training clubs', 'Club Noord', 'Club Zuid']);

    academyId = 'acad-2';
    rerenderPage();
    expect(clubOptions()).toEqual([]); // acad-1's clubs are not offered while acad-2's are loading

    // acad-2 answers first; then a LATE acad-1 answer (re-requested by nothing, but still in flight)
    const lateAcad1 = deferred<(typeof CLUBS)[string]>();
    await act(async () => pending['acad-2'].resolve(CLUBS['acad-2']));
    expect(clubOptions()).toEqual(['All training clubs', 'Club Noord', 'Club Oost']);
    await act(async () => lateAcad1.resolve(CLUBS['acad-1']));
    expect(clubOptions()).toEqual(['All training clubs', 'Club Noord', 'Club Oost']);
  });

  it('out-of-order responses: only the latest request writes (switch away and back)', async () => {
    const queue: Array<{ id: string; d: ReturnType<typeof deferred<(typeof CLUBS)[string]>> }> = [];
    locationsImpl = (id) => { const d = deferred<(typeof CLUBS)[string]>(); queue.push({ id, d }); return d.promise; };
    const { rerenderPage } = renderPage();          // request 1: acad-1
    academyId = 'acad-2';
    rerenderPage();                                 // request 2: acad-2
    academyId = 'acad-1';
    rerenderPage();                                 // request 3: acad-1 again
    await waitFor(() => expect(queue.map((q) => q.id)).toEqual(['acad-1', 'acad-2', 'acad-1']));

    await act(async () => queue[2].d.resolve(CLUBS['acad-1'])); // the latest answers first
    expect(clubOptions()).toEqual(['All training clubs', 'Club Noord', 'Club Zuid']);
    await act(async () => queue[1].d.resolve(CLUBS['acad-2'])); // a stale acad-2 answer must not win
    await act(async () => queue[0].d.resolve([]));              // nor a stale acad-1 answer
    expect(clubOptions()).toEqual(['All training clubs', 'Club Noord', 'Club Zuid']);
  });
});

describe('Academy Players — export (one server call)', () => {
  it('exports every matching person with the filters frozen at click time, and reports the count', async () => {
    renderPage();
    await screen.findByLabelText('Training club');
    choose('Training status', 'yes');
    choose('Training club', 'loc-1');

    const first = deferred<ExportResult>();
    exportImpl = () => first.promise;
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByTestId('academy-players-export-progress');

    choose('Training status', 'no'); // edits while it runs must not reach the export
    choose('Training club', 'all');
    await act(async () => first.resolve(exportResponse([person(1, { full_name: 'Ann', email: 'ann@x.nl', phone: '+31612345678', currently_training: true, last_training_date: '2026-09-24', next_training_date: '2026-10-08', past_bookings_count: 3, birth_date: '2012-03-04', location_names: ['Club A', 'Club B'] }), person(2)])));

    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(exportCalls).toEqual([{
      p_academy: 'acad-1', p_search: undefined, p_filters: { current_training: true, training_location_id: 'loc-1' },
      p_sort: 'name', p_sort_dir: 'asc',
    }]);
    expect(downloads[0].filename).toMatch(/^players-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(downloads[0].csv).toContain('"Name";"Email";"Phone";"Currently training";"Last training date";"Next training date";'
      + '"Past sessions booked (not attendance)";"Birth date";"Locations"');
    expect(downloads[0].csv).toContain('"Ann";"ann@x.nl";"\'+31612345678"');
    expect(downloads[0].csv).toContain('"Ann";"ann@x.nl";"\'+31612345678";"Yes";"2026-09-24";"2026-10-08";"3";"2012-03-04";"Club A; Club B"');
    expect(downloads[0].csv).toContain('"Export 2";"e2@x.nl";"";"No";"";"";"0";"";""');
    expect(toasts.success).toHaveBeenCalledWith('2 players exported');
    expect(lastFilters()).toMatchObject({ currentTraining: false, trainingLocationId: null }); // the list stays live
  });

  it('exports the search text visible at click time, not the lagging debounced copy', async () => {
    renderPage();
    await screen.findByLabelText('Training club');
    fireEvent.change(screen.getByPlaceholderText('Search by name, email or business name…'), { target: { value: 'ann' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' })); // well inside the 300 ms debounce
    expect(overviewCalls[overviewCalls.length - 1].search).toBe(''); // the table has not caught up yet
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(exportCalls.map((c) => c.p_search)).toEqual(['ann']);
  });

  it('Cancel stops the export and downloads nothing', async () => {
    renderPage();
    await screen.findByLabelText('Training club');
    const first = deferred<ExportResult>();
    exportImpl = () => first.promise;
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel export' }));
    await act(async () => first.resolve(exportResponse([person(1)])));
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith('Export cancelled, nothing was downloaded.'));
    expect(downloads).toEqual([]);
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
  });

  it('switching academy cancels a running export — a file never mixes academies', async () => {
    const { rerenderPage } = renderPage();
    await screen.findByLabelText('Training club');
    const first = deferred<ExportResult>();
    exportImpl = () => first.promise;
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByTestId('academy-players-export-progress');
    academyId = 'acad-2';
    rerenderPage();
    await act(async () => first.resolve(exportResponse([person(1)])));
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith('Export cancelled, nothing was downloaded.'));
    expect(downloads).toEqual([]);
  });

  it('an inconsistent response is refused with nothing downloaded', async () => {
    exportImpl = async () => exportResponse([person(1), person(2, { person_id: person(1).person_id })]);
    renderPage();
    await screen.findByLabelText('Training club');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(
      'The export failed, nothing was downloaded. Please try again.'));
    expect(downloads).toEqual([]);
  });

  it("over the limit is the server's refusal, shown with its numbers; an empty match downloads nothing", async () => {
    exportImpl = async () => ({ data: null, error: { code: '54000', details: 'total=20001 max=20000' } });
    renderPage();
    await screen.findByLabelText('Training club');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(
      '20001 players match, but an export can hold at most 20000. Narrow the filters and try again.'));

    exportImpl = async () => exportResponse([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith('No players match these filters, so nothing was exported.'));
    expect(downloads).toEqual([]);
  });
});
