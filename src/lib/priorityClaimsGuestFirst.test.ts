/**
 * ABC-18 A3 — guest-first normalization of dual-key priority claims.
 *
 * A DUAL-KEY claim carries both `player_id` and `guest_player_id`. The person it is about is the
 * GUEST; the profile column on such a row is a legacy artefact. Reading it profile-first let a
 * guest token resolve to that profile and then sweep the profile's PURE sibling claims —
 * accepting and paying for seats belonging to a different account.
 *
 * Two kinds of assertion here, both discriminating:
 *   1. the exported normalizer's behaviour, which is the rule every caller routes through;
 *   2. a SOURCE guard over the query sites, because a `.eq('player_id', …)` without the
 *      companion null-check silently matches dual-key rows again. Behaviour alone would not
 *      catch that — the sweep only misbehaves against data a unit stub decides to return.
 */
import { describe, it, expect } from 'vitest';

const PROFILE = 'p-victim-profile';
const GUEST = 'g-child-guest';

describe('ABC-18 A3 · a dual-key token never reaches a profile\'s pure sibling claims', () => {
  it('normalizes guest-first: a dual-key claim yields no profile identity', async () => {
    const { normalizeClaimIdentity } = await import('./priorityClaims');
    expect(normalizeClaimIdentity({ player_id: PROFILE, guest_player_id: GUEST }))
      .toEqual({ playerId: null, guestPlayerId: GUEST });
  });

  it('a PURE-PROFILE claim keeps its profile identity', async () => {
    const { normalizeClaimIdentity } = await import('./priorityClaims');
    expect(normalizeClaimIdentity({ player_id: PROFILE, guest_player_id: null }))
      .toEqual({ playerId: PROFILE, guestPlayerId: null });
  });

  it('a guest-only claim is unchanged', async () => {
    const { normalizeClaimIdentity } = await import('./priorityClaims');
    expect(normalizeClaimIdentity({ player_id: null, guest_player_id: GUEST }))
      .toEqual({ playerId: null, guestPlayerId: GUEST });
  });

  it('an unscoped claim yields neither', async () => {
    const { normalizeClaimIdentity } = await import('./priorityClaims');
    expect(normalizeClaimIdentity({ player_id: null, guest_player_id: null }))
      .toEqual({ playerId: null, guestPlayerId: null });
  });

  it('every pure-profile claim query is pinned to guest_player_id IS NULL', async () => {
    // The regression this pins: `.eq('player_id', …)` WITHOUT the null-check matches dual-key
    // rows too, so the "defence in depth" pin would itself have been the leak.
    // process.cwd()-relative: import.meta.url is not a file: URL under the vitest transform.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/priorityClaims.ts'), 'utf8');
    const playerEq = [...src.matchAll(/\.eq\('player_id',[^)]*\)/g)];
    expect(playerEq.length).toBeGreaterThan(0);
    for (const m of playerEq) {
      // Wide enough to see past an intervening explanatory comment; the pin must appear before
      // the query is awaited, not merely somewhere in the file.
      const tail = src.slice(m.index!, m.index! + 500);
      expect({ site: m[0], pinned: /\.is\('guest_player_id', null\)/.test(tail) })
        .toMatchObject({ pinned: true });
    }
  });
});
