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

// Split a PostgREST select() argument into its TOP-LEVEL columns, paren-aware so an embedded
// resource like `profiles:player_id(full_name)` stays one element and is never mistaken for the
// scalar `player_id` column. Lets us assert the load-bearing FACTS (which scalar ids are fetched)
// instead of pinning the whole string byte-for-byte — so a harmless reorder or an added column
// (e.g. the Phase-3 person_id dual-write) does not spuriously break the pin.
function topLevelColumns(select: string): string[] {
  const cols: string[] = [];
  let depth = 0, cur = '';
  for (const ch of select) {
    if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { cols.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) cols.push(cur.trim());
  return cols;
}

// Isolate the ACTUAL rebook payer query — from("bookings").select(…).eq("id", booking_ids[0]) —
// and return its top-level columns. Fails loudly if the query shape moves.
function rebookPayerSelectColumns(): string[] {
  const m = src.match(
    /\.from\("bookings"\)\s*\.select\("([^"]*)"\)\s*\.eq\("id",\s*invoiceData\.booking_ids\[0\]\)/,
  );
  expect(m, 'the rebook payer query must select from bookings and filter by invoiceData.booking_ids[0]').toBeTruthy();
  return topLevelColumns(m![1]);
}

describe('mollie-webhook rebook-invoice staff notification identity wiring', () => {
  it('the payer select fetches BOTH scalar identity ids so personDisplayName can key guest-first', () => {
    const cols = rebookPayerSelectColumns();
    // The SCALAR columns are load-bearing: person-identity keys on row.guest_player_id / row.player_id,
    // which the embedded joins (profiles:player_id(…), guest_players:guest_player_id(…)) do NOT expose.
    // toContain requires an exact top-level element, so `profiles:player_id(full_name)` does not satisfy it.
    expect(cols, 'scalar player_id must be selected').toContain('player_id');
    expect(cols, 'scalar guest_player_id must be selected (else every payer resolves as a profile)').toContain('guest_player_id');
    // and both name joins, so personDisplayName has a name for whichever identity the row carries
    expect(cols.some(c => /^profiles:player_id\(/.test(c)), 'profile name join').toBe(true);
    expect(cols.some(c => /^guest_players:guest_player_id\(/.test(c)), 'guest name join').toBe(true);
  });

  it('the rebook player name is produced by personDisplayName (guest-first), not a profile-first coalesce', () => {
    expect(src).toContain('import { personDisplayName } from "../_shared/person-identity.ts";');
    // the name is derived via the helper with the payer row + both names
    expect(src).toMatch(/personDisplayName\(\s*payer \?\? \{\}/);
    // and the old profile-first coalesce is gone
    expect(src).not.toMatch(/payer\?\.profiles\?\.full_name \?\? payer\?\.guest_players/);
  });
});
