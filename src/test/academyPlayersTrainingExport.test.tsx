import type { ComponentType, ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PlayersOverviewParams, PlayersOverviewRow } from '@/lib/playersOverview';

/**
 * PTF option A on the Academy Players page: the two training filters reach the overview query, and the
 * export takes every matching person with the filters FROZEN at click time, downloads a local CSV with
 * the exported count, and downloads nothing on cancel, academy switch or a refused (changed / over-limit)
 * export. The qualifying-session semantics themselves are proven on the real function in
 * playersOverviewCurrentTraining.pglite.test.ts; this file only proves the page wiring.
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
      const template = lookup(ns, key) ?? fallback ?? key;
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
const exportCalls: PlayersOverviewParams[] = [];
let exportImpl: (p: PlayersOverviewParams) => Promise<{ rows: PlayersOverviewRow[]; total: number }>;

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
      return { data: { rows: [listRow(1), listRow(2)], total: 2 }, isLoading: false };
    },
    fetchPlayersOverview: async (_scope: unknown, params: PlayersOverviewParams = {}) => {
      if (params.pageSize === 1) return { rows: [], total: 2 }; // header count query
      exportCalls.push(structuredClone(params));
      return exportImpl(params);
    },
    fetchAllPlayersOverview: async () => [],
  };
});

const downloads: Array<{ filename: string; csv: string }> = [];
vi.mock('@/lib/playerContactExport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/playerContactExport')>();
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
vi.mock('@/lib/supabaseClient', () => ({ supabase: { from: () => builder({ data: [], error: null }) } }));
// acad-2 ALSO lists club id loc-1: a club id alone does not say which academy chose it.
vi.mock('@/lib/academy', () => ({
  getAcademyLocations: async (id: string) =>
    id === 'acad-2'
      ? [{ location: { id: 'loc-1', name: 'Club Noord' } }, { location: { id: 'loc-3', name: 'Club Oost' } }]
      : [{ location: { id: 'loc-1', name: 'Club Noord' } }, { location: { id: 'loc-2', name: 'Club Zuid' } }],
}));
vi.mock('@/lib/trainerDisplayNames', () => ({ fetchTrainerDisplayNamesByProfileIds: async () => new Map() }));
vi.mock('@/components/players/PlayerTagsCell', () => ({ PlayerTagsCell: () => null }));
vi.mock('@/components/players/PlayerNotesCell', () => ({ PlayerNotesCell: () => null }));
vi.mock('@/components/players/AddPlayerDialog', () => ({ AddPlayerDialog: () => null }));
vi.mock('@/components/players/AddPlayerForm', () => ({ AddPlayerForm: () => null }));
vi.mock('@/components/players/ImportPlayersDialog', () => ({ ImportPlayersDialog: () => null }));
vi.mock('@/components/players/ManagePlayerTagsDialog', () => ({ ManagePlayerTagsDialog: () => null }));

import AcademyPlayers from '@/pages/academy/AcademyPlayers';

const person = (i: number, total: number, extra: Record<string, unknown> = {}) => ({
  player_key: `k${i}`, person_id: `per-${i}`, full_name: `Export ${i}`, email: `e${i}@x.nl`, phone: '', total_count: total, ...extra,
}) as unknown as PlayersOverviewRow;
const page = (rows: PlayersOverviewRow[]) => ({ rows, total: rows.length ? Number(rows[0].total_count) : 0 });

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

beforeEach(() => {
  academyId = 'acad-1';
  overviewCalls.length = 0;
  exportCalls.length = 0;
  downloads.length = 0;
  Object.values(toasts).forEach((f) => f.mockReset());
  exportImpl = async () => page([person(1, 2, { full_name: 'Ann', email: 'ann@x.nl', phone: '+31612345678' }), person(2, 2)]);
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
    await within(screen.getByLabelText('Training club')).findByRole('option', { name: 'Club Oost' }); // acad-2's clubs loaded
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

describe('Academy Players — export', () => {
  it('exports every matching person with the filters frozen at click time, and reports the count', async () => {
    renderPage();
    await screen.findByLabelText('Training club');
    choose('Training status', 'yes');
    choose('Training club', 'loc-1');

    const first = deferred<ReturnType<typeof page>>();
    exportImpl = () => first.promise;
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByTestId('academy-players-export-progress');

    choose('Training status', 'no'); // edits while it runs must not reach the export
    choose('Training club', 'all');
    await act(async () => first.resolve(page([person(1, 2, { full_name: 'Ann', email: 'ann@x.nl', phone: '+31612345678' }), person(2, 2)])));

    await waitFor(() => expect(downloads).toHaveLength(1));
    for (const call of exportCalls) {
      expect(call.filters).toMatchObject({ currentTraining: true, trainingLocationId: 'loc-1' });
      expect(call.pageSize).toBe(500);
    }
    expect(exportCalls[0].offset).toBe(0);
    expect(downloads[0].filename).toMatch(/^players-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(downloads[0].csv).toContain('"Name";"Email";"Phone"');
    expect(downloads[0].csv).toContain('"Ann";"ann@x.nl";"\'+31612345678"');
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
    expect(exportCalls.map((c) => c.search)).toEqual(['ann']);
  });

  it('Cancel stops the export and downloads nothing', async () => {
    renderPage();
    await screen.findByLabelText('Training club');
    const first = deferred<ReturnType<typeof page>>();
    exportImpl = () => first.promise;
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel export' }));
    await act(async () => first.resolve(page([person(1, 1)])));
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith('Export cancelled, nothing was downloaded.'));
    expect(downloads).toEqual([]);
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
  });

  it('switching academy cancels a running export — a file never mixes academies', async () => {
    const { rerenderPage } = renderPage();
    await screen.findByLabelText('Training club');
    const first = deferred<ReturnType<typeof page>>();
    exportImpl = () => first.promise;
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await screen.findByTestId('academy-players-export-progress');
    academyId = 'acad-2';
    rerenderPage();
    await act(async () => first.resolve(page([person(1, 1)])));
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith('Export cancelled, nothing was downloaded.'));
    expect(downloads).toEqual([]);
  });

  it('a list that changes during export is refused with nothing downloaded', async () => {
    exportImpl = async () => page([person(1, 2), person(2, 2, { person_id: 'per-1' })]);
    renderPage();
    await screen.findByLabelText('Training club');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(
      'The player list changed while exporting, so nothing was downloaded. Please try again.'));
    expect(downloads).toEqual([]);
  });

  it('over the limit is refused with the real numbers; an empty match downloads nothing', async () => {
    exportImpl = async () => page([person(1, 20_001)]);
    renderPage();
    await screen.findByLabelText('Training club');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(
      '20001 players match, but an export can hold at most 20000. Narrow the filters and try again.'));

    exportImpl = async () => page([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    await waitFor(() => expect(toasts.info).toHaveBeenCalledWith('No players match these filters, so nothing was exported.'));
    expect(downloads).toEqual([]);
  });
});
