// @vitest-environment node
/**
 * `rebook_group_apply` and `rebook_group_manage` had to be reproduced to change how their NEW
 * MEMBERS arrive: canonical person ids in, legacy guest ids derived inside the definer (owner
 * correction, 2026-08-09 — a browser must never carry a guest id, so the old `_new_guest_ids`
 * parameter is gone). Everything else in two long, money-adjacent, anon-reachable functions — the
 * token validation, the paid gate, the keep/decline logic, the capacity guards, the advisory
 * locks — must survive byte for byte.
 *
 * A machine checks that: strip exactly the person-keyed edits out of the new definitions and what
 * remains must be IDENTICAL to the shipped ones. A dropped guard, a weakened capacity check or a
 * reordered lock fails the comparison.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const REPRODUCED = 'supabase/migrations/20261128100000_u2_rebook_person_keyed_members.sql';
const SHIPPED_APPLY = 'supabase/migrations/20260804100000_rebook_stuck_claim_sweep_and_upfront_apply_guard.sql';
const SHIPPED_MANAGE = 'supabase/migrations/20260706170000_p2_3_rebook_group_manage_scope.sql';

function extract(file: string, fn: string): string {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}`);
  expect(`${file} defines ${fn}: ${start >= 0}`).toBe(`${file} defines ${fn}: true`);
  const end = src.indexOf('\n$$;', start);
  return src.slice(start, end + '\n$$;'.length);
}

/** The person-keyed edits, each anchored so it cannot silently absorb neighbouring lines. */
const COMMON_EDITS: Array<[RegExp, string]> = [
  // 1. the signature parameter
  [/_new_person_ids uuid\[\] DEFAULT '\{\}'::uuid\[\]/, "_new_guest_ids uuid[] DEFAULT '{}'::uuid[]"],
  // 2. the declarations the derivation needs
  [/\n(\s*)pid uuid;\n\s*v_new_guest_ids uuid\[\] := '\{\}';/, ''],
  // 3. the derivation preamble (comment + loop), up to and including its END IF
  [
    /\n {2}-- U2: derive the legacy guest ids from the canonical persons[\s\S]*?\n {2}END IF;\n(?=\n\s*(--|IF array_length\(v_new_guest_ids))/,
    '',
  ],
  // 4. the two reads of the derived array go back to the parameter
  [/IF array_length\(v_new_guest_ids, 1\) IS NOT NULL THEN/, 'IF array_length(_new_guest_ids, 1) IS NOT NULL THEN'],
  [/FOREACH gid IN ARRAY v_new_guest_ids LOOP/, 'FOREACH gid IN ARRAY _new_guest_ids LOOP'],
];

const MANAGE_ONLY_EDITS: Array<[RegExp, string]> = [
  // manage additionally loads the slot's owner scope (apply already has the slot row `s`)
  [/\n\s*v_scope_academy uuid;\n\s*v_scope_trainer uuid;/, ''],
  [
    /\n {2}-- The claim's slot names the owner scope the derivation is bound to\.\n {2}SELECT av\.academy_profile_id, av\.trainer_id INTO v_scope_academy, v_scope_trainer\n {4}FROM public\.availability_slots av WHERE av\.id = c\.slot_id;\n/,
    '',
  ],
];

const strip = (src: string, edits: Array<[RegExp, string]>) =>
  edits.reduce((acc, [re, replacement]) => acc.replace(re, replacement), src);

describe('the person-keyed rebook functions keep every shipped guard byte for byte', () => {
  it('rebook_group_apply strips back to the shipped body', () => {
    const stripped = strip(extract(REPRODUCED, 'rebook_group_apply'), COMMON_EDITS);
    expect(stripped).toBe(extract(SHIPPED_APPLY, 'rebook_group_apply'));
  });

  it('rebook_group_manage strips back to the shipped body', () => {
    const stripped = strip(
      extract(REPRODUCED, 'rebook_group_manage'),
      [...MANAGE_ONLY_EDITS, ...COMMON_EDITS],
    );
    expect(stripped).toBe(extract(SHIPPED_MANAGE, 'rebook_group_manage'));
  });

  it('no client-supplied guest id enters either function', () => {
    for (const fn of ['rebook_group_apply', 'rebook_group_manage']) {
      const src = extract(REPRODUCED, fn);
      expect(`${fn} takes person ids: ${src.includes('_new_person_ids uuid[]')}`)
        .toBe(`${fn} takes person ids: true`);
      expect(`${fn} still takes guest ids: ${/(^|[^A-Za-z0-9_])_new_guest_ids/.test(src)}`)
        .toBe(`${fn} still takes guest ids: false`);
      // the derivation is scoped and refuses rather than skips
      expect(src).toContain('person_legacy_source');
      expect(src).toContain(`RAISE EXCEPTION 'person_not_in_scope'`);
    }
  });

  it('the strip is a real check — a body with a shipped guard removed does NOT pass it', () => {
    const shipped = extract(SHIPPED_APPLY, 'rebook_group_apply');
    const mutated = shipped.replace(/PERFORM pg_advisory_xact_lock\(hashtextextended\(slotrec\.slot_id::text, 0\)\);\n\s*/, '');
    expect(mutated).not.toBe(shipped);
    expect(strip(mutated, COMMON_EDITS)).not.toBe(shipped);
  });
});
