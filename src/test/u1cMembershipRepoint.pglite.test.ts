// @vitest-environment node
/**
 * U1c prerequisite 1a — `repoint_person_memberships` and the collapse path that depends on it.
 *
 * The thing under test is a precondition for populating `academy_player_memberships` at all: its
 * `person_id` FK is ON DELETE RESTRICT, so every shipped path that deletes a person aborts once the
 * table holds rows. `collapse_guest_person_into` is one of those paths, and it now repoints first.
 *
 * The interesting case is a COLLISION — both persons already members of one academy. That is not two
 * versions of something in conflict; a membership row is keys and timestamps, so it is one
 * relationship recorded twice. The rows coalesce into one keeping the EARLIEST `created_at`.
 *
 * And the permission to do that automatically expires by itself: the last describe block adds a child
 * table with a foreign key to memberships and proves the function starts refusing. That guard reads
 * `pg_constraint`, so it arms itself the day someone attaches academy-private data — nobody has to
 * remember to come back here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const U1A = 'supabase/migrations/20261113100000_u1a_academy_player_memberships.sql';
const REPOINT = 'supabase/migrations/20261115100000_u1c_prereq_membership_repoint.sql';
const BACKFILL = 'supabase/migrations/20260826280000_persons_backfill.sql';

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const A3 = '33333333-3333-4333-8333-333333333333';
const P_SRC = 'aaaa0001-0000-4000-8000-000000000000';
const P_TGT = 'aaaa0002-0000-4000-8000-000000000000';
const P_OTHER = 'aaaa0003-0000-4000-8000-000000000000';

const EARLY = '2024-01-01T00:00:00Z';
const LATE = '2026-01-01T00:00:00Z';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.persons (id uuid PRIMARY KEY, user_id uuid);
    CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  `);
  // The real U1a migration, minus its role grants (no Supabase roles here; the ACL is covered by the
  // U1a suite, and this file is about behaviour).
  const u1a = readFileSync(U1A, 'utf8').replace(/^REVOKE ALL.*$/gm, '');
  await db.exec(u1a);

  // Only the repoint primitive: the collapse wiring is exercised separately below with its own stubs.
  const repointSql = readFileSync(REPOINT, 'utf8');
  const primitiveOnly = repointSql.slice(0, repointSql.indexOf('-- Wiring 1/2'))
    .replace(/^REVOKE ALL.*$/gm, '');
  await db.exec(primitiveOnly);

  await db.exec(`
    INSERT INTO public.academy_profiles VALUES ('${A1}'), ('${A2}'), ('${A3}');
    INSERT INTO public.persons (id) VALUES ('${P_SRC}'), ('${P_TGT}'), ('${P_OTHER}');
  `);
});

afterAll(async () => { await db?.close(); });

beforeEach(async () => { await db.exec('DELETE FROM public.academy_player_memberships;'); });

const addMembership = (academy: string, person: string, createdAt = LATE) => db.query(
  `INSERT INTO public.academy_player_memberships (academy_profile_id, person_id, created_at)
   VALUES ($1, $2, $3::timestamptz)`, [academy, person, createdAt]);

const repoint = async (from: string, to: string) => {
  const { rows } = await db.query<{ r: { moved: number; coalesced: number } }>(
    'SELECT public.repoint_person_memberships($1, $2) AS r', [from, to]);
  return rows[0].r;
};

const membershipsOf = async (person: string) => {
  const { rows } = await db.query<{ academy_profile_id: string; created_at: string }>(
    `SELECT academy_profile_id, created_at FROM public.academy_player_memberships
     WHERE person_id = $1 ORDER BY academy_profile_id`, [person]);
  return rows;
};

describe('repoint_person_memberships — moving', () => {
  it('moves a membership to the survivor when there is no collision', async () => {
    await addMembership(A1, P_SRC);
    expect(await repoint(P_SRC, P_TGT)).toMatchObject({ moved: 1, coalesced: 0 });
    expect(await membershipsOf(P_SRC)).toHaveLength(0);
    expect((await membershipsOf(P_TGT)).map((r) => r.academy_profile_id)).toEqual([A1]);
  });

  it('leaves every other person and academy untouched', async () => {
    await addMembership(A1, P_SRC);
    await addMembership(A2, P_OTHER);
    await repoint(P_SRC, P_TGT);
    expect((await membershipsOf(P_OTHER)).map((r) => r.academy_profile_id)).toEqual([A2]);
  });

  it('is a no-op for a self-repoint or a null argument', async () => {
    await addMembership(A1, P_SRC);
    expect(await repoint(P_SRC, P_SRC)).toMatchObject({ moved: 0, coalesced: 0, self_or_null: true });
    expect((await membershipsOf(P_SRC)).map((r) => r.academy_profile_id)).toEqual([A1]);
  });

  it('is idempotent: a second repoint changes nothing', async () => {
    await addMembership(A1, P_SRC);
    await repoint(P_SRC, P_TGT);
    expect(await repoint(P_SRC, P_TGT)).toMatchObject({ moved: 0, coalesced: 0 });
    expect((await membershipsOf(P_TGT)).map((r) => r.academy_profile_id)).toEqual([A1]);
  });
});

describe('repoint_person_memberships — coalescing a duplicate relationship', () => {
  it('coalesces to ONE row and keeps the EARLIEST created_at', async () => {
    // The source relationship began first; the survivor must inherit that start, not the later one.
    await addMembership(A1, P_SRC, EARLY);
    await addMembership(A1, P_TGT, LATE);

    expect(await repoint(P_SRC, P_TGT)).toMatchObject({ moved: 0, coalesced: 1 });

    const rows = await membershipsOf(P_TGT);
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].created_at).toISOString()).toBe(new Date(EARLY).toISOString());
    expect(await membershipsOf(P_SRC)).toHaveLength(0);
  });

  it('keeps the survivor’s own created_at when IT is the earlier one', async () => {
    await addMembership(A1, P_SRC, LATE);
    await addMembership(A1, P_TGT, EARLY);
    await repoint(P_SRC, P_TGT);
    const rows = await membershipsOf(P_TGT);
    expect(new Date(rows[0].created_at).toISOString()).toBe(new Date(EARLY).toISOString());
  });

  it('moves and coalesces in one call, reporting both counts', async () => {
    await addMembership(A1, P_SRC, EARLY);   // collides
    await addMembership(A1, P_TGT, LATE);
    await addMembership(A2, P_SRC);          // moves
    await addMembership(A3, P_SRC);          // moves

    expect(await repoint(P_SRC, P_TGT)).toMatchObject({ moved: 2, coalesced: 1 });
    expect((await membershipsOf(P_TGT)).map((r) => r.academy_profile_id)).toEqual([A1, A2, A3]);
    expect(await membershipsOf(P_SRC)).toHaveLength(0);
  });

  it('never loses a relationship: every academy the source belonged to survives', async () => {
    await addMembership(A1, P_SRC);
    await addMembership(A2, P_SRC);
    await addMembership(A2, P_TGT);
    await addMembership(A3, P_TGT);
    await repoint(P_SRC, P_TGT);
    expect((await membershipsOf(P_TGT)).map((r) => r.academy_profile_id)).toEqual([A1, A2, A3]);
  });

  it('leaves the person deletable afterwards — the whole point', async () => {
    // With the RESTRICT FK this DELETE is exactly what fails today if the repoint is skipped.
    await addMembership(A1, P_SRC);
    await addMembership(A1, P_TGT);
    await expect(db.query('DELETE FROM public.persons WHERE id = $1', [P_SRC])).rejects.toThrow();
    await repoint(P_SRC, P_TGT);
    await expect(db.query('DELETE FROM public.persons WHERE id = $1', [P_SRC])).resolves.toBeTruthy();
    await db.query('INSERT INTO public.persons (id) VALUES ($1)', [P_SRC]);   // restore the fixture
  });
});

describe('the OD-10 child-data guard arms itself', () => {
  afterAll(async () => { await db.exec('DROP TABLE IF EXISTS public.membership_notes_probe;'); });

  it('coalesces automatically while a membership is keys and timestamps', async () => {
    await addMembership(A1, P_SRC, EARLY);
    await addMembership(A1, P_TGT, LATE);
    await expect(repoint(P_SRC, P_TGT)).resolves.toMatchObject({ coalesced: 1 });
  });

  it('REFUSES to coalesce once anything references memberships by FK', async () => {
    // Stand in for a future academy-private child table. Nobody edits the function to make this work:
    // the guard reads pg_constraint, so creating the FK is what arms it.
    await db.exec(`
      CREATE TABLE public.membership_notes_probe (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        membership_id uuid NOT NULL REFERENCES public.academy_player_memberships(id) ON DELETE CASCADE,
        note text);
    `);
    await addMembership(A1, P_SRC, EARLY);
    await addMembership(A1, P_TGT, LATE);

    await expect(repoint(P_SRC, P_TGT)).rejects.toThrow(/REFUSING to coalesce/i);
    // and nothing was destroyed on the way to refusing
    expect(await membershipsOf(P_SRC)).toHaveLength(1);
    expect(await membershipsOf(P_TGT)).toHaveLength(1);
  });

  it('names the offending child table so the operator knows what to resolve', async () => {
    await addMembership(A1, P_SRC);
    await addMembership(A1, P_TGT);
    await expect(repoint(P_SRC, P_TGT)).rejects.toThrow(/membership_notes_probe/);
  });

  it('still MOVES with child data present — moving destroys nothing', async () => {
    // Only coalescence discards a row. A move carries the children along with their membership.
    await addMembership(A2, P_SRC);
    await expect(repoint(P_SRC, P_TGT)).resolves.toMatchObject({ moved: 1, coalesced: 0 });
    expect((await membershipsOf(P_TGT)).map((r) => r.academy_profile_id)).toEqual([A2]);
  });
});

/**
 * The collapse path itself, on its own database.
 *
 * The suite above deliberately loads only the primitive, so on its own it could not have caught a
 * broken collapse rewrite — an earlier version of this file claimed the wiring was "exercised
 * separately" when nothing exercised it at all. This block loads the WHOLE migration, including the
 * replacement `collapse_guest_person_into`, and drives it end to end.
 */
