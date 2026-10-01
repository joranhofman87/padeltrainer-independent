// @vitest-environment node
//
// ABC-17/18 — the reader boundary, exercised for real.
//
// The writer suites prove nothing can be MINTED. These prove that what already exists is not
// READ as authority: a booking subject the slot owner chose, a legacy guest↔account bridge, and
// cross-person equality descended from it.
//
// Every case is paired: a withdrawn authority path must be closed, and the retained guest-only
// compatibility path beside it must still work. A containment that also breaks the honest case
// is an outage, not a containment.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { applyPreH0, applyH0, FIXTURE_SQL, IDS } from './abc16Fixture';

let db: PGlite;

/** A second trainer who works for the attacker academy but also has private guests. */
const SHARED_TRAINER = '70000000-0000-0000-0000-0000000000c1';
const TRAINER_PRIVATE_GUEST = '20000000-0000-0000-0000-0000000000c1';
const ACADEMY_OWN_GUEST = IDS.guestOwnedByAttackerAcademy;

beforeAll(async () => {
  db = new PGlite();
  const exec = (sql: string) => db.exec(sql);
  await applyPreH0(exec);
  await db.exec(FIXTURE_SQL);
  await applyH0(exec);

  await db.exec(`
    -- A trainer who is ACTIVE for the attacker academy, with a guest of their own that the
    -- academy has no relationship to. The old academy scope pulled this in through the
    -- active-trainer union; a trainer can serve several academies, so that crossed tenants.
    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${SHARED_TRAINER}', '${IDS.victimUser}');
    INSERT INTO public.academy_trainers (academy_profile_id, trainer_profile_id, status)
    VALUES ('${IDS.attackerAcademy}', '${SHARED_TRAINER}', 'active');
    INSERT INTO public.guest_players (id, full_name, trainer_id)
    VALUES ('${TRAINER_PRIVATE_GUEST}', 'Private Trainer Guest', '${SHARED_TRAINER}');
  `);
}, 120_000);

async function overview(scope: 'academy' | 'trainer', scopeId: string, uid: string) {
  await db.query(`SELECT set_config('abc16.uid', $1, false)`, [uid]);
  const r = await db.query<{
    player_key: string; player_type: string; guest_player_id: string | null;
    profile_id: string | null; person_id: string | null; full_name: string; email: string;
    academy_notes: string | null; location_names: string[] | null;
    has_active_cyclus: boolean; has_overdue_payment: boolean;
  }>(`SELECT * FROM public.get_players_overview($1, $2)`, [scope, scopeId]);
  return r.rows;
}

