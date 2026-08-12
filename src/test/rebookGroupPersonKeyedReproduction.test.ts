// @vitest-environment node
/**
 * `rebook_group_apply` and `rebook_group_manage` had to be reproduced to change how their NEW
 * MEMBERS arrive: the captain's own create-attempt ids in, receipts bound to the slot's owner,
 * legacy guest keys derived inside the definer (owner correction, 2026-08-09 — a browser carries
 * neither guest ids nor person ids for this, only the capabilities it minted itself). Everything
 * else in two long, money-adjacent, anon-reachable functions — the token validation, the paid
 * gate, the keep/decline logic, the capacity guards, the advisory locks — must survive byte for
 * byte.
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
  [/_new_creation_request_ids uuid\[\] DEFAULT '\{\}'::uuid\[\]/, "_new_guest_ids uuid[] DEFAULT '{}'::uuid[]"],
  // 2. the declarations the derivation needs
  [/\n(\s*)rid uuid;\n\s*v_m_group uuid;\n\s*v_m_person uuid;\n\s*v_m_owner_type text;\n\s*v_m_owner_id uuid;\n\s*v_new_guest_ids uuid\[\] := '\{\}';/, ''],
  // 3. the staged-attempt derivation preamble (comment + loop), up to and including its END IF
  [
    /\n {2}-- U2: admit each member ATTEMPT[\s\S]*?\n {2}END IF;\n(?=\n)/,
    '',
  ],
  // 4. the sanitizer wrapper opens...
  [
    /\n {2}-- the 23505 detail of the guest-keyed indexes would hand the DERIVED key to an anonymous\n {2}-- caller; the whole section answers with a name instead \(Codex r2 f9\)\n {2}BEGIN\n {2}IF array_length\(v_new_guest_ids, 1\) IS NOT NULL THEN/,
    '\n  IF array_length(_new_guest_ids, 1) IS NOT NULL THEN',
  ],
  // ...and closes
  [
    /\n {2}END IF;\n {2}EXCEPTION WHEN unique_violation THEN\n {4}RAISE EXCEPTION 'member_already_booked';\n {2}END;/,
    '\n  END IF;',
  ],
  // 5. the loop reads the derived array
  [/FOREACH gid IN ARRAY v_new_guest_ids LOOP/, 'FOREACH gid IN ARRAY _new_guest_ids LOOP'],
];

const MANAGE_ONLY_EDITS: Array<[RegExp, string]> = [
  // manage additionally loads the slot's owner scope (apply already has the slot row `s`)
  [/\n\s*v_scope_academy uuid;\n\s*v_scope_trainer uuid;/, ''],
  [
    /\n {2}-- The claim's slot names the owner scope the staged attempts are bound to\.\n {2}SELECT av\.academy_profile_id, av\.trainer_id INTO v_scope_academy, v_scope_trainer\n {4}FROM public\.availability_slots av WHERE av\.id = c\.slot_id;\n/,
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

  it('no client-supplied identity enters either function — attempts in, receipts checked', () => {
    for (const fn of ['rebook_group_apply', 'rebook_group_manage']) {
      const src = extract(REPRODUCED, fn);
      expect(`${fn} takes attempt ids: ${src.includes('_new_creation_request_ids uuid[]')}`)
        .toBe(`${fn} takes attempt ids: true`);
      expect(`${fn} still takes guest ids: ${/(^|[^A-Za-z0-9_])_new_guest_ids/.test(src)}`)
        .toBe(`${fn} still takes guest ids: false`);
      // the STAGED attempt is the authorization: the group binding is required, and every
      // admission failure answers one indistinguishable refusal (no oracle over known ids)
      expect(src).toContain('rebook_member_attempts');
      expect(src).toContain('v_m_group IS DISTINCT FROM v_group');
      expect(src).toContain(`RAISE EXCEPTION 'unknown_member_attempt'`);
      expect((src.match(/RAISE EXCEPTION 'unknown_member_attempt'/g) ?? []).length).toBe(1);
      expect(src).toContain(`RAISE EXCEPTION 'member_not_in_scope'`);
      // the derivation is internal, and its unique-violation detail never reaches the caller
      expect(src).toContain('person_legacy_source');
      expect(src).toContain(`RAISE EXCEPTION 'member_already_booked'`);
    }
  });

  it('the strip is a real check — a body with a shipped guard removed does NOT pass it', () => {
    const shipped = extract(SHIPPED_APPLY, 'rebook_group_apply');
    const mutated = shipped.replace(/PERFORM pg_advisory_xact_lock\(hashtextextended\(slotrec\.slot_id::text, 0\)\);\n\s*/, '');
    expect(mutated).not.toBe(shipped);
    expect(strip(mutated, COMMON_EDITS)).not.toBe(shipped);
  });
});
