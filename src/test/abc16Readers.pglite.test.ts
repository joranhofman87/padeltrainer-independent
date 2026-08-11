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
    profile_id: string | null; full_name: string; email: string; academy_notes: string | null;
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
});