describe('collapse_guest_person_into is membership-aware', () => {
  const G = 'cccc0001-0000-4000-8000-000000000000';
  let cdb: PGlite;

  beforeAll(async () => {
    cdb = new PGlite();
    // The stamp tables collapse touches. Minimal shapes: this proves the membership wiring, while the
    // identity behaviour itself stays covered by the shipped persons suites.
    await cdb.exec(`
      CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
      CREATE TABLE public.persons (id uuid PRIMARY KEY, user_id uuid);
      CREATE TABLE public.person_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        person_id uuid NOT NULL, profile_id uuid UNIQUE, guest_player_id uuid UNIQUE);
      CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guest_player_id uuid,
        person_id uuid, paid_by_guest_player_id uuid, paid_by_person_id uuid);
      CREATE TABLE public.invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guest_player_id uuid, person_id uuid);
      CREATE TABLE public.intake_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guest_player_id uuid, person_id uuid);
      CREATE TABLE public.slot_priority_claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        guest_player_id uuid, person_id uuid, booked_by_guest_player_id uuid, booked_by_person_id uuid);
      CREATE TABLE public.session_player_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        subject_guest_player_id uuid, subject_person_id uuid);
      CREATE TABLE public.academy_player_locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        academy_profile_id uuid, guest_player_id uuid, person_id uuid);
      CREATE TABLE public.academy_player_metadata (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        academy_profile_id uuid, guest_player_id uuid, person_id uuid);
      CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
      CREATE FUNCTION public.rederive_person(_p uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
    `);
    await cdb.exec(readFileSync(U1A, 'utf8').replace(/^REVOKE ALL.*$/gm, ''));
    // The primitive AND the collapse replacement — everything this path uses. Stopping before
    // "Wiring 2/2" leaves out merge_guest_players, which needs a dozen further tables and has its own
    // shipped suite; loading it here would only mean stubbing schema this scenario never exercises.
    const repointFull = readFileSync(REPOINT, 'utf8').replace(/^REVOKE ALL.*$/gm, '');
    await cdb.exec(repointFull.slice(0, repointFull.indexOf('-- Wiring 2/2')));
    await cdb.exec(`
      INSERT INTO public.academy_profiles VALUES ('${A1}'), ('${A2}');
      INSERT INTO public.persons (id) VALUES ('${P_SRC}'), ('${P_TGT}');
      INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${P_SRC}', '${G}');
    `);
  });

  afterAll(async () => { await cdb?.close(); });

  it('repoints memberships and then succeeds in deleting the collapsed person', async () => {
    await cdb.query(
      `INSERT INTO public.academy_player_memberships (academy_profile_id, person_id, created_at)
       VALUES ($1,$2,$3::timestamptz), ($4,$5,$6::timestamptz)`,
      [A1, P_SRC, EARLY, A1, P_TGT, LATE]);
    await cdb.query(
      `INSERT INTO public.academy_player_memberships (academy_profile_id, person_id) VALUES ($1,$2)`,
      [A2, P_SRC]);

    const { rows } = await cdb.query<{ ok: boolean }>(
      'SELECT public.collapse_guest_person_into($1,$2,$3) AS ok', [G, P_SRC, P_TGT]);
    expect(rows[0].ok).toBe(true);

    // the source person is GONE — which is exactly what the RESTRICT FK blocks without the repoint
    const { rows: left } = await cdb.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.persons WHERE id = $1', [P_SRC]);
    expect(left[0].n).toBe(0);

    // one row per academy on the survivor, and the coalesced one kept the earlier start
    const { rows: m } = await cdb.query<{ academy_profile_id: string; created_at: string }>(
      `SELECT academy_profile_id, created_at FROM public.academy_player_memberships
       WHERE person_id = $1 ORDER BY academy_profile_id`, [P_TGT]);
    expect(m.map((r) => r.academy_profile_id)).toEqual([A1, A2]);
    expect(new Date(m[0].created_at).toISOString()).toBe(new Date(EARLY).toISOString());
  });
});

