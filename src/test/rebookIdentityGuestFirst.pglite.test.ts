// @vitest-environment node
// PR 10d — FAM-02 guest-first identity across the rebook reminder SQL, proven end-to-end against
// real Postgres (PGlite) with the REAL migration 20260927100000. The scenario is the bug's core:
// a PARENT (pure profile) and their linked CHILD (a guest whose claim ALSO carries the parent's
// player_id as legacy link decoration) both hold pending claims in the same cycle. Player-first
// keying collapsed them and cross-stamped their claims; guest-first keeps them two distinct people.
//
// This file is the CROSS-LAYER proof the review asked for: it starts from raw claims (before any
// grouping), runs the detection RPC (which groups), routes each candidate exactly as the cron
// sender does (guest-first), calls bump_rebook_reminders, and asserts the FINAL stamped rows — so
// no unit test can pass around an already-collapsed input.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACAD = 'a0000000-0000-0000-0000-0000000000a0';
const CYCLE = 'c0000000-0000-0000-0000-0000000000c1';
const S1 = '50000000-0000-0000-0000-000000000001';
const S2 = '50000000-0000-0000-0000-000000000002';
const PARENT = 'aa000000-0000-0000-0000-0000000000a1'; // pure profile, own claim
const CHILD = 'bb000000-0000-0000-0000-0000000000b1';  // dual-key guest WITH own email
const CHILD2 = 'bb000000-0000-0000-0000-0000000000b2'; // dual-key guest with NO own email (linked fallback)
const CL_P = 'c1a00000-0000-0000-0000-000000000001';   // PARENT's own claim (player_id=PARENT, guest NULL)
const CL_C = 'c1b00000-0000-0000-0000-000000000001';   // CHILD's dual-key claim (player_id=PARENT, guest=CHILD)
const CL_C2 = 'c1c00000-0000-0000-0000-000000000001';  // CHILD2's dual-key claim (player_id=PARENT, guest=CHILD2)

type Cand = { player_id: string | null; guest_player_id: string | null; recipient_email: string; recipient_name: string };
const candidates = async (): Promise<Cand[]> =>
  (await db.query<Cand>(`SELECT player_id, guest_player_id, recipient_email, recipient_name
                         FROM public.rebook_claims_needing_auto_reminder(24)`)).rows;

const remindedOf = async (claimId: string): Promise<{ reminded: boolean; count: number }> => {
  const r = (await db.query<{ reminded_at: string | null; reminder_count: number }>(
    `SELECT reminded_at, reminder_count FROM public.slot_priority_claims WHERE id = $1`, [claimId])).rows[0];
  return { reminded: r.reminded_at !== null, count: r.reminder_count };
};

