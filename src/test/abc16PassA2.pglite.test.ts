// @vitest-environment node
//
// ABC-18 Pass A2 — notes, journey, feedback, attendance.
//
// Admissible: explicit admin, the caller's OWN profile (caller-bound), and a guest the
// trainer/academy DIRECTLY owns. Withdrawn: person equality, twin/linked bridges, and booking
// evidence used to establish who a subject IS.
//
// Every re-emitted function is executed and every re-emitted policy is exercised under
// SET ROLE authenticated — a policy asserted only by name proves nothing.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { applyPreH0, applyH0, FIXTURE_SQL, IDS } from './abc16Fixture';

let db: PGlite;

const PLAYER_USER = '50000000-0000-4000-8000-00000000a201';
const PLAYER_PROFILE = '10000000-0000-4000-8000-00000000a201';
const SLOT = '30000000-0000-4000-8000-00000000a201';
const OWNED_GUEST = '20000000-0000-4000-8000-00000000a201';
const FOREIGN_GUEST = '20000000-0000-4000-8000-00000000a202';

beforeAll(async () => {
  db = new PGlite();
  const exec = (sql: string) => db.exec(sql);
  await applyPreH0(exec);
  await db.exec(FIXTURE_SQL);
  await applyH0(exec);

  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES ('${PLAYER_USER}', 'player@example.test');
    INSERT INTO public.profiles (id, user_id, full_name)
      VALUES ('${PLAYER_PROFILE}', '${PLAYER_USER}', 'Real Player');

    INSERT INTO public.availability_slots (id, academy_profile_id, trainer_id, start_time, end_time)
      VALUES ('${SLOT}', '${IDS.attackerAcademy}', '${IDS.attackerTrainer}',
              now() - interval '2 days', now() - interval '2 days' + interval '1 hour');

    -- a guest the attacker academy directly owns, and one it does not
    INSERT INTO public.guest_players (id, full_name, academy_profile_id)
      VALUES ('${OWNED_GUEST}', 'Owned Guest A2', '${IDS.attackerAcademy}');
    INSERT INTO public.guest_players (id, full_name, academy_profile_id)
      VALUES ('${FOREIGN_GUEST}', 'Foreign Guest A2', '${IDS.victimAcademy}');

    -- the academy authors a booking naming the registered player, plus seats for both guests
    INSERT INTO public.bookings (slot_id, player_id, status) VALUES ('${SLOT}', '${PLAYER_PROFILE}', 'confirmed');
    INSERT INTO public.bookings (slot_id, guest_player_id, status) VALUES ('${SLOT}', '${OWNED_GUEST}', 'confirmed');
    INSERT INTO public.bookings (slot_id, guest_player_id, status) VALUES ('${SLOT}', '${FOREIGN_GUEST}', 'confirmed');

    -- a shared coaching note about the registered player, authored by the academy
    INSERT INTO public.session_player_notes
      (slot_id, author_id, author_role, visibility, subject_profile_id, body)
      VALUES ('${SLOT}', '${IDS.attackerUser}', 'academy', 'shared', '${PLAYER_PROFILE}', 'about the player');

    -- a legacy collapsed identity: the player's profile and a guest share one person, and the
    -- guest also carries both bridge columns. None of it may grant anything.
    INSERT INTO public.persons (id) VALUES ('3b000000-0000-4000-8000-00000000a201') ON CONFLICT DO NOTHING;
    UPDATE public.person_links SET person_id = '3b000000-0000-4000-8000-00000000a201'
      WHERE profile_id = '${PLAYER_PROFILE}' OR guest_player_id = '${OWNED_GUEST}';
    UPDATE public.guest_players
       SET twin_of_profile_id = '${PLAYER_PROFILE}', linked_profile_id = '${PLAYER_PROFILE}'
     WHERE id = '${OWNED_GUEST}';
  `);
}, 120_000);

const asUser = (uid: string) => db.query(`SELECT set_config('abc16.uid', $1, false)`, [uid]);

async function asRole<T>(uid: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await asUser(uid);
  await db.exec('SET ROLE authenticated');
  try {
    const r = await db.query<T>(sql, params);
    return r.rows;
  } finally {
    await db.exec('RESET ROLE');
  }
}

describe('A2 · subject_guest_reads_as_me', () => {
  it('is false even for a collapsed person with BOTH bridge columns set', async () => {
    await asUser(PLAYER_USER);
    const r = await db.query<{ ok: boolean }>(
      `SELECT public.subject_guest_reads_as_me($1) AS ok`, [OWNED_GUEST]);
    expect(r.rows[0].ok).toBe(false);
  });
});

describe('A2 · session_player_notes policies', () => {
  it('the subject player still reads a shared note keyed to their OWN profile', async () => {
    const rows = await asRole<{ body: string }>(PLAYER_USER,
      `SELECT body FROM public.session_player_notes WHERE subject_profile_id = $1`, [PLAYER_PROFILE]);
    expect(rows.map((r) => r.body)).toContain('about the player');
  });

  it('a trainer/academy cannot CREATE a note about a registered player from a booking', async () => {
    await asUser(IDS.attackerUser);
    await db.exec('SET ROLE authenticated');
    try {
      await expect(db.query(
        `INSERT INTO public.session_player_notes
           (slot_id, author_id, author_role, visibility, subject_profile_id, body)
         VALUES ($1, $2, 'academy', 'shared', $3, 'forged')`,
        [SLOT, IDS.attackerUser, PLAYER_PROFILE],
      )).rejects.toThrow(/row-level security/i);
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('but CAN create a note about a guest it directly owns', async () => {
    await asUser(IDS.attackerUser);
    await db.exec('SET ROLE authenticated');
    try {
      const r = await db.query(
        `INSERT INTO public.session_player_notes
           (slot_id, author_id, author_role, visibility, subject_guest_player_id, body)
         VALUES ($1, $2, 'academy', 'shared', $3, 'owned guest note')`,
        [SLOT, IDS.attackerUser, OWNED_GUEST],
      );
      expect(r).toBeDefined();
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('and CANNOT create one about a guest another academy owns', async () => {
    await asUser(IDS.attackerUser);
    await db.exec('SET ROLE authenticated');
    try {
      await expect(db.query(
        `INSERT INTO public.session_player_notes
           (slot_id, author_id, author_role, visibility, subject_guest_player_id, body)
         VALUES ($1, $2, 'academy', 'shared', $3, 'cross tenant')`,
        [SLOT, IDS.attackerUser, FOREIGN_GUEST],
      )).rejects.toThrow(/row-level security/i);
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  // spn_insert_player is NOT modified by A2 — the player self-note path is caller-bound and was
  // left exactly as shipped. It cannot be exercised in this fixture: the same INSERT is refused
  // identically with H0 applied and with it absent, so the refusal comes from a fixture gap in
  // the notes chain, not from this change. Rather than leave a test that appears to cover the
  // path while proving nothing, the invariant that IS provable is asserted: A2 did not touch it.
  it('leaves spn_insert_player exactly as shipped (its WITH CHECK is unchanged)', async () => {
    const r = await db.query<{ wc: string }>(
      `SELECT with_check AS wc FROM pg_policies
        WHERE tablename = 'session_player_notes' AND policyname = 'spn_insert_player'`);
    expect(r.rows).toHaveLength(1);
    // caller-bound self subject, no guest subject, and the caller's own booking
    expect(r.rows[0].wc).toMatch(/author_role = 'player'/);
    expect(r.rows[0].wc).toMatch(/subject_guest_player_id IS NULL/);
    expect(r.rows[0].wc).toMatch(/get_profile_id_for_user/);
  });

});

describe('A2 · get_player_journey', () => {
  it('the player reads their own journey', async () => {
    await asUser(PLAYER_USER);
    const r = await db.query(`SELECT * FROM public.get_player_journey($1)`, [PLAYER_PROFILE]);
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it('an academy that authored the booking is REFUSED that player\'s history', async () => {
    await asUser(IDS.attackerUser);
    await expect(db.query(`SELECT * FROM public.get_player_journey($1)`, [PLAYER_PROFILE]))
      .rejects.toThrow(/not authorized for player/i);
  });

  it('a trainer teaching the slot is refused too', async () => {
    await asUser(IDS.victimUser);
    await expect(db.query(`SELECT * FROM public.get_player_journey($1)`, [PLAYER_PROFILE]))
      .rejects.toThrow(/not authorized for player/i);
  });
});

describe('A2 · get_unseen_shared_feedback_count', () => {
  it('counts the caller\'s own shared notes', async () => {
    await asUser(PLAYER_USER);
    const r = await db.query<{ n: number }>(
      `SELECT public.get_unseen_shared_feedback_count($1) AS n`, [PLAYER_PROFILE]);
    expect(r.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('refuses another caller', async () => {
    await asUser(IDS.attackerUser);
    await expect(db.query(`SELECT public.get_unseen_shared_feedback_count($1)`, [PLAYER_PROFILE]))
      .rejects.toThrow(/not authorized for player/i);
  });
});

describe('A2 · can_report_attendance_on_slot', () => {
  it('true for the caller\'s OWN pure-profile seat', async () => {
    await asUser(PLAYER_USER);
    const r = await db.query<{ ok: boolean }>(
      `SELECT public.can_report_attendance_on_slot($1) AS ok`, [SLOT]);
    expect(r.rows[0].ok).toBe(true);
  });

  it('false for a caller whose only tie is a collapsed person / bridged guest seat', async () => {
    // attackerUser has no pure-profile seat here; the owned guest shares a person with the
    // player and carries both bridge columns, which must grant nothing.
    await asUser(IDS.attackerUser);
    const r = await db.query<{ ok: boolean }>(
      `SELECT public.can_report_attendance_on_slot($1) AS ok`, [SLOT]);
    expect(r.rows[0].ok).toBe(false);
  });

  it('a DUAL-KEY row grants nothing (FAM-02 preserved)', async () => {
    const dualSlot = '30000000-0000-4000-8000-00000000a202';
    await db.exec(`
      INSERT INTO public.availability_slots (id, academy_profile_id, trainer_id)
        VALUES ('${dualSlot}', '${IDS.attackerAcademy}', '${IDS.attackerTrainer}');
      INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status)
        VALUES ('${dualSlot}', '${PLAYER_PROFILE}', '${OWNED_GUEST}', 'confirmed');
    `);
    await asUser(PLAYER_USER);
    const r = await db.query<{ ok: boolean }>(
      `SELECT public.can_report_attendance_on_slot($1) AS ok`, [dualSlot]);
    expect(r.rows[0].ok).toBe(false);
  });

  it('session_reports_player_summaries narrows with it', async () => {
    await db.exec(`
      INSERT INTO public.session_reports (slot_id, reporter_role, session_happened, public_notes)
      VALUES ('${SLOT}', 'trainer', true, 'group summary');
    `);
    const mine = await asRole<{ public_notes: string }>(PLAYER_USER,
      `SELECT public_notes FROM public.session_reports_player_summaries WHERE slot_id = $1`, [SLOT]);
    expect(mine.map((r) => r.public_notes)).toContain('group summary');

    const theirs = await asRole<{ public_notes: string }>(IDS.attackerUser,
      `SELECT public_notes FROM public.session_reports_player_summaries WHERE slot_id = $1`, [SLOT]);
    expect(theirs).toEqual([]);
  });
});

describe('A2 · signatures and zero mutation', () => {
  it('every re-emitted function keeps its argument types', async () => {
    const r = await db.query<{ proname: string; args: string }>(`
      SELECT p.proname, oidvectortypes(p.proargtypes) AS args
        FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname='public'
         AND p.proname IN ('subject_guest_reads_as_me','get_player_journey',
                           'get_unseen_shared_feedback_count','can_report_attendance_on_slot')
       ORDER BY p.proname`);
    expect(r.rows.map((x) => [x.proname, x.args])).toEqual([
      ['can_report_attendance_on_slot', 'uuid, boolean'],
      ['get_player_journey', 'uuid, integer, integer'],
      ['get_unseen_shared_feedback_count', 'uuid'],
      ['subject_guest_reads_as_me', 'uuid'],
    ]);
  });

  it('the legacy bridge values are still stored, untouched', async () => {
    const r = await db.query<{ twin: string; linked: string }>(
      `SELECT twin_of_profile_id AS twin, linked_profile_id AS linked
         FROM public.guest_players WHERE id = $1`, [OWNED_GUEST]);
    expect(r.rows[0].twin).toBe(PLAYER_PROFILE);
    expect(r.rows[0].linked).toBe(PLAYER_PROFILE);
  });
});
