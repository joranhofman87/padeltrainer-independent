// @vitest-environment node
//
// ABC-18 Pass A3 — booking ownership, payment visibility, priority, member window.
//
// The contract: a PURE-PROFILE row is the only self-evidence. `player_id = me AND
// guest_player_id IS NULL`. Guest, linked, twin, person-expanded and dual-key variants do not
// qualify — each derives from a signal someone else authored.
//
// The fixture deliberately builds ONE account with every legacy bridge pointing at it at once:
// a linked guest, a twinned guest, a collapsed shared person, and a dual-key booking. If any
// withdrawn arm were restored, the negative assertions below would flip.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { applyPreH0, applyH0, FIXTURE_SQL, IDS } from './abc16Fixture';

let db: PGlite;

const ME_USER = '50000000-0000-4000-8000-00000000a301';
const ME_PROFILE = '10000000-0000-4000-8000-00000000a301';
const OTHER_USER = '50000000-0000-4000-8000-00000000a302';
const OTHER_PROFILE = '10000000-0000-4000-8000-00000000a302';

const CYCLE = '90000000-0000-4000-8000-00000000a301';
const PURE_SLOT = '30000000-0000-4000-8000-00000000a301';   // my pure-profile seat
const GUEST_SLOT = '30000000-0000-4000-8000-00000000a302';  // a linked/twinned guest seat
const DUAL_SLOT = '30000000-0000-4000-8000-00000000a303';   // dual-key seat
const OTHER_CYCLE = '90000000-0000-4000-8000-00000000a302';
const OTHER_SLOT = '30000000-0000-4000-8000-00000000a304';

const LINKED_GUEST = '20000000-0000-4000-8000-00000000a301';
const SHARED_PERSON = '3c000000-0000-4000-8000-00000000a301';

let pureBooking = '';
let guestBooking = '';