describe('ABC-17/18 · get_players_overview keeps only directly owned guests', () => {
  it('the academy sees the guest it OWNS', async () => {
    const rows = await overview('academy', IDS.attackerAcademy, IDS.attackerUser);
    expect(rows.map((r) => r.guest_player_id)).toContain(ACADEMY_OWN_GUEST);
  });

  it('…and NOT a guest owned by one of its active trainers (the tenant-crossing union)', async () => {
    const rows = await overview('academy', IDS.attackerAcademy, IDS.attackerUser);
    expect(rows.map((r) => r.guest_player_id)).not.toContain(TRAINER_PRIVATE_GUEST);
  });

  it('…and NOT a guest it merely has a booking for', async () => {
    // guestBookedOnAttackerSlot is trainer-owned with a real booking on the academy's slot.
    // A booking's subject is chosen by whoever owns the slot, so it admits nobody.
    const rows = await overview('academy', IDS.attackerAcademy, IDS.attackerUser);
    expect(rows.map((r) => r.guest_player_id)).not.toContain(IDS.guestBookedOnAttackerSlot);
  });

  it('…and NOT the victim academy\'s guest, forged overlay notwithstanding', async () => {
    const rows = await overview('academy', IDS.attackerAcademy, IDS.attackerUser);
    expect(rows.map((r) => r.guest_player_id)).not.toContain(IDS.guestTargetedByForgedMetadata);
  });

  it('NO registered profile is admitted, and no row carries profile PII', async () => {
    const rows = await overview('academy', IDS.attackerAcademy, IDS.attackerUser);
    expect(rows.every((r) => r.profile_id === null)).toBe(true);
    expect(rows.every((r) => r.player_type === 'guest')).toBe(true);
    // bookedProfile has a real booking on the academy's slot and must still be absent
    expect(rows.map((r) => r.full_name)).not.toContain('Booked Player');
    expect(rows.map((r) => r.email)).not.toContain('booked@example.test');
  });

  it('trainer scope sees exactly its own guests', async () => {
    const rows = await overview('trainer', SHARED_TRAINER, IDS.victimUser);
    const ids = rows.map((r) => r.guest_player_id);
    expect(ids).toContain(TRAINER_PRIVATE_GUEST);
    // not the academy's own guest, even though the trainer works for that academy
    expect(ids).not.toContain(ACADEMY_OWN_GUEST);
  });

  it('owner-scoped notes still render — compatibility is preserved, not collapsed', async () => {
    await db.query(
      `INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, notes)
       VALUES ($1, $2, 'coach note') ON CONFLICT DO NOTHING`,
      [IDS.attackerAcademy, ACADEMY_OWN_GUEST],
    );
    const rows = await overview('academy', IDS.attackerAcademy, IDS.attackerUser);
    const own = rows.find((r) => r.guest_player_id === ACADEMY_OWN_GUEST);
    expect(own?.academy_notes).toBe('coach note');
  });

  it('an unauthorized caller is refused, not given an empty list', async () => {
    await db.query(`SELECT set_config('abc16.uid', $1, false)`, [IDS.victimUser]);
    await expect(
      db.query(`SELECT * FROM public.get_players_overview($1, $2)`, ['academy', IDS.attackerAcademy]),
    ).rejects.toThrow(/not authorized/i);
  });

  it('every existing guest row is still present in the table — nothing was deleted', async () => {
    const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.guest_players`);
    expect(r.rows[0].n).toBeGreaterThanOrEqual(5);
  });
});

describe('ABC-17/18 · the overview contract', () => {
  it('player_key uses the established g_<uuid> form — the invoice picker parses it', async () => {
    const rows = await overview('academy', IDS.attackerAcademy, IDS.attackerUser);
    const own = rows.find((r) => r.guest_player_id === ACADEMY_OWN_GUEST);
    expect(own?.player_key).toBe(`g_${ACADEMY_OWN_GUEST}`);
    expect(rows.every((r) => /^g_[0-9a-f-]{36}$/i.test(r.player_key))).toBe(true);
  });

  it('NO person UUID escapes — not even for a legacy collapsed/forged link', async () => {
    // Give the owned guest a person link that ALSO belongs to a profile: exactly the shape the
    // legacy email/twin bridge produced. The old fallback returned that shared person uuid (or
    // the guest's own id dressed as one); either way the client could not tell it from a
    // canonical person id.
    const sharedPerson = '3a000000-0000-4000-8000-00000000dd01';
    await db.exec(`
      INSERT INTO public.persons (id) VALUES ('${sharedPerson}') ON CONFLICT DO NOTHING;
      UPDATE public.person_links SET person_id = '${sharedPerson}'
        WHERE guest_player_id = '${ACADEMY_OWN_GUEST}';
      INSERT INTO public.person_links (person_id, profile_id)
        VALUES ('${sharedPerson}', '${IDS.nascentProfile}')
        ON CONFLICT (profile_id) DO UPDATE SET person_id = EXCLUDED.person_id;
    `);

    const rows = await overview('academy', IDS.attackerAcademy, IDS.attackerUser);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.person_id === null)).toBe(true);
    expect(rows.map((r) => r.person_id)).not.toContain(sharedPerson);
    // and the collapse still does not admit the profile
    expect(rows.every((r) => r.profile_id === null)).toBe(true);
  });

  it('only CONFIRMED/COMPLETED activity shapes clubs and active-cycle state', async () => {
    const cancelledLoc = '80000000-0000-0000-0000-0000000000f1';
    const cancelledSlot = '30000000-0000-0000-0000-0000000000f1';
    await db.exec(`
      INSERT INTO public.locations (id, name) VALUES ('${cancelledLoc}', 'Cancelled Club')
        ON CONFLICT DO NOTHING;
      INSERT INTO public.availability_slots (id, academy_profile_id, trainer_id, location_id, cyclus_id, end_time)
        VALUES ('${cancelledSlot}', '${IDS.attackerAcademy}', '${IDS.attackerTrainer}',
                '${cancelledLoc}', gen_random_uuid(), now() + interval '7 days');
      INSERT INTO public.bookings (slot_id, guest_player_id, status)
        VALUES ('${cancelledSlot}', '${ACADEMY_OWN_GUEST}', 'cancelled');
    `);

    const rows = await overview('academy', IDS.attackerAcademy, IDS.attackerUser);
    const own = rows.find((r) => r.guest_player_id === ACADEMY_OWN_GUEST);
    expect(own?.location_names ?? []).not.toContain('Cancelled Club');
    expect(own?.has_active_cyclus).toBe(false);
  });

  it('overdue means past-due and unpaid, not only the literal status', async () => {
    await db.exec(`
      INSERT INTO public.invoices (guest_player_id, academy_profile_id, status, due_date, paid_at)
      VALUES ('${ACADEMY_OWN_GUEST}', '${IDS.attackerAcademy}', 'sent',
              current_date - 10, NULL);
    `);
    const rows = await overview('academy', IDS.attackerAcademy, IDS.attackerUser);
    const own = rows.find((r) => r.guest_player_id === ACADEMY_OWN_GUEST);
    expect(own?.has_overdue_payment).toBe(true);
  });

  it('a paid or cancelled past-due invoice is NOT overdue', async () => {
    const other = '2b000000-0000-4000-8000-00000000ee01';
    await db.exec(`
      INSERT INTO public.guest_players (id, full_name, academy_profile_id)
        VALUES ('${other}', 'Paid Up', '${IDS.attackerAcademy}');
      INSERT INTO public.invoices (guest_player_id, academy_profile_id, status, due_date, paid_at)
        VALUES ('${other}', '${IDS.attackerAcademy}', 'paid', current_date - 10, now()),
               ('${other}', '${IDS.attackerAcademy}', 'cancelled', current_date - 10, NULL);
    `);
    const rows = await overview('academy', IDS.attackerAcademy, IDS.attackerUser);
    expect(rows.find((r) => r.guest_player_id === other)?.has_overdue_payment).toBe(false);
  });

  it('literal overdue stays overdue even when the due date is in the FUTURE', async () => {
    const g = '2d000000-0000-4000-8000-000000000a01';
    await db.exec(`
      INSERT INTO public.guest_players (id, full_name, academy_profile_id)
        VALUES ('${g}', 'Literal Overdue', '${IDS.attackerAcademy}');
      INSERT INTO public.invoices (guest_player_id, academy_profile_id, status, due_date, paid_at)
        VALUES ('${g}', '${IDS.attackerAcademy}', 'overdue', current_date + 30, NULL);
    `);
    const rows = await overview('academy', IDS.attackerAcademy, IDS.attackerUser);
    expect(rows.find((r) => r.guest_player_id === g)?.has_overdue_payment).toBe(true);
  });

  const TERMINAL_GUESTS: Record<string, string> = {
    paid:      '2d000000-0000-4000-8000-000000000b01',
    cancelled: '2d000000-0000-4000-8000-000000000b02',
    draft:     '2d000000-0000-4000-8000-000000000b03',
    void:      '2d000000-0000-4000-8000-000000000b04',
  };

  it.each(['paid', 'cancelled', 'draft', 'void'])(
    'a past-due %s invoice is NOT overdue', async (status) => {
      const g = TERMINAL_GUESTS[status];
      await db.exec(`
        INSERT INTO public.guest_players (id, full_name, academy_profile_id)
          VALUES ('${g}', 'Terminal ${status}', '${IDS.attackerAcademy}');
        INSERT INTO public.invoices (guest_player_id, academy_profile_id, status, due_date, paid_at)
          VALUES ('${g}', '${IDS.attackerAcademy}', '${status}', current_date - 30,
                  ${status === 'paid' ? 'now()' : 'NULL'});
      `);
      const rows = await overview('academy', IDS.attackerAcademy, IDS.attackerUser);
      expect(rows.find((r) => r.guest_player_id === g)?.has_overdue_payment).toBe(false);
    });

  it('soft removal: active shown, removed hidden, no-metadata shown', async () => {
    const removed = '2c000000-0000-4000-8000-00000000ff01';
    const plain = '2c000000-0000-4000-8000-00000000ff02';
    await db.exec(`
      INSERT INTO public.guest_players (id, full_name, academy_profile_id) VALUES
        ('${removed}', 'Removed Guest', '${IDS.attackerAcademy}'),
        ('${plain}',   'No Overlay',    '${IDS.attackerAcademy}');
      INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, removed_at)
        VALUES ('${IDS.attackerAcademy}', '${removed}', now());
    `);
    const ids = (await overview('academy', IDS.attackerAcademy, IDS.attackerUser))
      .map((r) => r.guest_player_id);
    expect(ids).toContain(ACADEMY_OWN_GUEST);  // active, has an overlay row
    expect(ids).toContain(plain);              // no overlay row at all
    expect(ids).not.toContain(removed);        // soft-removed
  });
});

describe('ABC-18 · get_person_refs_for_scope resolves a guest to itself only', () => {
  const refs = async (guestId: string, uid = IDS.attackerUser, scopeId = IDS.attackerAcademy) => {
    await db.query(`SELECT set_config('abc16.uid', $1, false)`, [uid]);
    const r = await db.query<{ guest_ids: string[]; profile_id: string | null; has_login: boolean }>(
      `SELECT * FROM public.get_person_refs_for_scope('academy', $1, $2, NULL)`, [scopeId, guestId]);
    return r.rows;
  };

  it('an owned guest returns itself, with no profile and no login flag', async () => {
    const rows = await refs(ACADEMY_OWN_GUEST);
    expect(rows).toHaveLength(1);
    expect(rows[0].guest_ids).toEqual([ACADEMY_OWN_GUEST]);
    expect(rows[0].profile_id).toBeNull();
    expect(rows[0].has_login).toBe(false);
  });

  it('a guest this scope does not own resolves to nothing', async () => {
    expect(await refs(IDS.guestTargetedByForgedMetadata)).toEqual([]);
    expect(await refs(TRAINER_PRIVATE_GUEST)).toEqual([]);
  });

  it('a clicked PROFILE returns nothing — registered admission is withdrawn', async () => {
    await db.query(`SELECT set_config('abc16.uid', $1, false)`, [IDS.attackerUser]);
    const r = await db.query(
      `SELECT * FROM public.get_person_refs_for_scope('academy', $1, NULL, $2)`,
      [IDS.attackerAcademy, IDS.bookedProfile]);
    expect(r.rows).toEqual([]);
  });
});

describe('ABC-18 · get_player_locations authorizes the SUBJECT, not just the academy', () => {
  const locs = async (guestId: string | null, profileId: string | null = null) => {
    await db.query(`SELECT set_config('abc16.uid', $1, false)`, [IDS.attackerUser]);
    const r = await db.query<{ location_id: string; location_name: string }>(
      `SELECT * FROM public.get_player_locations($1, $2, $3)`,
      [IDS.attackerAcademy, profileId, guestId]);
    return r.rows;
  };

  it('an owned guest returns its curated club', async () => {
    await db.query(
      `INSERT INTO public.academy_player_locations (academy_profile_id, guest_player_id, location_id, dismissed)
       VALUES ($1, $2, $3, false) ON CONFLICT DO NOTHING`,
      [IDS.attackerAcademy, ACADEMY_OWN_GUEST, IDS.attackerLocation]);
    const rows = await locs(ACADEMY_OWN_GUEST);
    expect(rows.map((r) => r.location_id)).toContain(IDS.attackerLocation);
  });

  it('a guest the academy does not own returns nothing — the cross-tenant oracle is closed', async () => {
    expect(await locs(IDS.guestTargetedByForgedMetadata)).toEqual([]);
    expect(await locs(TRAINER_PRIVATE_GUEST)).toEqual([]);
  });

  it('a profile subject returns nothing — the profile argument is ignored', async () => {
    expect(await locs(null, IDS.bookedProfile)).toEqual([]);
  });

  it('a CONFIRMED booking\'s club is retained, a CANCELLED one is not', async () => {
    const okLoc = '80000000-0000-0000-0000-0000000000e1';
    const badLoc = '80000000-0000-0000-0000-0000000000e2';
    const okSlot = '30000000-0000-0000-0000-0000000000e1';
    const badSlot = '30000000-0000-0000-0000-0000000000e2';
    await db.exec(`
      INSERT INTO public.locations (id, name) VALUES
        ('${okLoc}', 'Confirmed Club'), ('${badLoc}', 'Cancelled Club B') ON CONFLICT DO NOTHING;
      INSERT INTO public.availability_slots (id, academy_profile_id, trainer_id, location_id) VALUES
        ('${okSlot}',  '${IDS.attackerAcademy}', '${IDS.attackerTrainer}', '${okLoc}'),
        ('${badSlot}', '${IDS.attackerAcademy}', '${IDS.attackerTrainer}', '${badLoc}');
      INSERT INTO public.bookings (slot_id, guest_player_id, status) VALUES
        ('${okSlot}',  '${ACADEMY_OWN_GUEST}', 'completed'),
        ('${badSlot}', '${ACADEMY_OWN_GUEST}', 'cancelled');
    `);
    const names = (await locs(ACADEMY_OWN_GUEST)).map((r) => r.location_name);
    expect(names).toContain('Confirmed Club');       // positively retained
    expect(names).not.toContain('Cancelled Club B'); // untrusted observation
  });
});

describe('ABC-17/18 · the trainer_id filter uses in-scope activity only', () => {
  const OTHER_TRAINER = '70000000-0000-0000-0000-0000000000d9';
  const FILTER_GUEST = '2e000000-0000-4000-8000-000000000c01';
  const NO_ACTIVITY_GUEST = '2e000000-0000-4000-8000-000000000c02';
  const FILTER_SLOT = '30000000-0000-0000-0000-0000000000d1';
  const OUT_OF_SCOPE_SLOT = '30000000-0000-0000-0000-0000000000d2';
  const CANCELLED_SLOT = '30000000-0000-0000-0000-0000000000d3';

  beforeAll(async () => {
    await db.exec(`
      INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${OTHER_TRAINER}', '${IDS.victimUser}')
        ON CONFLICT DO NOTHING;
      -- Both guests are DIRECTLY owned by the academy; the filter only narrows within that set.
      INSERT INTO public.guest_players (id, full_name, academy_profile_id) VALUES
        ('${FILTER_GUEST}',      'Has Trainer Activity', '${IDS.attackerAcademy}'),
        ('${NO_ACTIVITY_GUEST}', 'No Trainer Activity',  '${IDS.attackerAcademy}');
      INSERT INTO public.availability_slots (id, academy_profile_id, trainer_id) VALUES
        ('${FILTER_SLOT}',        '${IDS.attackerAcademy}', '${OTHER_TRAINER}'),
        ('${CANCELLED_SLOT}',     '${IDS.attackerAcademy}', '${OTHER_TRAINER}'),
        ('${OUT_OF_SCOPE_SLOT}',  '${IDS.victimAcademy}',   '${OTHER_TRAINER}');
      INSERT INTO public.bookings (slot_id, guest_player_id, status) VALUES
        ('${FILTER_SLOT}',       '${FILTER_GUEST}',      'confirmed'),
        ('${CANCELLED_SLOT}',    '${NO_ACTIVITY_GUEST}', 'cancelled'),
        ('${OUT_OF_SCOPE_SLOT}', '${NO_ACTIVITY_GUEST}', 'confirmed');
    `);
  });

  const byTrainer = async (trainerId: string) => {
    await db.query(`SELECT set_config('abc16.uid', $1, false)`, [IDS.attackerUser]);
    const r = await db.query<{ guest_player_id: string }>(
      `SELECT guest_player_id FROM public.get_players_overview('academy', $1, NULL, $2::jsonb)`,
      [IDS.attackerAcademy, JSON.stringify({ trainer_id: trainerId })]);
    return r.rows.map((x) => x.guest_player_id);
  };

  it('includes an owned guest with confirmed activity for the requested trainer', async () => {
    expect(await byTrainer(OTHER_TRAINER)).toContain(FILTER_GUEST);
  });

  it('excludes an owned guest whose only activity is CANCELLED or OUT OF SCOPE', async () => {
    const ids = await byTrainer(OTHER_TRAINER);
    expect(ids).not.toContain(NO_ACTIVITY_GUEST);
  });

  it('excludes owned guests with no activity for that trainer at all', async () => {
    const ids = await byTrainer(OTHER_TRAINER);
    expect(ids).not.toContain(ACADEMY_OWN_GUEST);
  });

  it('a different trainer id returns neither', async () => {
    const ids = await byTrainer(IDS.attackerTrainer);
    expect(ids).not.toContain(FILTER_GUEST);
    expect(ids).not.toContain(NO_ACTIVITY_GUEST);
  });

  it('the filter never ADMITS a guest the academy does not own', async () => {
    const ids = await byTrainer(OTHER_TRAINER);
    expect(ids).not.toContain(TRAINER_PRIVATE_GUEST);
    expect(ids).not.toContain(IDS.guestTargetedByForgedMetadata);
  });
});
