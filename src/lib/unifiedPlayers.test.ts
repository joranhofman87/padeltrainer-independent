import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fetchUnifiedPlayersCore } from './unifiedPlayers';
import type { GuestPlayerRow } from './guestPlayers';

// Per-table fixtures the chainable supabase mock resolves with.
const tableData: Record<string, unknown[]> = {};

function chainable(table: string) {
  const result = () => ({ data: tableData[table] ?? [], error: null });
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  Object.assign(builder, {
    select: self,
    eq: self,
    in: self,
    or: self,
    not: self,
    order: () => Promise.resolve(result()),
    limit: self,
    maybeSingle: () => Promise.resolve({ data: (tableData[table] ?? [])[0] ?? null, error: null }),
    single: () => Promise.resolve({ data: (tableData[table] ?? [])[0] ?? null, error: null }),
    then: (onF: (v: { data: unknown; error: null }) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(onF, onR),
  });
  return builder;
}

vi.mock('@/lib/supabaseClient', () => ({
  supabase: { from: (table: string) => chainable(table) },
}));

const guest = (over: Partial<GuestPlayerRow>): GuestPlayerRow => ({
  id: 'g1',
  trainer_id: null,
  academy_profile_id: 'a1',
  first_name: null,
  last_name: null,
  full_name: 'Guest One',
  email: null,
  phone: null,
  skill_rating: null,
  rating_system: 'knltb',
  notes: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  linked_profile_id: null,
  ...over,
});

const academyGuests: GuestPlayerRow[] = [];
let removedGuestIds = new Set<string>();
let removedProfileIds = new Set<string>();

vi.mock('@/lib/guestPlayers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./guestPlayers')>();
  return {
    ...actual,
    loadGuestPlayersForAcademy: vi.fn(async () => ({ data: academyGuests, error: null })),
    loadGuestPlayersForTrainer: vi.fn(async () => ({ data: academyGuests, error: null })),
  };
});

vi.mock('@/lib/playerRemovalVisibility', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./playerRemovalVisibility')>();
  return {
    ...actual,
    fetchRemovedPlayerKeys: vi.fn(async () => ({
      guestIds: removedGuestIds,
      profileIds: removedProfileIds,
    })),
  };
});

beforeEach(() => {
  for (const k of Object.keys(tableData)) delete tableData[k];
  academyGuests.length = 0;
  removedGuestIds = new Set();
  removedProfileIds = new Set();
});

describe('fetchUnifiedPlayersCore (academy scope)', () => {
  it('merges trainer-owned and academy guests, dedupes by id, sorts by name', async () => {
    tableData['guest_players'] = [
      guest({ id: 'g1', full_name: 'Zoe Trainerguest', trainer_id: 't1', academy_profile_id: null }),
      guest({ id: 'g2', full_name: 'Bob Dupe', trainer_id: 't1', academy_profile_id: null }),
    ];
    academyGuests.push(
      guest({ id: 'g2', full_name: 'Bob Dupe' }), // duplicate of trainer-owned
      guest({ id: 'g3', full_name: 'Anna Academy' }),
    );

    const { players } = await fetchUnifiedPlayersCore({
      kind: 'academy',
      academyProfileId: 'a1',
      trainerIds: ['t1'],
    });

    expect(players.map((p) => p.full_name)).toEqual(['Anna Academy', 'Bob Dupe', 'Zoe Trainerguest']);
    expect(players.every((p) => p.type === 'guest')).toBe(true);
    expect(players.map((p) => p.key)).toEqual(['g_g3', 'g_g2', 'g_g1']);
  });

  it('filters removed guests via academy removal metadata', async () => {
    academyGuests.push(guest({ id: 'g1', full_name: 'Kept' }), guest({ id: 'g2', full_name: 'Removed' }));
    removedGuestIds = new Set(['g2']);

    const { players } = await fetchUnifiedPlayersCore({
      kind: 'academy',
      academyProfileId: 'a1',
      trainerIds: [],
    });
    expect(players.map((p) => p.full_name)).toEqual(['Kept']);
  });

  it('includes registered players with confirmed bookings, deduping linked profiles', async () => {
    academyGuests.push(guest({ id: 'g1', full_name: 'Linked Guest', linked_profile_id: 'p1' }));
    tableData['availability_slots'] = [
      { id: 's1', trainer_id: 't1', location_id: null, cyclus_id: null, end_time: null, academy_profile_id: 'a1' },
    ];
    tableData['bookings'] = [
      { player_id: 'p1', slot_id: 's1', created_at: '2026-02-01T00:00:00Z' }, // linked -> deduped
      { player_id: 'p2', slot_id: 's1', created_at: '2026-02-02T00:00:00Z' },
    ];
    tableData['profiles'] = [
      {
        id: 'p2',
        full_name: 'Reg Player',
        email: 'reg@test.com',
        phone: null,
        skill_rating: null,
        rating_system: 'knltb',
        billing_business_name: 'Reg BV',
        billing_address: null,
        billing_btw_number: null,
      },
    ];

    const { players, registeredBookings, slots } = await fetchUnifiedPlayersCore({
      kind: 'academy',
      academyProfileId: 'a1',
      trainerIds: ['t1'],
    });

    const reg = players.filter((p) => p.type === 'registered');
    expect(reg).toHaveLength(1);
    expect(reg[0].key).toBe('p_p2');
    expect(reg[0].billing_business_name).toBe('Reg BV');
    expect(reg[0].created_at).toBe('2026-02-02T00:00:00Z');
    // linked profile p1 must NOT appear as registered
    expect(players.find((p) => p.profileId === 'p1')).toBeUndefined();
    // enrichment data is exposed for pages
    expect(slots).toHaveLength(1);
    expect(registeredBookings).toHaveLength(2);
  });

  it('filters removed registered profiles', async () => {
    tableData['availability_slots'] = [
      { id: 's1', trainer_id: 't1', location_id: null, cyclus_id: null, end_time: null, academy_profile_id: 'a1' },
    ];
    tableData['bookings'] = [{ player_id: 'p9', slot_id: 's1', created_at: '2026-02-01T00:00:00Z' }];
    removedProfileIds = new Set(['p9']);

    const { players } = await fetchUnifiedPlayersCore({
      kind: 'academy',
      academyProfileId: 'a1',
      trainerIds: ['t1'],
    });
    expect(players).toHaveLength(0);
  });
});

describe('fetchUnifiedPlayersCore (trainer scope)', () => {
  it('uses trainer guests and trainer slots', async () => {
    academyGuests.push(guest({ id: 'g1', full_name: 'Trainer Guest', trainer_id: 't1', academy_profile_id: null }));
    tableData['availability_slots'] = [
      { id: 's1', trainer_id: 't1', location_id: null, cyclus_id: null, end_time: null, academy_profile_id: null },
    ];
    tableData['bookings'] = [];

    const { players, trainerIds } = await fetchUnifiedPlayersCore({ kind: 'trainer', trainerId: 't1' });
    expect(trainerIds).toEqual(['t1']);
    expect(players.map((p) => p.key)).toEqual(['g_g1']);
  });
});