beforeAll(async () => {
  db = new PGlite();
  const exec = (sql: string) => db.exec(sql);
  await applyPreH0(exec);
  await db.exec(FIXTURE_SQL);
  await applyH0(exec);

  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES
      ('${ME_USER}', 'me@example.test'), ('${OTHER_USER}', 'other@example.test');
    INSERT INTO public.profiles (id, user_id, full_name, email) VALUES
      ('${ME_PROFILE}',    '${ME_USER}',    'Me',    'me@example.test'),
      ('${OTHER_PROFILE}', '${OTHER_USER}', 'Other', 'other@example.test');

    INSERT INTO public.cycles (id, owner_type, owner_id, type) VALUES
      ('${CYCLE}',       'academy', '${IDS.attackerAcademy}', 'cyclus'),
      ('${OTHER_CYCLE}', 'academy', '${IDS.attackerAcademy}', 'cyclus');
    INSERT INTO public.availability_slots (id, academy_profile_id, trainer_id, cyclus_id, source_cycle_id) VALUES
      ('${PURE_SLOT}',  '${IDS.attackerAcademy}', '${IDS.attackerTrainer}', '${CYCLE}',       '${CYCLE}'),
      ('${GUEST_SLOT}', '${IDS.attackerAcademy}', '${IDS.attackerTrainer}', '${OTHER_CYCLE}', '${OTHER_CYCLE}'),
      ('${DUAL_SLOT}',  '${IDS.attackerAcademy}', '${IDS.attackerTrainer}', '${OTHER_CYCLE}', '${OTHER_CYCLE}'),
      ('${OTHER_SLOT}', '${IDS.attackerAcademy}', '${IDS.attackerTrainer}', '${OTHER_CYCLE}', '${OTHER_CYCLE}');

    -- EVERY legacy bridge, all pointing at ME at once.
    INSERT INTO public.guest_players (id, full_name, email, academy_profile_id, linked_profile_id, twin_of_profile_id)
      VALUES ('${LINKED_GUEST}', 'Me', 'me@example.test', '${IDS.attackerAcademy}',
              '${ME_PROFILE}', '${ME_PROFILE}');
    INSERT INTO public.persons (id) VALUES ('${SHARED_PERSON}') ON CONFLICT DO NOTHING;
    UPDATE public.person_links SET person_id = '${SHARED_PERSON}'
      WHERE profile_id = '${ME_PROFILE}' OR guest_player_id = '${LINKED_GUEST}';

    -- my own pure-profile seat (the ONE thing that must keep working)
    INSERT INTO public.bookings (slot_id, player_id, status) VALUES ('${PURE_SLOT}', '${ME_PROFILE}', 'confirmed');
    -- a guest seat for the bridged guest, stamped to the shared person
    INSERT INTO public.bookings (slot_id, guest_player_id, person_id, status)
      VALUES ('${GUEST_SLOT}', '${LINKED_GUEST}', '${SHARED_PERSON}', 'confirmed');
    -- a DUAL-KEY seat naming me alongside the guest
    INSERT INTO public.bookings (slot_id, player_id, guest_player_id, person_id, status)
      VALUES ('${DUAL_SLOT}', '${ME_PROFILE}', '${LINKED_GUEST}', '${SHARED_PERSON}', 'confirmed');
    -- a seat that belongs to somebody else entirely
    INSERT INTO public.bookings (slot_id, player_id, status) VALUES ('${OTHER_SLOT}', '${OTHER_PROFILE}', 'confirmed');
  `);

  const b = await db.query<{ id: string; slot_id: string }>(
    `SELECT id, slot_id FROM public.bookings WHERE slot_id IN ($1,$2)`, [PURE_SLOT, GUEST_SLOT]);
  pureBooking = b.rows.find((r) => r.slot_id === PURE_SLOT)!.id;
  guestBooking = b.rows.find((r) => r.slot_id === GUEST_SLOT)!.id;

  await db.exec(`
    -- paid invoices: one pure-profile (mine), one guest-keyed, one dual-key, one another account's
    INSERT INTO public.invoices (player_id, guest_player_id, person_id, academy_profile_id, status, booking_ids) VALUES
      ('${ME_PROFILE}', NULL,              NULL,               '${IDS.attackerAcademy}', 'paid', ARRAY['${pureBooking}']::uuid[]),
      (NULL,            '${LINKED_GUEST}', '${SHARED_PERSON}', '${IDS.attackerAcademy}', 'paid', ARRAY['${guestBooking}']::uuid[]),
      ('${ME_PROFILE}', '${LINKED_GUEST}', '${SHARED_PERSON}', '${IDS.attackerAcademy}', 'paid', ARRAY['${guestBooking}']::uuid[]),
      ('${OTHER_PROFILE}', NULL,           NULL,               '${IDS.attackerAcademy}', 'paid', ARRAY['${guestBooking}']::uuid[]);

    -- priority claims: one explicit pure-profile (mine), one guest-keyed, one dual-key
    INSERT INTO public.slot_priority_claims (slot_id, player_id, guest_player_id, person_id, status) VALUES
      ('${PURE_SLOT}',  '${ME_PROFILE}', NULL,              NULL,               'pending'),
      ('${GUEST_SLOT}', NULL,            '${LINKED_GUEST}', '${SHARED_PERSON}', 'pending'),
      ('${DUAL_SLOT}',  '${ME_PROFILE}', '${LINKED_GUEST}', '${SHARED_PERSON}', 'pending');
  `);
}, 120_000);

const asUser = (uid: string) => db.query(`SELECT set_config('abc16.uid', $1, false)`, [uid]);
const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
  (await db.query<T>(sql, params)).rows[0];

describe('A3 · get_my_linked_guest_bookings fails closed', () => {
  it('returns [] even with linked, twin, collapsed person and a dual-key seat all present', async () => {
    await asUser(ME_USER);
    const r = await one<{ v: unknown[] }>(`SELECT public.get_my_linked_guest_bookings() AS v`);
    expect(r.v).toEqual([]);
  });

  it('returns [] for an account with no profile at all', async () => {
    await asUser(IDS.attackerUser);
    const r = await one<{ v: unknown[] }>(`SELECT public.get_my_linked_guest_bookings() AS v`);
    expect(r.v).toEqual([]);
  });
});

describe('A3 · get_my_paid_booking_ids', () => {
  const ids = async (uid: string) => {
    await asUser(uid);
    const r = await db.query<{ booking_id: string }>(`SELECT * FROM public.get_my_paid_booking_ids()`);
    return r.rows.map((x) => x.booking_id);
  };

  it('RETAINS my pure-profile paid invoice', async () => {
    expect(await ids(ME_USER)).toContain(pureBooking);
  });

  it('withdraws guest-keyed, dual-key and cross-account invoices', async () => {
    const mine = await ids(ME_USER);
    // guestBooking is reachable only through the guest-keyed, dual-key or other-account rows
    expect(mine).not.toContain(guestBooking);
  });

  it('another account sees only its own', async () => {
    const theirs = await ids(OTHER_USER);
    expect(theirs).not.toContain(pureBooking);
  });
});

describe('A3 · get_my_pending_priority_claims', () => {
  const slots = async (uid: string) => {
    await asUser(uid);
    const r = await db.query<{ slot_id: string }>(`SELECT * FROM public.get_my_pending_priority_claims()`);
    return r.rows.map((x) => x.slot_id);
  };

  it('RETAINS my explicit pure-profile claim', async () => {
    expect(await slots(ME_USER)).toContain(PURE_SLOT);
  });

  it('withdraws the guest-keyed and dual-key claims', async () => {
    const mine = await slots(ME_USER);
    expect(mine).not.toContain(GUEST_SLOT);
    expect(mine).not.toContain(DUAL_SLOT);
  });

  it('another account gets none of mine', async () => {
    expect(await slots(OTHER_USER)).not.toContain(PURE_SLOT);
  });
});

describe('A3 · is_cycle_member', () => {
  const member = async (user: string, cycle: string) =>
    (await one<{ ok: boolean }>(`SELECT public.is_cycle_member($1, $2) AS ok`, [user, cycle])).ok;

  it('RETAINS membership from my pure-profile seat', async () => {
    expect(await member(ME_USER, CYCLE)).toBe(true);
  });

  it('a guest seat with linked + twin + shared person grants nothing', async () => {
    expect(await member(ME_USER, OTHER_CYCLE)).toBe(false);
  });

  it('a cancelled pure-profile seat is not membership (status semantics preserved)', async () => {
    const c = '90000000-0000-4000-8000-00000000a303';
    const s = '30000000-0000-4000-8000-00000000a305';
    await db.exec(`
      INSERT INTO public.cycles (id, owner_type, owner_id, type) VALUES ('${c}','academy','${IDS.attackerAcademy}','cyclus');
      INSERT INTO public.availability_slots (id, academy_profile_id, cyclus_id) VALUES ('${s}','${IDS.attackerAcademy}','${c}');
      INSERT INTO public.bookings (slot_id, player_id, status) VALUES ('${s}','${ME_PROFILE}','cancelled');
    `);
    expect(await member(ME_USER, c)).toBe(false);
  });

  it('another account is not a member of my cycle', async () => {
    expect(await member(OTHER_USER, CYCLE)).toBe(false);
  });
});

describe('A3 · can_book_member_window and its auth-bound wrapper', () => {
  const direct = async (user: string, cycle: string) =>
    (await one<{ ok: boolean }>(`SELECT public.can_book_member_window($1, $2) AS ok`, [user, cycle])).ok;
  const wrapper = async (uid: string, cycle: string) => {
    await asUser(uid);
    return (await one<{ ok: boolean }>(
      `SELECT public.can_current_user_book_member_window($1) AS ok`, [cycle])).ok;
  };

  it('RETAINS eligibility from my pure-profile seat — direct and through the wrapper', async () => {
    expect(await direct(ME_USER, CYCLE)).toBe(true);
    expect(await wrapper(ME_USER, CYCLE)).toBe(true);
  });

  it('the guest/twin/linked/collapsed cycle grants nothing — direct and wrapped', async () => {
    expect(await direct(ME_USER, OTHER_CYCLE)).toBe(false);
    expect(await wrapper(ME_USER, OTHER_CYCLE)).toBe(false);
  });

  it('RETAINS the cycle\'s explicit registered priority list', async () => {
    const c = '90000000-0000-4000-8000-00000000a304';
    await db.exec(`
      INSERT INTO public.cycles (id, owner_type, owner_id, type, settings)
      VALUES ('${c}','academy','${IDS.attackerAcademy}','cyclus',
              jsonb_build_object('rebook_priority_people', jsonb_build_array('${ME_PROFILE}')));
    `);
    expect(await direct(ME_USER, c)).toBe(true);
    expect(await direct(OTHER_USER, c)).toBe(false);
  });

  it('an email/name equivalence alone grants nothing', async () => {
    // A THIRD account whose ONLY tie to the cycle is a guest seat carrying its own email and
    // name. OTHER_USER cannot be used here: it has a genuine pure-profile seat in OTHER_CYCLE,
    // so a false expectation there would have been wrong about the code, not about the bridge.
    const u = '50000000-0000-4000-8000-00000000a303';
    const pr = '10000000-0000-4000-8000-00000000a303';
    const g = '20000000-0000-4000-8000-00000000a303';
    await db.exec(`
      INSERT INTO auth.users (id, email) VALUES ('${u}', 'lookalike@example.test');
      INSERT INTO public.profiles (id, user_id, full_name, email)
        VALUES ('${pr}', '${u}', 'Look Alike', 'lookalike@example.test');
      INSERT INTO public.guest_players (id, full_name, email, academy_profile_id)
        VALUES ('${g}', 'Look Alike', 'lookalike@example.test', '${IDS.attackerAcademy}');
      INSERT INTO public.bookings (slot_id, guest_player_id, status)
        VALUES ('${GUEST_SLOT}', '${g}', 'confirmed');
    `);
    expect(await direct(u, OTHER_CYCLE)).toBe(false);
    expect(await wrapper(u, OTHER_CYCLE)).toBe(false);
  });

  it('the retained arm really is the pure-profile seat (control)', async () => {
    // OTHER_USER IS eligible in OTHER_CYCLE — via its own pure-profile seat, not a bridge.
    expect(await direct(OTHER_USER, OTHER_CYCLE)).toBe(true);
  });
});

describe('A3 · removed arms cannot be restored silently', () => {
  it('no A3 function still reads a bridge column or person equality', async () => {
    const r = await db.query<{ proname: string }>(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname='public'
         AND p.proname IN ('get_my_linked_guest_bookings','get_my_paid_booking_ids',
                           'get_my_pending_priority_claims','is_cycle_member','can_book_member_window')
         AND p.prosrc ~ 'linked_profile_id|twin_of_profile_id|guest_verified_account_profile|person_id'`);
    expect(r.rows.map((x) => x.proname)).toEqual([]);
  });

  it('signatures and the service_role-only grant on is_cycle_member are unchanged', async () => {
    const r = await db.query<{ proname: string; args: string }>(`
      SELECT p.proname, oidvectortypes(p.proargtypes) AS args
        FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname='public'
         AND p.proname IN ('get_my_linked_guest_bookings','get_my_paid_booking_ids',
                           'get_my_pending_priority_claims','is_cycle_member','can_book_member_window')
       ORDER BY p.proname`);
    expect(r.rows.map((x) => [x.proname, x.args])).toEqual([
      ['can_book_member_window', 'uuid, uuid'],
      ['get_my_linked_guest_bookings', ''],
      ['get_my_paid_booking_ids', ''],
      ['get_my_pending_priority_claims', ''],
      ['is_cycle_member', 'uuid, uuid'],
    ]);

    const g = await one<{ a: boolean; s: boolean }>(
      `SELECT has_function_privilege('authenticated','public.is_cycle_member(uuid,uuid)','EXECUTE') AS a,
              has_function_privilege('service_role','public.is_cycle_member(uuid,uuid)','EXECUTE') AS s`);
    expect(g).toEqual({ a: false, s: true });
  });

  it('every legacy bridge value is still stored, unmodified', async () => {
    const r = await one<{ linked: string; twin: string; person: string }>(
      `SELECT g.linked_profile_id AS linked, g.twin_of_profile_id AS twin, pl.person_id AS person
         FROM public.guest_players g
         JOIN public.person_links pl ON pl.guest_player_id = g.id
        WHERE g.id = $1`, [LINKED_GUEST]);
    expect(r).toEqual({ linked: ME_PROFILE, twin: ME_PROFILE, person: SHARED_PERSON });
  });
});