/**
 * Durable evidence (slice 1b).
 *
 * `merge_guest_players` records its counts in the jsonb it already returns. `collapse_guest_person_into`
 * cannot — it returns boolean to trigger callers — so it publishes the counts transaction-locally and a
 * BEFORE INSERT trigger folds them into the `person_merge_review` row its caller writes. That row is the
 * operation's existing evidence surface; nothing new was introduced to hold it.
 */
describe('the coalescence is recorded on the REAL callers\' evidence row', () => {
  const G2 = 'cccc0002-0000-4000-8000-000000000000';
  const PROF = 'bbbb0001-0000-4000-8000-000000000000';
  let edb: PGlite;

  beforeAll(async () => {
    edb = new PGlite();
    await edb.exec(`
      CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
      CREATE TABLE public.persons (id uuid PRIMARY KEY, user_id uuid, email text, full_name text);
      CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, email text, full_name text);
      CREATE TABLE public.person_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        person_id uuid NOT NULL, profile_id uuid UNIQUE, guest_player_id uuid UNIQUE);
      CREATE TABLE public.person_merge_review (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind text, status text, email text, guest_player_id uuid, profile_id uuid,
        suggested_profile_id uuid, person_id uuid, details jsonb DEFAULT '{}'::jsonb);
      CREATE TABLE public.guest_players (id uuid PRIMARY KEY, email text, full_name text,
        twin_of_profile_id uuid, linked_profile_id uuid, source text);
      CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guest_player_id uuid,
        person_id uuid, paid_by_guest_player_id uuid, paid_by_person_id uuid);
      CREATE TABLE public.invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guest_player_id uuid, person_id uuid);
      CREATE TABLE public.intake_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guest_player_id uuid, person_id uuid);
      CREATE TABLE public.slot_priority_claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        guest_player_id uuid, person_id uuid, booked_by_guest_player_id uuid, booked_by_person_id uuid);
      CREATE TABLE public.session_player_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        subject_guest_player_id uuid, subject_person_id uuid);
      CREATE TABLE public.academy_player_locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        academy_profile_id uuid, guest_player_id uuid, person_id uuid);
      CREATE TABLE public.academy_player_metadata (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        academy_profile_id uuid, guest_player_id uuid, person_id uuid);
      CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
      CREATE FUNCTION public.rederive_person(_p uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
    `);
    await edb.exec(readFileSync(U1A, 'utf8').replace(/^REVOKE ALL.*$/gm, ''));
    // Everything except merge_guest_players (which needs a dozen further tables and has its own block):
    // the primitive, the collapse reporting variant + wrapper, and BOTH real callers.
    const full = readFileSync(REPOINT, 'utf8').replace(/^REVOKE ALL.*$/gm, '');
    await edb.exec(full.slice(0, full.indexOf('-- Wiring 2/2')));
    await edb.exec(full.slice(full.indexOf('-- Durable evidence, written where the evidence row actually is')));
  });

  afterAll(async () => { await edb?.close(); });

  it('the TWIN-CLAIM caller persists the counts in person_merge_review.details', async () => {
    await edb.exec(`
      INSERT INTO public.academy_profiles VALUES ('${A1}');
      INSERT INTO public.persons (id, email) VALUES ('${P_SRC}', 'x@example.com'), ('${P_TGT}', 'x@example.com');
      INSERT INTO public.profiles (id, email) VALUES ('${PROF}', 'x@example.com');
      INSERT INTO public.person_links (person_id, profile_id) VALUES ('${P_TGT}', '${PROF}');
      INSERT INTO public.guest_players (id, email, source) VALUES ('${G2}', 'x@example.com', 'manual');
      INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${P_SRC}', '${G2}');
    `);
    await edb.query(
      `INSERT INTO public.academy_player_memberships (academy_profile_id, person_id, created_at)
       VALUES ($1,$2,$3::timestamptz), ($4,$5,$6::timestamptz)`,
      [A1, P_SRC, EARLY, A1, P_TGT, LATE]);

    // Fire the REAL trigger function the shipped code uses for a live twin claim.
    await edb.exec(`
      CREATE TRIGGER trg_relink AFTER UPDATE ON public.guest_players
        FOR EACH ROW EXECUTE FUNCTION public.relink_person_on_twin_change();
      UPDATE public.guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${G2}';
    `);

    const { rows } = await edb.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM public.person_merge_review WHERE kind = 'auto_merged_twin_trust'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({
      via: 'live_claim', memberships_moved: 0, memberships_coalesced: 1,
    });
  });
});

