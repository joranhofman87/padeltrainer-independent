// @vitest-environment node
// Wiring pin for the rebook-invoice staff notification in mollie-webhook (Codex #4).
//
// The identity DECISION is the tested personDisplayName helper. What this pins is the WIRING
// around it, which a helper test cannot see: personDisplayName keys on the row's IDs, so if the
// payer SELECT omits guest_player_id, every payer resolves as a profile and a guest/child
// booking would again show the parent's name. The load-bearing facts are therefore: the select
// fetches BOTH identity ids, and the name is produced by personDisplayName (not a profile-first
// coalesce).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'supabase', 'functions', 'mollie-webhook', 'index.ts'), 'utf8');

describe('mollie-webhook rebook-invoice staff notification identity wiring', () => {
  it('the payer select fetches BOTH identity ids so personDisplayName can key guest-first', () => {
    // Anchored on the actual select for the rebook payer.
    const m = src.match(/\.select\("player_id, guest_player_id, profiles:player_id\(full_name\), guest_players:guest_player_id\(full_name\)"\)/);
    expect(m, 'the rebook payer select must include player_id AND guest_player_id').toBeTruthy();
  });

  it('the rebook player name is produced by personDisplayName (guest-first), not a profile-first coalesce', () => {
    expect(src).toContain('import { personDisplayName } from "../_shared/person-identity.ts";');
    // the name is derived via the helper with the payer row + both names
    expect(src).toMatch(/personDisplayName\(\s*payer \?\? \{\}/);
    // and the old profile-first coalesce is gone
    expect(src).not.toMatch(/payer\?\.profiles\?\.full_name \?\? payer\?\.guest_players/);
  });
});
