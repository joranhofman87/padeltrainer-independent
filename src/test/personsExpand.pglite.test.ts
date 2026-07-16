// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Person unification PHASE 1 (EXPAND): runs the REAL migration (20260826260000) against real
// Postgres and pins its contract:
//   * persons + person_links exist with their constraints (XOR source check, unique sources,
//     unique user_id) and are RLS-locked (client roles see nothing);
//   * the dual-write triggers treat the person columns as PURE DERIVED DATA on old-world-keyed
//     rows: recomputed from person_links whenever they fire (guest-side first — the row's original
//     subject), unforgeable by writers, re-derived on key repoints (merge_guest_players), NULL for
//     unmapped/removed keys; only keyless (Phase-3 new-world) rows are writer-managed;
//   * with person_links EMPTY the triggers are a no-op — literally zero behavior change, the
//     Phase 1 guarantee;
//   * the triggers work for an RLS-RESTRICTED writer (SECURITY DEFINER — the Phase 0c round-3
//     doctrine: a non-DEFINER trigger reading the locked person_links would silently stamp NULL).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

const USER_P = '10000000-0000-0000-0000-0000000000aa'; // auth user of PROF
const PROF = '10000000-0000-0000-0000-000000000001'; // a profile (old world)
const PROF2 = '10000000-0000-0000-0000-000000000002'; // second profile, unmapped
const GA = '20000000-0000-0000-0000-0000000000a0'; // a guest (old world)
const GB = '20000000-0000-0000-0000-0000000000b0'; // second guest, mapped to another person
const GC = '20000000-0000-0000-0000-0000000000c0'; // unmapped guest
const PERSON_1 = '90000000-0000-0000-0000-000000000001'; // PROF + GA collapse into this person
const PERSON_2 = '90000000-0000-0000-0000-000000000002'; // GB's person
const SLOT = '30000000-0000-0000-0000-000000000001';

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);

    -- minimal old-world tables the migration ALTERs / references
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, email text, full_name text);
    CREATE TABLE public.guest_players (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name text, email text, academy_profile_id uuid, trainer_id uuid,
      linked_profile_id uuid, twin_of_profile_id uuid
    );
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, player_id uuid, guest_player_id uuid,
      paid_by_player_id uuid, paid_by_guest_player_id uuid,
      status text, payment_status text
    );
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      player_id uuid, guest_player_id uuid, status text
    );
    CREATE TABLE public.intake_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      player_id uuid, guest_player_id uuid
    );
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, player_id uuid, guest_player_id uuid,
      booked_by_player_id uuid, booked_by_guest_player_id uuid, status text
    );
    CREATE TABLE public.session_player_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, subject_profile_id uuid, subject_guest_player_id uuid, body text
    );
    CREATE TABLE public.academy_player_locations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      academy_profile_id uuid, profile_id uuid, guest_player_id uuid, location_id uuid
    );
    CREATE TABLE public.academy_player_metadata (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      academy_profile_id uuid, trainer_profile_id uuid, profile_id uuid, guest_player_id uuid
    );

    -- repo-standard updated_at helper the migration's persons trigger uses
    CREATE OR REPLACE FUNCTION public.update_updated_at_column()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN NEW.updated_at = now(); RETURN NEW; END $fn$;
  `);

  // --- the REAL Phase 1 migrations, executed as-is (PGlite has no roles → strip grants only) ---
  const fs = await import('node:fs/promises');
  for (const file of [
    'supabase/migrations/20260826260000_persons_expand.sql',
    'supabase/migrations/20260826270000_person_links_one_profile_per_person.sql',
  ]) {
    const sql = (await fs.readFile(file, 'utf8')).replace(/^(REVOKE|GRANT)[^;]*;$/gm, '');
    await db.exec(sql);
  }

  // RLS-restricted writer environment (round-3 doctrine test): can write bookings, cannot read
  // person_links/persons (RLS enabled, no policies).
  await db.exec(`
    CREATE ROLE authenticated;
    GRANT USAGE ON SCHEMA public TO authenticated;
    GRANT SELECT, INSERT, UPDATE ON public.bookings TO authenticated;
    GRANT SELECT ON public.persons, public.person_links TO authenticated;
  `);
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE auth.users, public.profiles, public.guest_players, public.persons,
             public.person_links, public.bookings, public.invoices, public.intake_requests,
             public.slot_priority_claims, public.session_player_notes,
             public.academy_player_locations, public.academy_player_metadata CASCADE;
    INSERT INTO auth.users (id) VALUES ('${USER_P}');
    INSERT INTO public.profiles (id, user_id, email, full_name) VALUES
      ('${PROF}', '${USER_P}', 'jan@example.com', 'Jan Jansen'),
      ('${PROF2}', gen_random_uuid(), 'piet@example.com', 'Piet Peters');
    INSERT INTO public.guest_players (id, full_name, email) VALUES
      ('${GA}', 'Jan Jansen', 'jan@example.com'),
      ('${GB}', 'Kees Klaassen', 'kees@example.com'),
      ('${GC}', 'Unmapped Uma', 'uma@example.com');
    -- Phase-2-shaped mapping: PROF and GA are the SAME person; GB is another person; GC unmapped.
    INSERT INTO public.persons (id, user_id, full_name, email) VALUES
      ('${PERSON_1}', '${USER_P}', 'Jan Jansen', 'jan@example.com'),
      ('${PERSON_2}', NULL, 'Kees Klaassen', 'kees@example.com');
    INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PERSON_1}', '${PROF}');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES
      ('${PERSON_1}', '${GA}'), ('${PERSON_2}', '${GB}');
  `);
});

