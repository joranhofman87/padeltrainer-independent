// @vitest-environment node
//
// ABC-20 items 2/4/5 — the money and hold boundaries, exercised through the real RPCs.
//
// THE ADVERSARIAL SHAPE these are built around: two DIFFERENT guests carrying the SAME stale
// `player_id`. That is what the historical signup linker produced, and it is what profile-first
// resolution collapses — two people become one member, one key, one seat.
//
// service_role is used deliberately in places: these paths run without RLS, so RLS must not be
// treated as the boundary that saves them.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { applyPreH0, applyH0, FIXTURE_SQL, IDS } from './abc16Fixture';

let db: PGlite;

const STALE_PROFILE = IDS.bookedProfile;          // the legacy player_id both guests carry
const GUEST_A = '2f000000-0000-4000-8000-0000000000a1';
const GUEST_B = '2f000000-0000-4000-8000-0000000000a2';
const PURE_PROFILE = IDS.nascentProfile;
const PURE_USER = IDS.nascentUser;
/** bookedProfile ships account-less; give it a login so the caller genuinely IS that profile. */
const STALE_USER = '6f000000-0000-4000-8000-0000000000a1';

const GROUP = '4f000000-0000-4000-8000-000000000001';
const SLOT = '3f000000-0000-4000-8000-000000000001';
const CYCLUS = '9f000000-0000-4000-8000-000000000001';

const TOK_A = 'tok-guest-a';
const TOK_B = 'tok-guest-b';
const TOK_PURE = 'tok-pure';

beforeAll(async () => {
  db = new PGlite();
  const exec = (sql: string) => db.exec(sql);
  await applyPreH0(exec);
  await db.exec(FIXTURE_SQL);
  await applyH0(exec);

  await db.exec(`
    INSERT INTO public.cycles (id, owner_type, owner_id, type)
      VALUES ('${CYCLUS}', 'academy', '${IDS.attackerAcademy}', 'cyclus');
    INSERT INTO public.availability_slots (id, academy_profile_id, cyclus_id, max_participants, start_time)
      VALUES ('${SLOT}', '${IDS.attackerAcademy}', '${CYCLUS}', 4, now() + interval '5 days');

    -- TWO DIFFERENT GUESTS sharing ONE stale player_id — the collapse case.
    INSERT INTO public.guest_players (id, full_name, academy_profile_id, linked_profile_id) VALUES
      ('${GUEST_A}', 'Guest Alpha', '${IDS.attackerAcademy}', '${STALE_PROFILE}'),
      ('${GUEST_B}', 'Guest Beta',  '${IDS.attackerAcademy}', '${STALE_PROFILE}');

    -- one group: two dual-key guest claims + one genuine pure-profile member
    INSERT INTO public.slot_priority_claims
      (slot_id, player_id, guest_player_id, rebook_group_id, status, claim_token) VALUES
      ('${SLOT}', '${STALE_PROFILE}', '${GUEST_A}',  '${GROUP}', 'pending', '${TOK_A}'),
      ('${SLOT}', '${STALE_PROFILE}', '${GUEST_B}',  '${GROUP}', 'pending', '${TOK_B}'),
      ('${SLOT}', '${PURE_PROFILE}',  NULL,          '${GROUP}', 'pending', '${TOK_PURE}');
  `);
}, 120_000);

const groupByToken = async (token: string) => {
  const r = await db.query<{ v: { members?: Array<{ key: string; is_self: boolean }> } | null }>(
    `SELECT public.get_rebook_group_by_token($1) AS v`, [token]);
  return r.rows[0].v;
};

describe('ABC-20 item 5 · get_rebook_group_by_token keys guest-first', () => {
  it('two guests sharing one stale player_id are TWO members, not one', async () => {
    const g = await groupByToken(TOK_A);
    const keys = (g?.members ?? []).map((m) => m.key).sort();
    expect(keys).toContain(`g:${GUEST_A}`);
    expect(keys).toContain(`g:${GUEST_B}`);
    // the stale profile must NOT appear as a member key for either guest
    expect(keys).not.toContain(`p:${STALE_PROFILE}`);
    expect(new Set(keys).size).toBe(keys.length);           // no collapse
  });

  it('a genuine pure-profile member still keys p:<uuid>', async () => {
    const g = await groupByToken(TOK_PURE);
    expect((g?.members ?? []).map((m) => m.key)).toContain(`p:${PURE_PROFILE}`);
  });

  it('is_self identifies the CALLING guest, not the shared profile', async () => {
    const a = await groupByToken(TOK_A);
    const selfA = (a?.members ?? []).filter((m) => m.is_self).map((m) => m.key);
    expect(selfA).toEqual([`g:${GUEST_A}`]);

    const b = await groupByToken(TOK_B);
    const selfB = (b?.members ?? []).filter((m) => m.is_self).map((m) => m.key);
    expect(selfB).toEqual([`g:${GUEST_B}`]);
  });
});

