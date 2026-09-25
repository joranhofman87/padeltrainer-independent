import type { ComponentType } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PlayersOverviewRow } from '@/lib/playersOverview';

/**
 * Trainer + academy player LISTS show business state only. The owner's product decision: the
 * lists no longer tell guests from registered/login accounts — no Type column, no "Type" entry in
 * the Columns menu, no Guest/Registered badge (desktop Status column or mobile card) — and the
 * activity badge is Active iff has_trained, otherwise Prospect, whatever the login state.
 * The identity model underneath is untouched: rows still carry player_type, and the detail links
 * still route by guest_player_id / profile_id exactly as before.
 *
 * Rendered with the REAL en translations so "Registered"/"Guest" are the strings a user saw.
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

// ── data ─────────────────────────────────────────────────────────────────────────────────────
function row(p: Partial<PlayersOverviewRow> & Pick<PlayersOverviewRow, 'full_name' | 'player_type' | 'has_trained'>): PlayersOverviewRow {
  return {
    academy_notes: '',
    billing_address: '',
    billing_btw_number: '',
    billing_business_name: '',
    birth_date: '',
    created_at: '2026-01-15T10:00:00Z',
    email: '',
    email_undeliverable: false,
    guest_player_id: null as unknown as string,
    has_active_cyclus: false,
    has_overdue_payment: false,
    location_ids: [],
    location_names: [],
    metadata_id: null as unknown as string,
    notes: '',
    owner_trainer_id: null as unknown as string,
    person_id: null as unknown as string,
    phone: '',
    player_key: '',
    profile_id: null as unknown as string,
    rating_system: 'knltb',
    skill_rating: null as unknown as number,
    source: '',
    tag_ids: [],
    total_count: 4,
    trainer_ids: [],
    ...p,
  };
}

// The four login × activity combinations. A merged person (guest + profile sides, one row) is
// the registered-but-never-trained case — the one the old code mislabelled "Registered".
const ROWS: PlayersOverviewRow[] = [
  row({ full_name: 'Ann Account', player_type: 'registered', has_trained: true, profile_id: 'prof-a', person_id: 'per-a' }),
  row({ full_name: 'Bob Merged', player_type: 'registered', has_trained: false, guest_player_id: 'gp-b', profile_id: 'prof-b', person_id: 'per-b' }),
  row({ full_name: 'Cas Guest', player_type: 'guest', has_trained: true, guest_player_id: 'gp-c', person_id: 'per-c' }),
  row({ full_name: 'Dee Guest', player_type: 'guest', has_trained: false, guest_player_id: 'gp-d', person_id: 'per-d' }),
];
const EXPECTED_STATUS: Record<string, 'Active' | 'Prospect'> = {
  'Ann Account': 'Active',
  'Bob Merged': 'Prospect',
  'Cas Guest': 'Active',
  'Dee Guest': 'Prospect',
};
// Detail routes are unchanged: guest side preferred, else the profile side.
const EXPECTED_ROUTE_ID: Record<string, string> = {
  'Ann Account': 'p_prof-a',
  'Bob Merged': 'g_gp-b',
  'Cas Guest': 'g_gp-c',
  'Dee Guest': 'g_gp-d',
};

// ── module mocks ───────────────────────────────────────────────────────────────────────────
vi.mock('@/lib/playersOverview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/playersOverview')>();
  return {
    ...actual,
    usePlayersOverview: () => ({ data: { rows: ROWS, total: ROWS.length }, isLoading: false }),
    fetchPlayersOverview: async () => ({ rows: [], total: ROWS.length }),
    fetchAllPlayersOverview: async () => [],
  };
});

type Result = { data: unknown; error: null };
function builder(result: Result) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'not', 'order', 'in', 'is']) b[m] = () => b;
  b.maybeSingle = () => Promise.resolve(result);
  b.then = (ok: (r: Result) => unknown, fail: (e: unknown) => unknown) => Promise.resolve(result).then(ok, fail);
  return b;
}
vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) =>
      builder({ data: table === 'trainer_profiles' ? { id: 'trainer-1' } : [], error: null }),
  },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));
vi.mock('@/hooks/useTrainerHasAcademy', () => ({ useTrainerCanEdit: () => ({ canEdit: true, isLoading: false }) }));
vi.mock('@/components/academy/AcademyLayout', () => ({
  useAcademyContext: () => ({ activeAcademy: { id: 'acad-1', name: 'Padel Zuid' } }),
}));
vi.mock('@/lib/academy', () => ({ getAcademyLocations: async () => [] }));
vi.mock('@/lib/trainerDisplayNames', () => ({ fetchTrainerDisplayNamesByProfileIds: async () => new Map() }));
// Cells/dialogs that own their own data access are irrelevant to this contract.
vi.mock('@/components/players/PlayerTagsCell', () => ({ PlayerTagsCell: () => null }));
vi.mock('@/components/players/PlayerNotesCell', () => ({ PlayerNotesCell: () => null }));
vi.mock('@/components/players/AddPlayerDialog', () => ({ AddPlayerDialog: () => null }));
vi.mock('@/components/players/AddPlayerForm', () => ({ AddPlayerForm: () => null }));
vi.mock('@/components/players/ImportPlayersDialog', () => ({ ImportPlayersDialog: () => null }));
vi.mock('@/components/players/ManagePlayerTagsDialog', () => ({ ManagePlayerTagsDialog: () => null }));

import TrainerPlayers from '@/pages/TrainerPlayers';
import AcademyPlayers from '@/pages/academy/AcademyPlayers';

// ── surfaces ───────────────────────────────────────────────────────────────────────────────
const SURFACES = [
  {
    name: 'TrainerPlayers',
    Page: TrainerPlayers,
    storageKey: 'trainerPlayers:visibleColumns:trainer-1',
    tableTestId: 'trainer-players-table-scroll',
    mobileTestId: 'trainer-players-mobile-cards',
    detailPrefix: '/app/trainer/players/',
  },
  {
    name: 'AcademyPlayers',
    Page: AcademyPlayers,
    storageKey: 'academyPlayers:visibleColumns:acad-1',
    tableTestId: 'academy-players-table-scroll',
    mobileTestId: 'academy-players-mobile-cards',
    detailPrefix: '/app/academy/players/',
  },
] as const;

const LOGIN_STATE_TEXT = /^(Registered|Guest|Registered Player|Geregistreerd|Gast)$/;

function renderPage(Page: ComponentType) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function headers(table: HTMLElement) {
  return within(table).getAllByRole('columnheader').map((h) => h.textContent?.trim() ?? '');
}

/** The Active/Prospect badge texts inside the table row, or the mobile card, that shows `name`. */
function statusIn(container: HTMLElement, name: string) {
  const nameEl = within(container).getByText(name);
  const owner = nameEl.closest('tr') ?? Array.from(container.children).find((card) => card.contains(nameEl));
  if (!owner) throw new Error(`no row/card for ${name}`);
  return within(owner as HTMLElement).queryAllByText(/^(Active|Prospect)$/).map((t) => t.textContent);
}

