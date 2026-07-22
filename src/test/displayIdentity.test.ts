// @vitest-environment node
// canonicalPlayerName — the ONE guest-first display-identity resolver. Codex #5: staff-facing
// paths chose profiles.full_name before guest_players.full_name, so a trainer/manager saw the
// PARENT's name on a child/guest booking.
import { describe, it, expect } from 'vitest';
import { canonicalPlayerName } from '../../supabase/functions/_shared/display-identity.ts';

describe('canonicalPlayerName', () => {
  it('prefers the GUEST name on a dual-key booking (never the linked profile/parent)', () => {
    expect(canonicalPlayerName({ profiles: { full_name: 'Parent' }, guest_players: { full_name: 'Child' } }))
      .toBe('Child');
  });

  it('uses the profile name when there is no guest', () => {
    expect(canonicalPlayerName({ profiles: { full_name: 'Player P' }, guest_players: null })).toBe('Player P');
  });

  it('uses the guest name for a guest-only booking', () => {
    expect(canonicalPlayerName({ profiles: null, guest_players: { full_name: 'Gast' } })).toBe('Gast');
  });

  it('ignores a blank guest name and falls through to the profile', () => {
    expect(canonicalPlayerName({ profiles: { full_name: 'Player P' }, guest_players: { full_name: '  ' } }))
      .toBe('Player P');
  });

  it('falls back when neither is present', () => {
    expect(canonicalPlayerName(null)).toBe('Speler');
    expect(canonicalPlayerName({ profiles: null, guest_players: null }, 'Guest')).toBe('Guest');
  });
});