describe('ABC-20 item 5 · rebook_group_apply / manage match guest-first', () => {
  const keepOnlyProfile = (fn: 'rebook_group_apply' | 'rebook_group_manage', token: string) =>
    db.query(
      fn === 'rebook_group_apply'
        ? `SELECT public.rebook_group_apply($1, $2::jsonb, $3::uuid[]) AS v`
        : `SELECT public.rebook_group_manage($1, $2::jsonb, $3::uuid[], NULL) AS v`,
      [token, JSON.stringify({}), [STALE_PROFILE]],
    );

  it('keeping by the stale PROFILE id does not sweep either guest\'s claim', async () => {
    // Under raw-player OR matching both dual-key claims matched through the player arm, so a
    // keep/remove aimed at the profile silently decided the guests' seats.
    await keepOnlyProfile('rebook_group_apply', TOK_A).catch(() => undefined);
    const rows = await db.query<{ guest_player_id: string; status: string }>(
      `SELECT guest_player_id, status FROM public.slot_priority_claims
        WHERE rebook_group_id = $1 AND guest_player_id IS NOT NULL`, [GROUP]);
    // neither guest was booked/removed by a profile-keyed instruction
    expect(rows.rows.every((r) => r.status === 'pending')).toBe(true);
  });

  it('no booking was created for either guest by the profile-keyed apply', async () => {
    const b = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.bookings
        WHERE guest_player_id IN ($1, $2)`, [GUEST_A, GUEST_B]);
    expect(b.rows[0].n).toBe(0);
  });
});

describe('ABC-20 item 4 · release_rebook_hold requires a PURE-PROFILE hold', () => {
  const DUAL_HOLD = '5f000000-0000-4000-8000-000000000001';
  const PURE_HOLD = '5f000000-0000-4000-8000-000000000002';

  beforeAll(async () => {
    await db.exec(`
      INSERT INTO public.bookings (id, slot_id, player_id, guest_player_id, status) VALUES
        ('${DUAL_HOLD}', '${SLOT}', '${STALE_PROFILE}', '${GUEST_A}', 'payment_pending'),
        ('${PURE_HOLD}', '${SLOT}', '${PURE_PROFILE}',  NULL,        'payment_pending');
      INSERT INTO auth.users (id, email) VALUES ('${PURE_USER}', 'pure@example.test')
        ON CONFLICT (id) DO NOTHING;
      -- The stale profile must resolve to a REAL logged-in account, or release_rebook_hold
      -- refuses with 'no_profile' and the test would pass without ever reaching the guest
      -- check it exists to prove.
      INSERT INTO auth.users (id, email) VALUES ('${STALE_USER}', 'stale@example.test')
        ON CONFLICT (id) DO NOTHING;
      UPDATE public.profiles SET user_id = '${STALE_USER}' WHERE id = '${STALE_PROFILE}';
    `);
  });

  const release = async (uid: string, bookingId: string) => {
    await db.query(`SELECT set_config('abc16.uid', $1, false)`, [uid]);
    const r = await db.query<{ v: { ok: boolean; reason?: string; released?: boolean } }>(
      `SELECT public.release_rebook_hold($1::uuid) AS v`, [bookingId]);
    return r.rows[0].v;
  };

  it('the stale profile CANNOT release the guest\'s dual-key hold', async () => {
    const r = await release(STALE_USER, DUAL_HOLD);
    expect(r).toMatchObject({ ok: false, reason: 'not_yours' });

    const still = await db.query<{ status: string }>(
      `SELECT status FROM public.bookings WHERE id = $1`, [DUAL_HOLD]);
    expect(still.rows[0].status).toBe('payment_pending');   // the guest's seat survives
  });

  it('a profile CAN still release its own pure-profile hold', async () => {
    const r = await release(PURE_USER, PURE_HOLD);
    expect(r).toMatchObject({ ok: true, released: true });
    const after = await db.query<{ status: string }>(
      `SELECT status FROM public.bookings WHERE id = $1`, [PURE_HOLD]);
    expect(after.rows[0].status).toBe('cancelled');
  });

  it('an unrelated profile still cannot release someone else\'s pure hold', async () => {
    await db.exec(`
      INSERT INTO public.bookings (id, slot_id, player_id, guest_player_id, status)
      VALUES ('5f000000-0000-4000-8000-000000000003', '${SLOT}', '${PURE_PROFILE}', NULL, 'payment_pending');
    `);
    const r = await release(IDS.attackerUser, '5f000000-0000-4000-8000-000000000003');
    expect(r.ok).toBe(false);
  });
});

describe('ABC-20 · discriminating guards — the removed shapes must not come back', () => {
  it('no group RPC keys a member profile-first', async () => {
    const r = await db.query<{ proname: string }>(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public'
         AND p.proname IN ('get_rebook_group_by_token','rebook_group_apply','rebook_group_manage')
         AND p.prosrc ~ 'player_id IS NOT NULL THEN ''p:'`);
    expect(r.rows).toEqual([]);
  });

  it('no group RPC uses raw-player OR matching', async () => {
    const r = await db.query<{ proname: string }>(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public'
         AND p.proname IN ('rebook_group_apply','rebook_group_manage')
         AND p.prosrc ~ 'player_id = ANY\\(v_keep_player\\)\\)\\s*\\n\\s*OR \\('`);
    expect(r.rows).toEqual([]);
  });

  it('release_rebook_hold refuses any guest-bearing hold', async () => {
    const r = await db.query<{ ok: boolean }>(`
      SELECT (p.prosrc ~ 'v_booking\\.guest_player_id IS NOT NULL') AS ok
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='release_rebook_hold'`);
    expect(r.rows[0].ok).toBe(true);
  });
});