async function openColumnsMenu() {
  fireEvent.keyDown(screen.getByRole('button', { name: /Columns/ }), { key: 'Enter' });
  return screen.findByRole('menu');
}

beforeEach(() => {
  localStorage.clear();
});

describe.each(SURFACES)('$name list shows business state only', (s) => {
  it('Columns menu no longer offers a Type column (and still offers Status)', async () => {
    renderPage(s.Page);
    await screen.findByTestId(s.tableTestId);
    const menu = await openColumnsMenu();
    const items = within(menu).getAllByRole('menuitemcheckbox').map((i) => i.textContent?.trim());
    expect(items).toContain('Status');
    expect(items).toContain('Email');
    expect(items).not.toContain('Type');
    expect(items.length).toBeGreaterThan(5);
  });

  it('Status column + mobile cards: Active iff has_trained, else Prospect — never Registered/Guest', async () => {
    localStorage.setItem(s.storageKey, JSON.stringify(['email', 'status']));
    renderPage(s.Page);
    const table = await screen.findByTestId(s.tableTestId);
    await waitFor(() => expect(headers(table)).toContain('Status'));
    const mobile = screen.getByTestId(s.mobileTestId);

    for (const [name, expected] of Object.entries(EXPECTED_STATUS)) {
      expect(statusIn(table, name)).toEqual([expected]);
      expect(statusIn(mobile, name)).toEqual([expected]);
    }
    expect(within(table).queryAllByText(LOGIN_STATE_TEXT)).toEqual([]);
    expect(within(mobile).queryAllByText(LOGIN_STATE_TEXT)).toEqual([]);
    expect(headers(table)).not.toContain('Type');
  });

  it('default mobile cards carry no login-state badge either', async () => {
    renderPage(s.Page);
    const mobile = await screen.findByTestId(s.mobileTestId);
    expect(within(mobile).queryAllByText(LOGIN_STATE_TEXT)).toEqual([]);
    expect(within(mobile).getAllByText(/^(Active|Prospect)$/)).toHaveLength(ROWS.length);
  });

  it('detail links still route by the unchanged guest/profile keys', async () => {
    renderPage(s.Page);
    const table = await screen.findByTestId(s.tableTestId);
    for (const [name, routeId] of Object.entries(EXPECTED_ROUTE_ID)) {
      expect(within(table).getByRole('link', { name })).toHaveAttribute('href', `${s.detailPrefix}${routeId}`);
    }
  });

  it('a saved preference that still lists "type" degrades to the remaining valid columns', async () => {
    localStorage.setItem(s.storageKey, JSON.stringify(['email', 'type', 'status']));
    renderPage(s.Page);
    const table = await screen.findByTestId(s.tableTestId);
    await waitFor(() => expect(headers(table)).toContain('Status'));
    const h = headers(table);
    expect(h).toContain('Email');
    expect(h).not.toContain('Type');
    expect(h).not.toContain('Tags'); // the stored choice won, not the defaults
    expect(within(table).queryAllByText(LOGIN_STATE_TEXT)).toEqual([]);

    // The next toggle rewrites the preference without the dead key.
    const menu = await openColumnsMenu();
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Phone' }));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(s.storageKey) ?? 'null')).toEqual(['email', 'status', 'phone']),
    );
  });

  it('a saved preference of only "type" falls back to the default columns', async () => {
    localStorage.setItem(s.storageKey, JSON.stringify(['type']));
    renderPage(s.Page);
    const table = await screen.findByTestId(s.tableTestId);
    // Let the storage hydration effect run before asserting it changed nothing.
    await waitFor(() => expect(headers(table)).toEqual(
      expect.arrayContaining(['Tags', 'Internal notes', 'Email', 'Phone', 'Location', 'Date added']),
    ));
    expect(headers(table)).not.toContain('Type');
    expect(headers(table)).not.toContain('Status');
  });
});
