/**
 * ABC-18 A3 — the service-role rebook path normalizes dual-key claims guest-first.
 *
 * `create-rebook-invoice-public` runs as service_role, so RLS is NOT a backstop: whatever it
 * queries, it gets. A dual-key claim carries both columns, and reading it profile-first made a
 * guest token resolve to the raw profile — after which claim gathering, acceptance, booking,
 * invoice creation and dedup all operated on THAT profile's pure claims.
 *
 * This suite asserts the SOURCE of the deployed handler, because the handler is Deno and cannot
 * be imported here. That is a real guard rather than a proxy: every property below is a specific
 * textual invariant whose removal is exactly the regression, and each is paired with a check that
 * the unsafe form is absent — so deleting a filter fails the test rather than silently passing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let src: string;

beforeAll(() => {
  src = readFileSync(
    join(process.cwd(), 'supabase/functions/create-rebook-invoice-public/index.ts'),
    'utf8',
  );
});

describe('ABC-18 A3 · create-rebook-invoice-public is guest-first', () => {
  it('normalizes the claimant identity guest-first, at the source', () => {
    // dual-key ⇒ pid must be null. The exact expression is pinned because the whole file's
    // scoping depends on this one line.
    expect(src).toMatch(/const gid = rawGid;/);
    expect(src).toMatch(/const pid = rawGid \? null : rawPid;/);
  });

  it('never resolves the claimant profile-first', () => {
    // the pre-fix shape: taking player_id straight off the claim row
    expect(src).not.toMatch(/const pid = \(claim\.player_id as string \| null\) \?\? null;/);
  });

  it('keys group identity guest-first, so a dual-key member is not merged onto a profile', () => {
    expect(src).toMatch(/c\.guest_player_id \?\? c\.player_id/);
    expect(src).not.toMatch(/c\.player_id \?\? c\.guest_player_id/);
  });

  it('every pure-profile query also requires guest_player_id IS NULL', () => {
    // Covers the four scoped sites: existing-invoice lookup, claim gathering, bookings and
    // invoice dedup. A bare .eq("player_id", …) matches dual-key rows too, which is the leak.
    const bare = [...src.matchAll(/\.eq\("player_id",\s*\w+\)(?!\s*\.is\("guest_player_id", null\))/g)];
    expect(bare.map((m) => m[0])).toEqual([]);

    const pinned = [...src.matchAll(/\.eq\("player_id",\s*\w+\)\.is\("guest_player_id", null\)/g)];
    expect(pinned.length).toBeGreaterThanOrEqual(3);
  });

  it('the guest branch is never narrowed by a profile column', () => {
    // the guest side must stay keyed on guest_player_id alone
    expect(src).toMatch(/\.eq\("guest_player_id", gid!\)/);
  });

  it('states in the source why RLS cannot be relied on here', () => {
    // A future editor removing the filters needs to meet the reason, not just the code.
    expect(src).toMatch(/service_role/);
    expect(src).toMatch(/GUEST-FIRST NORMALIZATION/);
  });
});

describe('ABC-18 A3 · the browser path applies the same rule', () => {
  it('exports one shared normalizer rather than duplicating the conditional', async () => {
    const { normalizeClaimIdentity } = await import('@/lib/priorityClaims');
    // the property that matters: a dual-key claim NEVER yields a profile identity, so the
    // sibling sweep that identity would drive is unreachable.
    expect(normalizeClaimIdentity({ player_id: 'p1', guest_player_id: 'g1' }).playerId).toBeNull();
    expect(normalizeClaimIdentity({ player_id: 'p1', guest_player_id: null }).playerId).toBe('p1');
  });
});