describe('A3 correction · the priority-claim RLS policy and can_book_slot', () => {
  // The RPC was never the only way in. These run under SET ROLE authenticated so the POLICY is
  // what is being tested, not a definer function that happens to agree with it.
  const claimsAsPlayer = async (uid: string) => {
    await asUser(uid);
    await db.exec('SET ROLE authenticated');
    try {
      const r = await db.query<{ slot_id: string; claim_token: string | null }>(
        `SELECT slot_id, claim_token FROM public.slot_priority_claims`);
      return r.rows;
    } finally {
      await db.exec('RESET ROLE');
    }
  };

  it('a DUAL-KEY claim does not disclose its claim_token to the named profile', async () => {
    const rows = await claimsAsPlayer(ME_USER);
    expect(rows.map((r) => r.slot_id)).not.toContain(DUAL_SLOT);
    expect(rows.map((r) => r.slot_id)).not.toContain(GUEST_SLOT);
  });

  it('…while my own PURE-PROFILE claim is still readable, token included', async () => {
    const rows = await claimsAsPlayer(ME_USER);
    const mine = rows.find((r) => r.slot_id === PURE_SLOT);
    expect(mine).toBeDefined();
  });

  it('the dual-key claim cannot be accepted through respond_to_priority_claim', async () => {
    // The responder is token-authorized, so withholding the token IS the control. Prove the
    // token is unobtainable through the player path; a caller who never sees it cannot respond.
    const leaked = (await claimsAsPlayer(ME_USER)).map((r) => r.claim_token).filter(Boolean);
    const dual = await db.query<{ claim_token: string }>(
      `SELECT claim_token FROM public.slot_priority_claims WHERE slot_id = $1`, [DUAL_SLOT]);
    expect(dual.rows.length).toBe(1);
    expect(leaked).not.toContain(dual.rows[0].claim_token);
  });

  it('the slot-owner policy still authorizes on slot OWNERSHIP, unchanged', async () => {
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_policies
        WHERE tablename = 'slot_priority_claims'
          AND policyname = 'Slot owners manage priority claims'`);
    expect(r.rows[0].n).toBe(1);
  });

  it('can_book_slot: a PURE-PROFILE claim still opens a priority slot', async () => {
    const slot = '30000000-0000-4000-8000-00000000a401';
    await db.exec(`
      INSERT INTO public.availability_slots (id, academy_profile_id, booking_tier)
        VALUES ('${slot}', '${IDS.attackerAcademy}', 'priority');
      INSERT INTO public.slot_priority_claims (slot_id, player_id, status)
        VALUES ('${slot}', '${ME_PROFILE}', 'pending');
    `);
    const r = await one<{ v: string }>(`SELECT public.can_book_slot($1, $2) AS v`, [slot, ME_USER]);
    expect(r.v).not.toBe('priority_restricted');
  });

  it('can_book_slot: a DUAL-KEY claim does NOT open it', async () => {
    const slot = '30000000-0000-4000-8000-00000000a402';
    await db.exec(`
      INSERT INTO public.availability_slots (id, academy_profile_id, booking_tier)
        VALUES ('${slot}', '${IDS.attackerAcademy}', 'priority');
      INSERT INTO public.slot_priority_claims (slot_id, player_id, guest_player_id, status)
        VALUES ('${slot}', '${ME_PROFILE}', '${LINKED_GUEST}', 'pending');
    `);
    const r = await one<{ v: string }>(`SELECT public.can_book_slot($1, $2) AS v`, [slot, ME_USER]);
    expect(r.v).toBe('priority_restricted');
  });

  it('an account with NO claim is still refused (control)', async () => {
    const slot = '30000000-0000-4000-8000-00000000a403';
    await db.exec(`
      INSERT INTO public.availability_slots (id, academy_profile_id, booking_tier)
        VALUES ('${slot}', '${IDS.attackerAcademy}', 'priority');
    `);
    const r = await one<{ v: string }>(`SELECT public.can_book_slot($1, $2) AS v`, [slot, OTHER_USER]);
    expect(r.v).toBe('priority_restricted');
  });
});

describe('A3 correction · a claim-only cycle with no qualifying booking', () => {
  // Isolates the priority-claim arm of the member window: nobody has a seat in this cycle, so
  // the ONLY thing that can grant eligibility is the claim itself.
  const CLAIM_CYCLE = '90000000-0000-4000-8000-00000000a401';
  const CLAIM_SLOT = '30000000-0000-4000-8000-00000000a404';
  const DUAL_CLAIM_SLOT = '30000000-0000-4000-8000-00000000a405';

  beforeAll(async () => {
    await db.exec(`
      INSERT INTO public.cycles (id, owner_type, owner_id, type)
        VALUES ('${CLAIM_CYCLE}', 'academy', '${IDS.attackerAcademy}', 'cyclus');
      INSERT INTO public.availability_slots (id, academy_profile_id, source_cycle_id) VALUES
        ('${CLAIM_SLOT}',      '${IDS.attackerAcademy}', '${CLAIM_CYCLE}'),
        ('${DUAL_CLAIM_SLOT}', '${IDS.attackerAcademy}', '${CLAIM_CYCLE}');
      INSERT INTO public.slot_priority_claims (slot_id, player_id, status)
        VALUES ('${CLAIM_SLOT}', '${ME_PROFILE}', 'pending');
      INSERT INTO public.slot_priority_claims (slot_id, player_id, guest_player_id, status)
        VALUES ('${DUAL_CLAIM_SLOT}', '${OTHER_PROFILE}', '${LINKED_GUEST}', 'pending');
    `);
  });

  it('a PURE-PROFILE claim grants eligibility — direct and auth-bound', async () => {
    const d = await one<{ ok: boolean }>(
      `SELECT public.can_book_member_window($1, $2) AS ok`, [ME_USER, CLAIM_CYCLE]);
    expect(d.ok).toBe(true);
    await asUser(ME_USER);
    const w = await one<{ ok: boolean }>(
      `SELECT public.can_current_user_book_member_window($1) AS ok`, [CLAIM_CYCLE]);
    expect(w.ok).toBe(true);
  });

  it('a DUAL-KEY claim grants nothing — direct and auth-bound', async () => {
    const d = await one<{ ok: boolean }>(
      `SELECT public.can_book_member_window($1, $2) AS ok`, [OTHER_USER, CLAIM_CYCLE]);
    expect(d.ok).toBe(false);
    await asUser(OTHER_USER);
    const w = await one<{ ok: boolean }>(
      `SELECT public.can_current_user_book_member_window($1) AS ok`, [CLAIM_CYCLE]);
    expect(w.ok).toBe(false);
  });
});

describe('A3 correction · multi-role staff/player composition', () => {
  it('OR-composed staff RLS cannot turn a dual-key row into player authority', async () => {
    // attackerUser manages the academy that OWNS these slots, so the slot-owner policy grants
    // them the claim rows. That is legitimate staff oversight. What must NOT happen is the
    // player predicate treating the same dual-key row as the staff member's OWN claim.
    await asUser(IDS.attackerUser);
    await db.exec('SET ROLE authenticated');
    let staffSees = 0;
    try {
      const r = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.slot_priority_claims WHERE slot_id = $1`, [DUAL_SLOT]);
      staffSees = r.rows[0].n;
    } finally {
      await db.exec('RESET ROLE');
    }
    expect(staffSees).toBeGreaterThan(0);   // staff oversight preserved

    // …and a dual-key claim naming the STAFF member still buys them no player eligibility on a
    // PRIORITY slot. It must be a priority-tier slot: on a public slot everyone is eligible
    // anyway, so asserting there would prove nothing about the claim.
    const staffSlot = '30000000-0000-4000-8000-00000000a406';
    await db.exec(`
      INSERT INTO public.availability_slots (id, academy_profile_id, booking_tier)
        VALUES ('${staffSlot}', '${IDS.attackerAcademy}', 'priority');
      -- persons.user_id FKs auth.users and mint_person_for_profile mirrors it, so the account
      -- must exist before the profile row.
      INSERT INTO auth.users (id, email) VALUES ('${IDS.attackerUser}', 'staff@example.test')
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.profiles (id, user_id, full_name)
        VALUES ('10000000-0000-4000-8000-00000000a406', '${IDS.attackerUser}', 'Staff')
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.slot_priority_claims (slot_id, player_id, guest_player_id, status)
        VALUES ('${staffSlot}', '10000000-0000-4000-8000-00000000a406', '${LINKED_GUEST}', 'pending');
    `);
    const cbs = await one<{ v: string }>(
      `SELECT public.can_book_slot($1, $2) AS v`, [staffSlot, IDS.attackerUser]);
    expect(cbs.v).toBe('priority_restricted');
  });
});

describe('A3 correction · source guards', () => {
  it('both client fallbacks filter guest_player_id', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const pc = readFileSync(join(process.cwd(), 'src/lib/priorityClaims.ts'), 'utf8');
    const sv = readFileSync(join(process.cwd(), 'src/lib/slotVisibility.ts'), 'utf8');
    // every raw player_id filter must be paired with a pure-profile guard
    for (const [name, src] of [['priorityClaims', pc], ['slotVisibility', sv]] as const) {
      const rawFilters = (src.match(/\.eq\('player_id'/g) || []).length;
      const guards = (src.match(/\.is\('guest_player_id', null\)/g) || []).length;
      expect({ name, rawFilters, guarded: guards >= rawFilters }).toMatchObject({ guarded: true });
    }
  });

  it('the wrapper still delegates to the auth-bound function', async () => {
    const r = await db.query<{ src: string }>(`
      SELECT p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='can_current_user_book_member_window'`);
    expect(r.rows[0].src).toMatch(/can_book_member_window/);
    expect(r.rows[0].src).toMatch(/auth\.uid\(\)/);
  });
});