const personOf = async (table: string, id: string, col = 'person_id') => {
  const r = await db.query<Record<string, string | null>>(
    `SELECT ${col} FROM public.${table} WHERE id = $1`, [id]);
  return r.rows[0]?.[col] ?? null;
};

describe('schema contract', () => {
  it('person_links enforces exactly ONE source per row', async () => {
    await expect(
      db.query(`INSERT INTO person_links (person_id, profile_id, guest_player_id) VALUES ($1, $2, $3)`,
        [PERSON_1, PROF2, GC]),
    ).rejects.toThrow(/person_links_exactly_one_source/);
    await expect(
      db.query(`INSERT INTO person_links (person_id) VALUES ($1)`, [PERSON_1]),
    ).rejects.toThrow(/person_links_exactly_one_source/);
  });

  it('a source row can be absorbed by at most ONE person (unique profile_id / guest_player_id)', async () => {
    await expect(
      db.query(`INSERT INTO person_links (person_id, profile_id) VALUES ($1, $2)`, [PERSON_2, PROF]),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      db.query(`INSERT INTO person_links (person_id, guest_player_id) VALUES ($1, $2)`, [PERSON_1, GB]),
    ).rejects.toThrow(/duplicate key/);
  });

  it('persons.user_id is unique (one person per login)', async () => {
    await expect(
      db.query(`INSERT INTO persons (user_id) VALUES ($1)`, [USER_P]),
    ).rejects.toThrow(/duplicate key/);
  });

  it('a person can absorb at most ONE profile — but N guests (external-audit P1 invariant)', async () => {
    // PERSON_1 already absorbs PROF (+ guest GA). A SECOND profile for the same person would
    // conflate two login accounts (persons.user_id can only represent one of them) — refused.
    await expect(
      db.query(`INSERT INTO person_links (person_id, profile_id) VALUES ($1, $2)`, [PERSON_1, PROF2]),
    ).rejects.toThrow(/person_links_one_profile_per_person/);
    // N guests per person stays allowed (a person's duplicate guest rows all collapse into them).
    await db.query(`INSERT INTO person_links (person_id, guest_player_id) VALUES ($1, $2)`, [PERSON_1, GC]);
    const r = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM person_links WHERE person_id = $1`, [PERSON_1]);
    expect(Number(r.rows[0].n)).toBe(3); // 1 profile + 2 guests
  });

  it('persons + person_links are invisible to client roles (RLS, no policies)', async () => {
    await db.exec(`SET ROLE authenticated;`);
    const p = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM persons`);
    const l = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM person_links`);
    await db.exec(`RESET ROLE;`);
    expect(Number(p.rows[0].n)).toBe(0);
    expect(Number(l.rows[0].n)).toBe(0);
  });

  it('deleting a guest removes its link row (CASCADE) — future stamps stop mapping', async () => {
    await db.exec(`DELETE FROM guest_players WHERE id = '${GB}';`);
    const r = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM person_links WHERE guest_player_id = '${GB}'`);
    expect(Number(r.rows[0].n)).toBe(0);
    const persons = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM persons WHERE id = '${PERSON_2}'`);
    expect(Number(persons.rows[0].n)).toBe(1); // the PERSON survives (only the link goes)
  });
});

// ---------------------------------------------------------------------------
// Stamping rules — DERIVED, NEVER TRUSTED (verification round: writer-provided person values on
// old-world-keyed rows would be forgeable via the pre-existing client RLS UPDATE policies).
// Table-driven over ALL 9 column pairs so no hand-copied trigger fn can regress unpinned.
// ---------------------------------------------------------------------------
type Pair = { table: string; kp: string; kg: string; dst: string };
const PAIRS: Pair[] = [
  { table: 'bookings', kp: 'player_id', kg: 'guest_player_id', dst: 'person_id' },
  { table: 'bookings', kp: 'paid_by_player_id', kg: 'paid_by_guest_player_id', dst: 'paid_by_person_id' },
  { table: 'invoices', kp: 'player_id', kg: 'guest_player_id', dst: 'person_id' },
  { table: 'intake_requests', kp: 'player_id', kg: 'guest_player_id', dst: 'person_id' },
  { table: 'slot_priority_claims', kp: 'player_id', kg: 'guest_player_id', dst: 'person_id' },
  { table: 'slot_priority_claims', kp: 'booked_by_player_id', kg: 'booked_by_guest_player_id', dst: 'booked_by_person_id' },
  { table: 'session_player_notes', kp: 'subject_profile_id', kg: 'subject_guest_player_id', dst: 'subject_person_id' },
  { table: 'academy_player_locations', kp: 'profile_id', kg: 'guest_player_id', dst: 'person_id' },
  { table: 'academy_player_metadata', kp: 'profile_id', kg: 'guest_player_id', dst: 'person_id' },
];

const insertRow = async (p: Pair, cols: Record<string, string | null>) => {
  const names = Object.keys(cols);
  const vals = Object.values(cols);
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.${p.table} (${names.join(', ')})
     VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    vals,
  );
  return r.rows[0].id;
};

describe.each(PAIRS)('stamping $table.$dst (derived from $kg/$kp)', (p) => {
  it('INSERT guest-keyed → stamps the mapped person', async () => {
    const id = await insertRow(p, { [p.kg]: GA });
    expect(await personOf(p.table, id, p.dst)).toBe(PERSON_1);
  });

  it('INSERT profile-keyed → stamps the mapped person', async () => {
    const id = await insertRow(p, { [p.kp]: PROF });
    expect(await personOf(p.table, id, p.dst)).toBe(PERSON_1);
  });

  it('INSERT with an unmapped key → NULL (never a wrong person)', async () => {
    const id = await insertRow(p, { [p.kg]: GC });
    expect(await personOf(p.table, id, p.dst)).toBeNull();
  });

  it('a FORGED person id on a keyed INSERT is re-derived (unforgeable)', async () => {
    const id = await insertRow(p, { [p.kg]: GA, [p.dst]: PERSON_2 });
    expect(await personOf(p.table, id, p.dst)).toBe(PERSON_1);
  });

  it('a FORGED person id via UPDATE on a keyed row is re-derived (unforgeable)', async () => {
    const id = await insertRow(p, { [p.kg]: GA });
    await db.query(`UPDATE public.${p.table} SET ${p.dst} = $1 WHERE id = $2`, [PERSON_2, id]);
    expect(await personOf(p.table, id, p.dst)).toBe(PERSON_1);
  });

  it('repointing the guest key re-derives (merge_guest_players scenario)', async () => {
    const id = await insertRow(p, { [p.kg]: GA });
    await db.query(`UPDATE public.${p.table} SET ${p.kg} = $1 WHERE id = $2`, [GB, id]);
    expect(await personOf(p.table, id, p.dst)).toBe(PERSON_2);
  });

  it('removing the keys derives NULL — no stale person survives anonymization', async () => {
    const id = await insertRow(p, { [p.kg]: GA });
    await db.query(`UPDATE public.${p.table} SET ${p.kg} = NULL WHERE id = $1`, [id]);
    expect(await personOf(p.table, id, p.dst)).toBeNull();
  });

  it('DIVERGENT both-keyed row: the GUEST side wins (the original subject, never the email inference)', async () => {
    // PROF maps to PERSON_1, GB maps to PERSON_2 — player_id on both-keyed rows is only ever
    // added later by the email linkers (banned inference), so the guest side is the subject.
    const id = await insertRow(p, { [p.kp]: PROF, [p.kg]: GB });
    expect(await personOf(p.table, id, p.dst)).toBe(PERSON_2);
  });

  it('a row with NO old-world keys is writer-managed (the Phase-3 new-world path)', async () => {
    const id = await insertRow(p, { [p.dst]: PERSON_2 });
    expect(await personOf(p.table, id, p.dst)).toBe(PERSON_2); // kept on INSERT
    await db.query(`UPDATE public.${p.table} SET ${p.dst} = $1 WHERE id = $2`, [PERSON_1, id]);
    expect(await personOf(p.table, id, p.dst)).toBe(PERSON_1); // and on UPDATE
  });
});

describe('trigger firing scope + empty-map guarantee', () => {
  it('unrelated updates do not touch the stamp (hot-path status/payment flips)', async () => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO bookings (slot_id, guest_player_id, status) VALUES ($1, $2, 'confirmed') RETURNING id`,
      [SLOT, GA]);
    await db.query(`UPDATE bookings SET status = 'cancelled', payment_status = 'paid' WHERE id = $1`, [r.rows[0].id]);
    expect(await personOf('bookings', r.rows[0].id)).toBe(PERSON_1);
  });

  it('with person_links EMPTY every stamp is NULL (the pre-Phase-2 zero-change state)', async () => {
    await db.exec(`TRUNCATE person_links;`);
    const r = await db.query<{ id: string }>(
      `INSERT INTO bookings (slot_id, guest_player_id, status) VALUES ($1, $2, 'confirmed') RETURNING id`,
      [SLOT, GA]);
    expect(await personOf('bookings', r.rows[0].id)).toBeNull();
  });

  it('stamps both bookings pairs independently (captain pays for a member)', async () => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO bookings (slot_id, guest_player_id, paid_by_guest_player_id, status)
       VALUES ($1, $2, $3, 'confirmed') RETURNING id`,
      [SLOT, GC, GB]);
    expect(await personOf('bookings', r.rows[0].id)).toBeNull(); // GC unmapped
    expect(await personOf('bookings', r.rows[0].id, 'paid_by_person_id')).toBe(PERSON_2); // GB mapped
  });
});

describe('under RLS (round-3 doctrine: DEFINER triggers, every table)', () => {
  beforeAll(async () => {
    await db.exec(`
      GRANT SELECT, INSERT, UPDATE ON public.invoices, public.intake_requests,
        public.slot_priority_claims, public.session_player_notes,
        public.academy_player_locations, public.academy_player_metadata TO authenticated;
    `);
  });

  it.each(PAIRS)('an RLS-restricted writer still gets a correct $table.$dst stamp', async (p) => {
    await db.exec(`SET ROLE authenticated;`);
    let id: string;
    try {
      id = await insertRow(p, { [p.kg]: GA });
    } finally {
      await db.exec(`RESET ROLE;`);
    }
    expect(await personOf(p.table, id, p.dst)).toBe(PERSON_1);
  });
});
