import { describe, it, expect } from 'vitest';
import {
  filterGuestRowsByRemoval,
  filterProfileIdsByRemoval,
  filterUnifiedPlayersForActiveContext,
  mergeRemovedPlayerKeys,
  shouldShowPlayerInAcademyContext,
  shouldShowPlayerInTrainerContext,
} from './playerRemovalVisibility';

describe('playerRemovalVisibility helpers', () => {
  it('aliases academy and trainer context checks', () => {
    expect(shouldShowPlayerInAcademyContext({ removed_at: '2026-01-01' })).toBe(false);
    expect(shouldShowPlayerInTrainerContext(null)).toBe(true);
  });

  it('merges removed key sets', () => {
    const merged = mergeRemovedPlayerKeys(
      { guestIds: new Set(['g1']), profileIds: new Set(['p1']) },
      { guestIds: new Set(['g2']), profileIds: new Set(['p1', 'p2']) },
    );
    expect(Array.from(merged.guestIds).sort()).toEqual(['g1', 'g2']);
    expect(Array.from(merged.profileIds).sort()).toEqual(['p1', 'p2']);
  });

  it('filters guest rows by removal keys', () => {
    const rows = [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }];
    const filtered = filterGuestRowsByRemoval(rows, { guestIds: new Set(['g2']), profileIds: new Set() });
    expect(filtered.map((r) => r.id)).toEqual(['g1', 'g3']);
  });

  it('filters profile ids by removal keys', () => {
    expect(
      filterProfileIdsByRemoval(['p1', 'p2', 'p3'], {
        guestIds: new Set(),
        profileIds: new Set(['p2']),
      }),
    ).toEqual(['p1', 'p3']);
  });

  it('filters unified players using metadata removed_at', () => {
    const players = [
      { id: 'guest-1', type: 'guest' as const, full_name: 'A' },
      { id: 'reg-profile-1', type: 'registered' as const, full_name: 'B' },
      { id: 'guest-2', type: 'guest' as const, full_name: 'C' },
    ];
    const metadata = [
      { id: 'm1', guest_player_id: 'guest-2', profile_id: null, removed_at: '2026-01-01' },
      { id: 'm2', guest_player_id: null, profile_id: 'profile-1', removed_at: null },
    ];

    const active = filterUnifiedPlayersForActiveContext(players, metadata as never, 'trainer');
    expect(active.map((p) => p.id)).toEqual(['guest-1', 'reg-profile-1']);
  });
});