describe('merge_guest_players is membership-aware', () => {
  const SRC_G = 'dddd0001-0000-4000-8000-000000000000';
  const TGT_G = 'dddd0002-0000-4000-8000-000000000000';
  const MGR = 'eeee0001-0000-4000-8000-000000000000';
  let mdb: PGlite;

  beforeAll(async () => {
    mdb = new PGlite();
    await mdb.exec(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $fn$ SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;

      CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
      CREATE TABLE public.persons (id uuid PRIMARY KEY, user_id uuid);
      CREATE TABLE public.person_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        person_id uuid NOT NULL, profile_id uuid UNIQUE, guest_player_id uuid UNIQUE);
      CREATE TABLE public.guest_players (
        id uuid PRIMARY KEY, full_name text, first_name text, last_name text, email text, phone text,
        skill_rating numeric, rating_system text, birth_date date, notes text,
        billing_business_name text, billing_address text, billing_btw_number text,
        preferred_location_id uuid, source text, academy_profile_id uuid, trainer_id uuid,
        has_trained boolean, linked_profile_id uuid, twin_of_profile_id uuid);
      CREATE TABLE public.academy_trainers (academy_profile_id uuid, trainer_profile_id uuid, status text);
      CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid,
        guest_player_id uuid, player_id uuid, person_id uuid, status text, payment_status text,
        paid_externally boolean DEFAULT false, is_captain boolean DEFAULT false,
        paid_by_guest_player_id uuid, paid_by_person_id uuid, booked_by_guest_player_id uuid,
        created_at timestamptz DEFAULT now());
      CREATE TABLE public.invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guest_player_id uuid, person_id uuid);
      CREATE TABLE public.intake_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        guest_player_id uuid, person_id uuid, cycle_id uuid, status text);
      CREATE TABLE public.slot_priority_claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slot_id uuid, guest_player_id uuid, person_id uuid,
        booked_by_guest_player_id uuid, booked_by_person_id uuid);
      CREATE TABLE public.session_player_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        subject_guest_player_id uuid, subject_person_id uuid);
      CREATE TABLE public.academy_player_locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        academy_profile_id uuid, guest_player_id uuid, profile_id uuid, person_id uuid,
        location_id uuid, dismissed boolean DEFAULT false);
      CREATE TABLE public.academy_player_metadata (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        academy_profile_id uuid, trainer_profile_id uuid, guest_player_id uuid, profile_id uuid,
        person_id uuid, tag_ids uuid[] DEFAULT '{}', notes text, removed_at timestamptz);
      CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
      CREATE FUNCTION public.rederive_person(_p uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
      CREATE FUNCTION public.is_academy_manager(_u uuid, _a uuid) RETURNS boolean
        LANGUAGE sql STABLE AS $fn$ SELECT true $fn$;
      CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, email text, full_name text);
      -- the evidence trigger at the end of the migration attaches to this table
      CREATE TABLE public.person_merge_review (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind text, status text, email text, guest_player_id uuid, profile_id uuid,
        suggested_profile_id uuid, person_id uuid, details jsonb DEFAULT '{}'::jsonb);
    `);
    await mdb.exec(readFileSync(U1A, 'utf8').replace(/^REVOKE ALL.*$/gm, ''));

    // The REAL cleanup trigger, straight out of the shipped migration. Without it the source guest's
    // delete would leave its person alive and this block would never exercise the ON DELETE RESTRICT
    // failure that the whole slice exists to prevent.
    const backfill = readFileSync(BACKFILL, 'utf8');
    const cleanupFn = backfill.slice(
      backfill.indexOf('CREATE OR REPLACE FUNCTION public.cleanup_orphan_person_on_source_delete'));
    await mdb.exec(cleanupFn.slice(0, cleanupFn.indexOf('$$;') + 3));
    await mdb.exec(`
      CREATE TRIGGER trg_cleanup_orphan_person BEFORE DELETE ON public.guest_players
        FOR EACH ROW EXECUTE FUNCTION public.cleanup_orphan_person_on_source_delete();
    `);

    // The REAL migration, including the rewritten merge_guest_players — the point of this block.
    await mdb.exec(readFileSync(REPOINT, 'utf8').replace(/^REVOKE ALL.*$/gm, ''));

    await mdb.exec(`
      INSERT INTO public.academy_profiles VALUES ('${A1}'), ('${A2}'), ('${A3}');
      INSERT INTO public.persons (id) VALUES ('${P_SRC}'), ('${P_TGT}');
      INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${SRC_G}','${A1}'), ('${TGT_G}','${A1}');
      INSERT INTO public.person_links (person_id, guest_player_id)
        VALUES ('${P_SRC}','${SRC_G}'), ('${P_TGT}','${TGT_G}');
      SELECT set_config('test.uid', '${MGR}', false);
    `);
  });

  afterAll(async () => { await mdb?.close(); });

  it('repoints memberships, so the merge SUCCEEDS and reports the counts', async () => {
    // A2 moves; A1 collides and coalesces to the earlier start. Without the repoint the source guest's
    // delete cascades to a person delete that the RESTRICT FK refuses, and the whole merge fails.
    await mdb.query(
      `INSERT INTO public.academy_player_memberships (academy_profile_id, person_id, created_at)
       VALUES ($1,$2,$3::timestamptz), ($4,$5,$6::timestamptz), ($7,$8,$9::timestamptz)`,
      [A1, P_SRC, EARLY, A1, P_TGT, LATE, A2, P_SRC, LATE]);

    const { rows } = await mdb.query<{ r: Record<string, number> }>(
      `SELECT public.merge_guest_players('academy', $1, $2, $3, '{}'::jsonb) AS r`,
      [A1, SRC_G, TGT_G]);

    expect(rows[0].r).toMatchObject({ memberships_moved: 1, memberships_coalesced: 1 });

    const { rows: m } = await mdb.query<{ academy_profile_id: string; created_at: string }>(
      `SELECT academy_profile_id, created_at FROM public.academy_player_memberships
       WHERE person_id = $1 ORDER BY academy_profile_id`, [P_TGT]);
    expect(m.map((r) => r.academy_profile_id)).toEqual([A1, A2]);
    expect(new Date(m[0].created_at).toISOString()).toBe(new Date(EARLY).toISOString());

    const { rows: orphan } = await mdb.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.academy_player_memberships WHERE person_id = $1', [P_SRC]);
    expect(orphan[0].n).toBe(0);

    // and the source PERSON is genuinely gone — the step the RESTRICT FK refuses without the repoint
    const { rows: gone } = await mdb.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.persons WHERE id = $1', [P_SRC]);
    expect(gone[0].n).toBe(0);
  });

  it('leaves memberships alone when the source person SURVIVES through another link', async () => {
    // The supported shape is one profile plus several guests. Here a profile still links to the source
    // person, so deleting the guest does NOT destroy it — and moving a living person's academy
    // relationships onto someone else would be silent data corruption.
    const SRC2 = 'dddd0003-0000-4000-8000-000000000000';
    const TGT2 = 'dddd0004-0000-4000-8000-000000000000';
    const P_LIVE = 'aaaa0009-0000-4000-8000-000000000000';
    const P_T2 = 'aaaa0010-0000-4000-8000-000000000000';
    const PROF2 = 'bbbb0009-0000-4000-8000-000000000000';

    await mdb.exec(`
      INSERT INTO public.persons (id) VALUES ('${P_LIVE}'), ('${P_T2}');
      INSERT INTO public.profiles (id) VALUES ('${PROF2}');
      INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${SRC2}','${A1}'), ('${TGT2}','${A1}');
      INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${P_LIVE}','${SRC2}'), ('${P_T2}','${TGT2}');
      INSERT INTO public.person_links (person_id, profile_id) VALUES ('${P_LIVE}','${PROF2}');
    `);
    await mdb.query(
      `INSERT INTO public.academy_player_memberships (academy_profile_id, person_id) VALUES ($1,$2)`,
      [A3, P_LIVE]);

    const { rows } = await mdb.query<{ r: Record<string, number> }>(
      `SELECT public.merge_guest_players('academy', $1, $2, $3, '{}'::jsonb) AS r`,
      [A1, SRC2, TGT2]);

    // no move is claimed...
    expect(rows[0].r).toMatchObject({ memberships_moved: 0, memberships_coalesced: 0 });
    // ...the person is still here...
    const { rows: alive } = await mdb.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.persons WHERE id = $1', [P_LIVE]);
    expect(alive[0].n).toBe(1);
    // ...and its membership stayed with it rather than migrating to the target.
    const { rows: still } = await mdb.query<{ person_id: string }>(
      'SELECT person_id FROM public.academy_player_memberships WHERE academy_profile_id = $1', [A3]);
    expect(still.map((r) => r.person_id)).toEqual([P_LIVE]);
  });
});
