import { describe, it, expect } from 'vitest';
import {
  personKeyOf,
  personRefOf,
  unifiedPersonKeyOf,
  personRefOfIds,
  matchBookingsToPerson,
  personDisplayName,
  type PersonRef,
} from './personIdentity';

describe('personKeyOf — guest-first namespaced person key (FAM-02 Level 1)', () => {
  it('guest-only row → g:<id>', () => {
    expect(personKeyOf({ player_id: null, guest_player_id: 'g1' })).toBe('g:g1');
  });
  it('profile-only row → p:<id>', () => {
    expect(personKeyOf({ player_id: 'p1', guest_player_id: null })).toBe('p:p1');
  });
  it('dual-keyed row (linker backfill) belongs to the GUEST person', () => {
    expect(personKeyOf({ player_id: 'p1', guest_player_id: 'g1' })).toBe('g:g1');
  });
  it('no identity → null', () => {
    expect(personKeyOf({ player_id: null, guest_player_id: null })).toBeNull();
    expect(personKeyOf({})).toBeNull();
  });
  it('a guest and a profile with the same raw uuid never collide (namespaced)', () => {
    expect(personKeyOf({ player_id: 'x', guest_player_id: null })).not.toBe(
      personKeyOf({ player_id: null, guest_player_id: 'x' }),
    );
  });
});

describe('personRefOf / personRefOfIds — XOR person ref, guest wins on dual rows', () => {
  it('dual row resolves to the guest with playerId null', () => {
    expect(personRefOf({ player_id: 'p1', guest_player_id: 'g1' })).toEqual({
      playerId: null,
      guestPlayerId: 'g1',
    });
  });
  it('profile row resolves to the profile with guestPlayerId null', () => {
    expect(personRefOf({ player_id: 'p1', guest_player_id: null })).toEqual({
      playerId: 'p1',
      guestPlayerId: null,
    });
  });
  it('no identity → null', () => {
    expect(personRefOf({ player_id: null, guest_player_id: null })).toBeNull();
  });
  it('personRefOfIds mirrors personRefOf for camelCase pairs (roster entries)', () => {
    expect(personRefOfIds('p1', 'g1')).toEqual({ playerId: null, guestPlayerId: 'g1' });
    expect(personRefOfIds('p1', null)).toEqual({ playerId: 'p1', guestPlayerId: null });
    expect(personRefOfIds(undefined, undefined)).toBeNull();
  });
});

/** Minimal query-builder spy matching the structural constraint of matchBookingsToPerson. */
function makeQuerySpy() {
  const calls: Array<[string, ...unknown[]]> = [];
  const q = {
    eq(column: string, value: string) {
      calls.push(['eq', column, value]);
      return q;
    },
    is(column: string, value: null) {
      calls.push(['is', column, value]);
      return q;
    },
  };
  return { q, calls };
}

describe('matchBookingsToPerson — the Level-1 booking scope per person', () => {
  it('guest person matches EVERY row carrying their guest id (dual rows are theirs)', () => {
    const { q, calls } = makeQuerySpy();
    matchBookingsToPerson(q, { playerId: null, guestPlayerId: 'g1' } as PersonRef);
    expect(calls).toEqual([['eq', 'guest_player_id', 'g1']]);
  });
  it('profile person matches only pure-profile rows (guest_player_id IS NULL)', () => {
    const { q, calls } = makeQuerySpy();
    matchBookingsToPerson(q, { playerId: 'p1', guestPlayerId: null } as PersonRef);
    expect(calls).toEqual([
      ['eq', 'player_id', 'p1'],
      ['is', 'guest_player_id', null],
    ]);
  });
});

describe('personDisplayName — guest person shows their OWN name', () => {
  it('guest person → guest name, even when a linked profile name exists', () => {
    expect(
      personDisplayName(
        { player_id: 'p1', guest_player_id: 'g1' },
        { profileName: 'Parent Account', guestName: 'Kid Own Name' },
      ),
    ).toBe('Kid Own Name');
  });
  it('guest person with a blank guest name falls back to the profile name', () => {
    expect(
      personDisplayName({ player_id: 'p1', guest_player_id: 'g1' }, { profileName: 'Parent', guestName: '  ' }),
    ).toBe('Parent');
  });
  it('profile person → profile name; guest name is irrelevant', () => {
    expect(
      personDisplayName({ player_id: 'p1', guest_player_id: null }, { profileName: 'Player', guestName: 'X' }),
    ).toBe('Player');
  });
  it('nothing usable → null (caller drops the row, matching current roster behavior)', () => {
    expect(personDisplayName({ player_id: 'p1' }, {})).toBeNull();
    expect(personDisplayName({ guest_player_id: 'g1' }, { guestName: '' })).toBeNull();
  });
});

describe('unifiedPersonKeyOf — Phase 3.1 person_id-first key with congruent fallback', () => {
  it('stamped row keys on person_id regardless of old keys', () => {
    expect(unifiedPersonKeyOf({ person_id: 'P', player_id: 'x', guest_player_id: 'y' })).toBe('person:P');
  });

  it('unstamped fallback is guest-side-first — congruent with the dual-write derivation', () => {
    expect(unifiedPersonKeyOf({ player_id: 'x', guest_player_id: 'y' })).toBe('person:y');
    expect(unifiedPersonKeyOf({ player_id: 'x' })).toBe('person:x');
  });

  it('deterministic ids make a stamped and an unstamped row of the SAME person key identically', () => {
    // guest-only person: person id = the guest uuid
    expect(unifiedPersonKeyOf({ person_id: 'g1', guest_player_id: 'g1' }))
      .toBe(unifiedPersonKeyOf({ guest_player_id: 'g1' }));
    // account holder: person id = the profile uuid
    expect(unifiedPersonKeyOf({ person_id: 'p1', player_id: 'p1' }))
      .toBe(unifiedPersonKeyOf({ player_id: 'p1' }));
  });

  it('a merged twin unifies rows under BOTH old keys onto one key', () => {
    const guestRow = { person_id: 'prof-uuid', guest_player_id: 'guest-uuid' };
    const profileRow = { person_id: 'prof-uuid', player_id: 'prof-uuid' };
    expect(unifiedPersonKeyOf(guestRow)).toBe(unifiedPersonKeyOf(profileRow));
  });

  it('no identity → null', () => {
    expect(unifiedPersonKeyOf({})).toBeNull();
  });
});
