// @vitest-environment node
// The EDGE twin of personIdentity.ts — must resolve identity from the IDs, guest-first, exactly
// like the frontend/SQL contract. Codex #2: the first attempt inferred ownership from whether a
// joined NAME was non-blank, which is not canonical.
import { describe, it, expect } from 'vitest';
import {
  personKeyOf, personRefOf, personDisplayName, personContactEmail,
} from '../../supabase/functions/_shared/person-identity.ts';
// The frontend contract, imported so the twin's key behaviour is pinned AGAINST it.
import { personKeyOf as personKeyOfFrontend, personRefOf as personRefOfFrontend } from '@/lib/personIdentity';

describe('person-identity edge twin — keyed on IDs, guest-first', () => {
  it('personKeyOf: a DUAL-KEY row keys to the GUEST (never the profile)', () => {
    expect(personKeyOf({ player_id: 'P1', guest_player_id: 'G1' })).toBe('g:G1');
    expect(personKeyOf({ player_id: 'P1', guest_player_id: null })).toBe('p:P1');
    expect(personKeyOf({ player_id: null, guest_player_id: 'G1' })).toBe('g:G1');
    expect(personKeyOf({})).toBeNull();
  });

  it('personRefOf: XOR — guest wins on a dual-key row', () => {
    expect(personRefOf({ player_id: 'P1', guest_player_id: 'G1' })).toEqual({ playerId: null, guestPlayerId: 'G1' });
    expect(personRefOf({ player_id: 'P1', guest_player_id: null })).toEqual({ playerId: 'P1', guestPlayerId: null });
  });

  it('personDisplayName: a dual-key child WITH a name shows the CHILD, not the parent', () => {
    // The whole point of keying on IDs: a non-blank profile name does NOT win for a guest row.
    expect(personDisplayName(
      { player_id: 'P1', guest_player_id: 'G1' },
      { profileName: 'Parent', guestName: 'Child' },
    )).toBe('Child');
  });

  it('personDisplayName: parent name appears ONLY when the guest has no name of their own', () => {
    expect(personDisplayName(
      { player_id: 'P1', guest_player_id: 'G1' },
      { profileName: 'Parent', guestName: '  ' },   // blank guest name → fallback
    )).toBe('Parent');
  });

  it('personDisplayName: a pure profile shows the profile name; fallback when nothing', () => {
    expect(personDisplayName({ player_id: 'P1' }, { profileName: 'Player P', guestName: null })).toBe('Player P');
    expect(personDisplayName({}, {}, 'Guest')).toBe('Guest');
  });

  it('personContactEmail: guest reached at their OWN email; parent inbox only when guest has none', () => {
    // FAM-02: a child WITH their own email is mailed themselves, never collapsed to the parent.
    expect(personContactEmail(
      { player_id: 'P1', guest_player_id: 'G1' },
      { profileEmail: 'parent@x.com', guestEmail: 'child@x.com' },
    )).toBe('child@x.com');
    // fallback to the linked parent inbox ONLY when the guest has no email
    expect(personContactEmail(
      { player_id: 'P1', guest_player_id: 'G1' },
      { profileEmail: 'parent@x.com', guestEmail: null },
    )).toBe('parent@x.com');
    // a pure profile
    expect(personContactEmail({ player_id: 'P1' }, { profileEmail: 'p@x.com', guestEmail: null })).toBe('p@x.com');
  });

  it('CONTRACT PARITY: the edge key/ref match the frontend personIdentity for the same rows', () => {
    // The twin must not drift from src/lib/personIdentity.ts. Exercise BOTH on identical rows.
    for (const row of [
      { player_id: 'P1', guest_player_id: 'G1' },
      { player_id: 'P1', guest_player_id: null },
      { player_id: null, guest_player_id: 'G1' },
      {},
    ]) {
      expect(personKeyOf(row), `key parity for ${JSON.stringify(row)}`).toBe(personKeyOfFrontend(row));
      expect(personRefOf(row), `ref parity for ${JSON.stringify(row)}`).toEqual(personRefOfFrontend(row));
    }
  });
});
