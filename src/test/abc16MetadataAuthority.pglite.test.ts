// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// ABC-16 H0 — the authority half of the containment, against real PostgreSQL.
//
// The suite is deliberately in two halves over two databases built from the SAME fixture:
//
//   BEFORE  applies only the shipped pre-H0 chain and PROVES THE ATTACK WORKS. Without this
//           half the "after" assertions would be unfalsifiable — every one of them also
//           passes against a database where the tables simply do not exist, or where the
//           fixture forgot to mint the forged row. This half is the mutation check: remove
//           H0's re-emitted predicates and the "after" half becomes identical to this one.
//
//   AFTER   applies the real H0 migration on top and proves each path is closed, while the
//           legitimate paths beside it stay open. Containment that also breaks the honest
//           case is not containment, it is an outage.
//
// The attacker is an ordinary authenticated user who created their own academy — the actor
// barrier the repository actually has (create-academy-profile inserts academy_profiles with a
// fresh uuid and makes the caller its owner-manager).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { applyPreH0, applyH0, FIXTURE_SQL, IDS } from './abc16Fixture';

type Db = PGlite;

async function build(withH0: boolean): Promise<Db> {
  const db = new PGlite();
  const exec = (sql: string) => db.exec(sql);
  await applyPreH0(exec);
  await db.exec(FIXTURE_SQL);
  if (withH0) await applyH0(exec);
  return db;
}

/** Run as the attacker: an authenticated client whose auth.uid() is the attacker's user. */
async function asAttacker<T>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query(`SELECT set_config('abc16.uid', $1, false)`, [IDS.attackerUser]);
  const r = await db.query<T>(sql, params);
  return r.rows;
}

const belongs = async (db: Db, guestId: string) =>
  (await asAttacker<{ ok: boolean }>(
    db, `SELECT public.guest_belongs_to_user_academy($1, $2) AS ok`, [guestId, IDS.attackerUser],
  ))[0].ok;

const capability = async (db: Db, profileId: string) =>
  (await asAttacker<{ cap: string }>(
    db, `SELECT public.get_player_email_edit_capability($1, $2) AS cap`, [profileId, IDS.attackerAcademy],
  ))[0].cap;

const priorityProfiles = async (db: Db, ids: string[]) => {
  const rows = await asAttacker<{ profile_id: string | null }>(
    db, `SELECT profile_id FROM public.filter_academy_priority_ids($1, $2::uuid[], NULL)`,
    [IDS.attackerAcademy, ids],
  );
  return rows.map((r) => r.profile_id).filter(Boolean);
};

/**
 * Read guest rows the way a client does: as the `authenticated` ROLE, so the SELECT policy is
 * actually enforced. Running as the table owner would bypass RLS entirely and make every
 * guest-PII assertion below vacuous.
 */
async function guestVisibleToAttacker(db: Db, guestId: string): Promise<boolean> {
  await db.query(`SELECT set_config('abc16.uid', $1, false)`, [IDS.attackerUser]);
  await db.exec('SET ROLE authenticated');
  try {
    const r = await db.query<{ id: string }>(`SELECT id FROM public.guest_players WHERE id = $1`, [guestId]);
    return r.rows.length > 0;
  } finally {
    await db.exec('RESET ROLE');
  }
}

/**
 * Reassign a booking's SUBJECT as the academy manager, under the real UPDATE policy.
 *
 * This is the ABC-17 probe. The policy (20260704120000) gates on the SLOT and never mentions
 * `player_id` / `guest_player_id`, so before the guard the academy can point any booking on
 * its own slot at an arbitrary victim — which is what made every booking-derived predicate
 * forgeable.
 */
/**
 * Row count of a write, WITHOUT `RETURNING`.
 *
 * `RETURNING` makes the statement also subject to the SELECT policy — the exact trap
 * 20260801100000 was written to fix — so a rejected RETURNING would look like a rejected
 * UPDATE and these tests would pass for the wrong reason.
 */
const affected = (r: unknown): number =>
  (r as { affectedRows?: number; rowCount?: number }).affectedRows
  ?? (r as { rowCount?: number }).rowCount
  ?? 0;