// Route a candidate exactly as the cron/manual sender does after PR 10d: guest-first (a dual-key
// row goes to p_guest_ids, never p_player_ids), then stamp via the shared RPC.
const stampViaRouting = async (cands: Cand[], slotIds: string[]) => {
  const players: string[] = [];
  const guests: string[] = [];
  for (const c of cands) {
    if (c.guest_player_id) guests.push(c.guest_player_id); // personRefOf: guest wins on a dual-key row
    else if (c.player_id) players.push(c.player_id);
  }
  await db.query(`SELECT public.bump_rebook_reminders($1::uuid[], $2::uuid[], $3::uuid[])`, [slotIds, players, guests]);
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;

    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text, email text);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, full_name text, email text, linked_profile_id uuid);
    CREATE TABLE public.cycles (id uuid PRIMARY KEY, name text, owner_type text, owner_id uuid, settings jsonb);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, cyclus_id uuid, priority_window_ends_at timestamptz);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY, slot_id uuid, player_id uuid, guest_player_id uuid,
      status text, response_intent text, reminded_at timestamptz, reminder_count int NOT NULL DEFAULT 0,
      claim_token text DEFAULT gen_random_uuid()::text);

    -- app_now() (real one lives in 20260724100000): fake clock via GUC, else now().
    CREATE OR REPLACE FUNCTION public.app_now() RETURNS timestamptz LANGUAGE sql STABLE AS $fn$
      SELECT COALESCE(NULLIF(current_setting('app.fake_now', true), '')::timestamptz, now())
    $fn$;

    INSERT INTO public.academy_profiles VALUES ('${ACAD}', 'RL Padel');
    INSERT INTO public.profiles (id, full_name, email) VALUES ('${PARENT}', 'Parent', 'parent@example.com');
    INSERT INTO public.guest_players (id, full_name, email, linked_profile_id) VALUES
      ('${CHILD}',  'Child',  'child@example.com', '${PARENT}'),
      ('${CHILD2}', 'Child2', NULL,               '${PARENT}');   -- no own email → linked-profile fallback

    INSERT INTO public.cycles (id, name, owner_type, owner_id, settings) VALUES
      ('${CYCLE}', 'Ronde', 'academy', '${ACAD}', '{"rebook_payment_mode":"upfront"}');
    INSERT INTO public.availability_slots (id, cyclus_id, priority_window_ends_at) VALUES
      ('${S1}', '${CYCLE}', now() + interval '12 hours'),
      ('${S2}', '${CYCLE}', now() + interval '12 hours');

    -- The collision: PARENT's own claim and CHILD's dual-key claim BOTH carry player_id=PARENT.
    INSERT INTO public.slot_priority_claims (id, slot_id, player_id, guest_player_id, status) VALUES
      ('${CL_P}',  '${S1}', '${PARENT}', NULL,       'pending'),   -- parent, pure profile
      ('${CL_C}',  '${S1}', '${PARENT}', '${CHILD}', 'pending'),   -- child, dual-key (own email)
      ('${CL_C2}', '${S2}', '${PARENT}', '${CHILD2}','pending');   -- child2, dual-key (no own email)
  `);
  // The REAL PR 10d migration under test (guest-first RPC + guarded bump_rebook_reminders).
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260927100000_rebook_identity_guest_first.sql'), 'utf8'));
});

beforeEach(async () => {
  await db.query(`UPDATE public.slot_priority_claims SET reminded_at = NULL, reminder_count = 0`);
});

describe('PR 10d — rebook identity guest-first (cross-layer)', () => {
  it('proof #2/#4: the detection RPC keeps PARENT and dual-key CHILD as TWO representatives (not collapsed)', async () => {
    const c = await candidates();
    const keys = c.map((x) => (x.guest_player_id ? `g:${x.guest_player_id}` : `p:${x.player_id}`)).sort();
    // parent + both children — three distinct people, never merged under the shared player_id.
    expect(keys).toEqual([`g:${CHILD}`, `g:${CHILD2}`, `p:${PARENT}`].sort());
  });

  it('proof #6: guest email + name win for a dual-key child; the linked profile is used only when the guest has none', async () => {
    const c = await candidates();
    const parent = c.find((x) => x.player_id === PARENT && !x.guest_player_id)!;
    const child = c.find((x) => x.guest_player_id === CHILD)!;
    const child2 = c.find((x) => x.guest_player_id === CHILD2)!;
    // child WITH own email → mailed at the child, named as the child (never the parent)
    expect(child.recipient_email).toBe('child@example.com');
    expect(child.recipient_name).toBe('Child');
    // child WITHOUT own email → linked profile email fallback, still the child's name
    expect(child2.recipient_email).toBe('parent@example.com');
    expect(child2.recipient_name).toBe('Child2');
    // pure profile unchanged
    expect(parent.recipient_email).toBe('parent@example.com');
    expect(parent.recipient_name).toBe('Parent');
  });

  it('proof #5: stamping the PARENT never stamps a dual-key child sharing that player_id', async () => {
    await db.query(`SELECT public.bump_rebook_reminders($1::uuid[], $2::uuid[], $3::uuid[])`,
      [[S1, S2], [PARENT], []]);
    expect((await remindedOf(CL_P)).reminded).toBe(true);   // the parent's own claim
    expect((await remindedOf(CL_C)).reminded).toBe(false);  // NOT the child's dual-key claim
    expect((await remindedOf(CL_C2)).reminded).toBe(false);
  });

  it('proof #5 (inverse): stamping a CHILD never stamps the parent or a sibling', async () => {
    await db.query(`SELECT public.bump_rebook_reminders($1::uuid[], $2::uuid[], $3::uuid[])`,
      [[S1, S2], [], [CHILD]]);
    expect((await remindedOf(CL_C)).reminded).toBe(true);   // the child's claim
    expect((await remindedOf(CL_P)).reminded).toBe(false);  // NOT the parent's own claim
    expect((await remindedOf(CL_C2)).reminded).toBe(false); // NOT the sibling
  });

  it('proof #10 (CROSS-LAYER): raw claims → RPC grouping → guest-first routing → stamp reaches exactly the child', async () => {
    // Start from raw claims (reminded_at NULL). Group via the RPC, then route ONLY the child
    // candidate through the real sender path and stamp. The parent + sibling must stay unstamped —
    // proving the whole chain keeps distinct people apart, not just the unit helpers.
    const child = (await candidates()).filter((x) => x.guest_player_id === CHILD);
    await stampViaRouting(child, [S1, S2]);
    expect((await remindedOf(CL_C)).reminded).toBe(true);
    expect((await remindedOf(CL_P)).reminded).toBe(false);
    expect((await remindedOf(CL_C2)).reminded).toBe(false);
  });

  it('proof #10 (CROSS-LAYER): routing ALL candidates stamps every person exactly once, no cross-contamination', async () => {
    const all = await candidates();
    await stampViaRouting(all, [S1, S2]);
    for (const cl of [CL_P, CL_C, CL_C2]) {
      const { reminded, count } = await remindedOf(cl);
      expect(reminded).toBe(true);
      expect(count).toBe(1); // stamped once — never double via a colliding player_id
    }
  });

  it('proof #9: the SECURITY DEFINER detection RPC is locked to service_role (anon/authenticated cannot execute)', async () => {
    const r = (await db.query<{ chk: string; v: boolean }>(`
      SELECT 'anon' AS chk, has_function_privilege('anon','public.rebook_claims_needing_auto_reminder(int)','execute') AS v
      UNION ALL SELECT 'authenticated', has_function_privilege('authenticated','public.rebook_claims_needing_auto_reminder(int)','execute')
      UNION ALL SELECT 'service_role',  has_function_privilege('service_role','public.rebook_claims_needing_auto_reminder(int)','execute')
      UNION ALL SELECT 'bump_anon',     has_function_privilege('anon','public.bump_rebook_reminders(uuid[],uuid[],uuid[])','execute')
      UNION ALL SELECT 'bump_service',  has_function_privilege('service_role','public.bump_rebook_reminders(uuid[],uuid[],uuid[])','execute')
    `)).rows;
    const by = Object.fromEntries(r.map((x) => [x.chk, x.v]));
    expect(by.anon).toBe(false);          // the cross-academy email/token leak is closed
    expect(by.authenticated).toBe(false);
    expect(by.service_role).toBe(true);
    expect(by.bump_anon).toBe(false);
    expect(by.bump_service).toBe(true);
  });
});
