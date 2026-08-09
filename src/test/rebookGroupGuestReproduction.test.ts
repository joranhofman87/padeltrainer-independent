// @vitest-environment node
/**
 * `create_rebook_group_guest` had to be reproduced to change four lines in the middle of it: the
 * token validation, the four contact guards and the rate-limit block all had to survive byte for
 * byte, because they are the authorization for an endpoint `anon` can reach.
 *
 * "Byte for byte" is not something a reviewer can verify by reading a wall of unchanged SQL, so a
 * machine does it: strip the U2 changes out of the new definition and what remains must be
 * IDENTICAL to the shipped one. A dropped guard, a weakened rate limit or a reordered check fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SHIPPED = 'supabase/migrations/20260705110000_rebook_group_guest_required_contact.sql';
const REPRODUCED = 'supabase/migrations/20261124100000_u2_rebook_group_guest_uuid_create.sql';

function extract(file: string): string {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf('CREATE OR REPLACE FUNCTION public.create_rebook_group_guest');
  expect(`${file} defines it: ${start >= 0}`).toBe(`${file} defines it: true`);
  const end = src.indexOf('\n$$;', start);
  return src.slice(start, end + '\n$$;'.length);
}

/** The three edits, each anchored so it cannot silently absorb neighbouring lines. */
const EDITS: Array<[RegExp, string]> = [
  // 1. the signature gains the attempt id
  [
    /,\n {2}-- The captain's own id for THIS add-a-member attempt[\s\S]*?\n {2}_creation_request_id uuid DEFAULT NULL\n\)/,
    '\n)',
  ],
  // 2. the declaration gains one variable
  [/\n {2}v_result jsonb;/, ''],
  // 3. the attempt id is required, checked next to the token and scope validation
  [/\n {2}IF _creation_request_id IS NULL THEN RAISE EXCEPTION 'creation_request_id_required'; END IF;/, ''],
  // 4. only a genuinely NEW attempt is rate-limited (a replay creates nobody)
  [
    /\n {2}-- Only a genuinely NEW attempt is counted[\s\S]*?\n {2}IF NOT EXISTS \(SELECT 1 FROM public\.player_create_commands\n\s+WHERE creation_request_id = _creation_request_id\) THEN\n/,
    '\n',
  ],
  [/\n {2}END IF;\n\n {2}v_full :=/, '\n\n  v_full :='],
  // 5. the lookup-then-insert becomes one call to the shared mechanism
  [
    /\n\n {2}-- The Player is CREATED, through the one mechanism[\s\S]*?\n {2}RETURN v_id;/,
    `

  -- Dedup by email within the same owner scope (mirrors resolveOrCreateGuestPlayer's core).
  IF v_email IS NOT NULL THEN
    SELECT id INTO v_id FROM public.guest_players
    WHERE lower(email) = v_email
      AND ((s.academy_profile_id IS NOT NULL AND academy_profile_id = s.academy_profile_id)
        OR (s.academy_profile_id IS NULL AND trainer_id = s.trainer_id))
    LIMIT 1;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  INSERT INTO public.guest_players (academy_profile_id, trainer_id, first_name, last_name, full_name, email, phone, source)
  VALUES (s.academy_profile_id, CASE WHEN s.academy_profile_id IS NULL THEN s.trainer_id ELSE NULL END,
          v_first, v_last, v_full, v_email, v_phone, 'rebook_group')
  RETURNING id INTO v_id;

  RETURN v_id;`,
  ],
];

const stripToShipped = (reproduced: string) =>
  EDITS.reduce((acc, [re, replacement]) => acc.replace(re, replacement), reproduced);

describe('the reproduced create_rebook_group_guest keeps everything that authorizes it', () => {
  it('strips back to the shipped body byte for byte', () => {
    expect(stripToShipped(extract(REPRODUCED))).toBe(extract(SHIPPED));
  });

  it('the guards an anonymous caller is held to are all still there', () => {
    // Named individually as well as covered by the byte comparison: if the reproduction is ever
    // re-derived, these are the lines whose loss would matter most, and the failure should say so.
    const reproduced = extract(REPRODUCED);
    for (const guard of [
      "IF v_first IS NULL THEN RAISE EXCEPTION 'first_name_required'",
      "IF v_last  IS NULL THEN RAISE EXCEPTION 'last_name_required'",
      "IF v_email IS NULL THEN RAISE EXCEPTION 'email_required'",
      "IF v_phone IS NULL THEN RAISE EXCEPTION 'phone_required'",
      "IF c.id IS NULL OR c.rebook_group_id IS NULL THEN RAISE EXCEPTION 'invalid_token'",
      "RAISE EXCEPTION 'slot_unscoped'",
      "IF v_rl_count > 10 THEN",
    ]) {
      expect(`${guard}: ${reproduced.includes(guard)}`).toBe(`${guard}: true`);
    }
  });

  it('the address no longer chooses the Player', () => {
    const reproduced = extract(REPRODUCED);
    expect(reproduced).not.toMatch(/lower\(email\)\s*=\s*v_email/);
    expect(reproduced).not.toMatch(/INSERT INTO public\.guest_players/);
    expect(reproduced).toContain('player_create_execute');
    expect(reproduced).toContain('_creation_request_id');
  });

  it('the strip is a real check — a shipped body with a guard removed does NOT pass it', () => {
    const shipped = extract(SHIPPED);
    const mutated = shipped.replace("IF v_email IS NULL THEN RAISE EXCEPTION 'email_required'; END IF;\n", '');
    expect(mutated).not.toBe(shipped);
    expect(stripToShipped(mutated)).not.toBe(shipped);
  });
});