async function reassignBookingSubject(db: Db, toGuestId: string): Promise<{ ok: boolean; error?: string }> {
  await db.query(`SELECT set_config('abc16.uid', $1, false)`, [IDS.attackerUser]);
  await db.exec('SET ROLE authenticated');
  try {
    const r = await db.query(
      `UPDATE public.bookings SET guest_player_id = $1 WHERE slot_id = $2`,
      [toGuestId, IDS.attackerSlot],
    );
    return { ok: affected(r) > 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await db.exec('RESET ROLE');
  }
}

describe('ABC-16 · BEFORE H0 — the attack is real (these assertions must FAIL after H0)', () => {
  let db: Db;
  beforeAll(async () => { db = await build(false); });

  it('forged metadata makes a victim academy\'s guest "belong" to the attacker', async () => {
    expect(await belongs(db, IDS.guestTargetedByForgedMetadata)).toBe(true);
  });

  it('ABC-17: a booking\'s subject can be REASSIGNED to an arbitrary victim under real RLS', async () => {
    // Nothing in the UPDATE policy constrains the subject columns, and `public.bookings`
    // carries no triggers — so this succeeds, and every booking-derived predicate downstream
    // is therefore forgeable by the slot owner.
    const result = await reassignBookingSubject(db, IDS.guestOwnedByVictimAcademy);
    expect(result).toEqual({ ok: true });
  });

  it('…and the reassignment immediately grants access to that victim guest', async () => {
    expect(await belongs(db, IDS.guestOwnedByVictimAcademy)).toBe(true);
    expect(await guestVisibleToAttacker(db, IDS.guestOwnedByVictimAcademy)).toBe(true);
  });

  it('and that guest\'s personal data is readable through the guest SELECT policy', async () => {
    expect(await guestVisibleToAttacker(db, IDS.guestTargetedByForgedMetadata)).toBe(true);
  });

  it('forged metadata yields the `direct` email capability for a nascent account', async () => {
    expect(await capability(db, IDS.nascentProfile)).toBe('direct');
  });

  it('metadata-only / location-only ids are admitted as academy priority members', async () => {
    expect(await priorityProfiles(db, [IDS.nascentProfile])).toContain(IDS.nascentProfile);
  });
});

describe('ABC-16 · AFTER H0 — every overlay-derived authority is closed', () => {
  let db: Db;
  beforeAll(async () => { db = await build(true); });

  // ── the three predicates ────────────────────────────────────────────────────────────────
  it('forged metadata no longer makes the guest belong to the attacker', async () => {
    expect(await belongs(db, IDS.guestTargetedByForgedMetadata)).toBe(false);
  });

  it('the guest SELECT path is closed for a metadata-only relationship', async () => {
    expect(await guestVisibleToAttacker(db, IDS.guestTargetedByForgedMetadata)).toBe(false);
  });

  it('a victim guest with no forged row was never visible and still is not', async () => {
    expect(await guestVisibleToAttacker(db, IDS.guestOwnedByVictimAcademy)).toBe(false);
  });

  it('forged profile metadata never yields `direct` — the nascent account is safe', async () => {
    expect(await capability(db, IDS.nascentProfile)).toBe('override');
  });

  it('metadata-only and location-only ids are rejected by filter_academy_priority_ids', async () => {
    expect(await priorityProfiles(db, [IDS.nascentProfile])).toEqual([]);
  });

  // ── ABC-17: booking-derived authority is gone, and the forgery itself is closed ─────────
  //
  // The previous revision of this suite asserted "a guest who BOOKED one of the academy's
  // slots is still visible (arm b)" as a LEGITIMATE path. That was wrong: the audit showed the
  // subject of that booking is reassignable by the very academy the arm authorizes, so the
  // assertion pinned forgeable behaviour as correct. It is inverted here.
  it('a guest who merely BOOKED one of the academy\'s slots is NO LONGER visible (arm b removed)', async () => {
    expect(await belongs(db, IDS.guestBookedOnAttackerSlot)).toBe(false);
    expect(await guestVisibleToAttacker(db, IDS.guestBookedOnAttackerSlot)).toBe(false);
  });

  // The partial UPDATE-only guard was WITHDRAWN rather than extended. It could not cover the
  // trainer dual-key INSERT, and it could never make historical or privileged-writer bookings
  // trustworthy — so relying on it was overclaiming. The boundary is the READER: a booking is
  // activity, never evidence about a person. These tests therefore assert that reassignment
  // still SUCCEEDS and buys the caller nothing, which is a strictly stronger property than
  // "the write is blocked".
  it('reassigning a booking subject still succeeds — bookings are not guarded, they are distrusted', async () => {
    const result = await reassignBookingSubject(db, IDS.guestOwnedByVictimAcademy);
    expect(result.ok).toBe(true);
  });

  it('…and it grants NO access to that person', async () => {
    expect(await belongs(db, IDS.guestOwnedByVictimAcademy)).toBe(false);
    expect(await guestVisibleToAttacker(db, IDS.guestOwnedByVictimAcademy)).toBe(false);
    // restore the fixture's world for later assertions
    await db.query(`UPDATE public.bookings SET guest_player_id = $1 WHERE slot_id = $2`,
      [IDS.guestBookedOnAttackerSlot, IDS.attackerSlot]);
  });

  it('a trainer dual-key INSERT naming an arbitrary player grants nothing either', async () => {
    // The trainer INSERT policy (20260116200114) admits {owned guest, arbitrary player_id}.
    // That row is still insertable; what it must not do is confer visibility.
    await db.query(`SELECT set_config('abc16.uid', $1, false)`, [IDS.attackerUser]);
    await db.query(
      `INSERT INTO public.bookings (slot_id, guest_player_id, player_id, status)
       VALUES ($1, $2, $3, 'confirmed')`,
      [IDS.attackerSlot, IDS.guestOwnedByAttackerAcademy, IDS.nascentProfile],
    );

    const r = await db.query<{ ok: boolean }>(
      `SELECT public.is_player_of_trainer($1) AS ok`, [IDS.nascentProfile]);
    expect(r.rows[0].ok).toBe(false);

    const a = await db.query<{ ok: boolean }>(
      `SELECT public.is_player_of_academy($1, $2) AS ok`, [IDS.nascentProfile, IDS.attackerAcademy]);
    expect(a.rows[0].ok).toBe(false);
  });

  it('the staff visibility helpers admit nothing for a non-admin caller', async () => {
    const r = await db.query<{ t: boolean; a: boolean }>(
      `SELECT public.is_player_of_trainer($1) AS t,
              public.is_player_of_academy($1, $2) AS a`,
      [IDS.bookedProfile, IDS.attackerAcademy],
    );
    expect(r.rows[0]).toEqual({ t: false, a: false });
  });

  // ── ABC-18: the legacy guest↔account bridge is frozen going forward ─────────────────────
  it('a client cannot create a guest that is already linked to an account', async () => {
    await db.query(`SELECT set_config('abc16.uid', $1, false)`, [IDS.attackerUser]);
    await db.exec('SET ROLE authenticated');
    try {
      await expect(db.query(
        `INSERT INTO public.guest_players (id, full_name, academy_profile_id, linked_profile_id)
         VALUES (gen_random_uuid(), 'Claimed', $1, $2)`,
        [IDS.attackerAcademy, IDS.nascentProfile],
      )).rejects.toThrow(/cannot be created already linked/i);
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('a client cannot set or change an existing guest\'s account link', async () => {
    await db.query(`SELECT set_config('abc16.uid', $1, false)`, [IDS.attackerUser]);
    await db.exec('SET ROLE authenticated');
    try {
      await expect(db.query(
        `UPDATE public.guest_players SET twin_of_profile_id = $1 WHERE id = $2`,
        [IDS.nascentProfile, IDS.guestOwnedByAttackerAcademy],
      )).rejects.toThrow(/account link cannot be set or changed/i);
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('ordinary guest edits still work — only the bridge columns are frozen', async () => {
    await db.query(`SELECT set_config('abc16.uid', $1, false)`, [IDS.attackerUser]);
    await db.exec('SET ROLE authenticated');
    try {
      const r = await db.query(
        `UPDATE public.guest_players SET full_name = 'Renamed Guest' WHERE id = $1`,
        [IDS.guestOwnedByAttackerAcademy],
      );
      expect(affected(r)).toBe(1);
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('NO registered profile is admitted to academy priority any more — every route was forgeable', async () => {
    // Deliberate, documented functional loss: the metadata arm and the location arm were
    // caller-authored, and the booking arm was reassignable. Canonical membership (U2) is the
    // replacement; inventing a trainer-roster rule here would be a new authority model.
    expect(await priorityProfiles(db, [IDS.bookedProfile])).toEqual([]);
  });

  // ── the legitimate path must survive ────────────────────────────────────────────────────
  it('a guest the academy OWNS is still visible (arm a)', async () => {
    expect(await belongs(db, IDS.guestOwnedByAttackerAcademy)).toBe(true);
    expect(await guestVisibleToAttacker(db, IDS.guestOwnedByAttackerAcademy)).toBe(true);
  });

  it('a guest the academy owns is still admitted by the guest priority arm', async () => {
    const rows = await asAttacker<{ guest_player_id: string | null }>(
      db, `SELECT guest_player_id FROM public.filter_academy_priority_ids($1, NULL, $2::uuid[])`,
      [IDS.attackerAcademy, [IDS.guestOwnedByAttackerAcademy, IDS.guestTargetedByForgedMetadata]],
    );
    const ids = rows.map((r) => r.guest_player_id);
    expect(ids).toContain(IDS.guestOwnedByAttackerAcademy);
    // the victim academy's guest is NOT the attacker's, forged metadata notwithstanding
    expect(ids).not.toContain(IDS.guestTargetedByForgedMetadata);
  });

  // ── fail-closed edges ───────────────────────────────────────────────────────────────────
  it('an unauthorized caller still gets 42501 from the capability gate, not a value', async () => {
    await db.query(`SELECT set_config('abc16.uid', $1, false)`, [IDS.victimUser]);
    await expect(
      db.query(`SELECT public.get_player_email_edit_capability($1, $2)`, [IDS.nascentProfile, IDS.attackerAcademy]),
    ).rejects.toThrow(/not authorized/i);
  });

  it('a caller with no session at all is refused by the capability gate', async () => {
    await db.query(`SELECT set_config('abc16.uid', '', false)`);
    await expect(
      db.query(`SELECT public.get_player_email_edit_capability($1, $2)`, [IDS.nascentProfile, IDS.attackerAcademy]),
    ).rejects.toThrow(/not authorized/i);
  });

  it('a guest subject still returns the safe outcome rather than `direct`', async () => {
    expect(await capability(db, null as unknown as string)).toBe('override');
  });

  it('an unknown target UUID is not admitted anywhere', async () => {
    const unknown = '99999999-9999-4999-8999-999999999999';
    expect(await belongs(db, unknown)).toBe(false);
    expect(await priorityProfiles(db, [unknown])).toEqual([]);
  });

  // ── data preservation ───────────────────────────────────────────────────────────────────
  it('H0 deleted nothing: both forged rows are still present, exactly as minted', async () => {
    const meta = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.academy_player_metadata WHERE academy_profile_id = $1`,
      [IDS.attackerAcademy],
    );
    expect(meta.rows[0].n).toBe(2);   // the guest-keyed and the profile-keyed forgery

    const loc = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.academy_player_locations WHERE academy_profile_id = $1`,
      [IDS.attackerAcademy],
    );
    expect(loc.rows[0].n).toBe(1);
  });

  it('the notes on a forged row are untouched — H0 scrubs nothing', async () => {
    const r = await db.query<{ notes: string }>(
      `SELECT notes FROM public.academy_player_metadata WHERE academy_profile_id = $1 AND guest_player_id = $2`,
      [IDS.attackerAcademy, IDS.guestTargetedByForgedMetadata],
    );
    expect(r.rows[0].notes).toBe('forged');
  });

  it('overlay reads still work for a client — usability is preserved', async () => {
    await db.query(`SELECT set_config('abc16.uid', $1, false)`, [IDS.attackerUser]);
    await db.exec('SET ROLE authenticated');
    try {
      const meta = await db.query(`SELECT id, notes FROM public.academy_player_metadata`);
      const loc = await db.query(`SELECT id FROM public.academy_player_locations`);
      expect(meta.rows.length).toBeGreaterThan(0);
      expect(loc.rows.length).toBeGreaterThan(0);
    } finally {
      await db.exec('RESET ROLE');
    }
  });
});
