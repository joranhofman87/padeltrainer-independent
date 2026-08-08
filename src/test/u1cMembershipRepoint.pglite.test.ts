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
