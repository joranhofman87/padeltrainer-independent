// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Phase 0c hardening (external audit): the explicit guest-twin bridge, DB layer. Runs the REAL
// function bodies (copied verbatim from migrations 20260826200000/210000/220000) against real
// Postgres, pinning:
//   H1  — find_guest_players_by_email_for_academy derives the trainer set internally and IGNORES
//         the caller-supplied _trainer_ids (no cross-tenant email oracle).
//   H2  — uniq_guest_twin_per_academy turns concurrent twin mints into a 23505; the claim RPC's
//         compare-and-set semantics converge every race.
//   H3  — (client-side pick is unit-tested; here we pin that a row claimed by ANOTHER profile is
//         reported as such and never silently re-claimed.)
//   M4  — the player-visibility readers accept twin_of_profile_id, so a shared-email family
//         member's twin bookings/invoices show in their own app.
//   merge — merge_guest_players refuses to conflate two different person references and carries
//         the twin stamp to the surviving row (without tripping the unique index).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

const ACAD_A = '40000000-0000-0000-0000-0000000000a1'; // caller's academy
const ACAD_B = '40000000-0000-0000-0000-0000000000b1'; // victim academy
const MGR_A = '50000000-0000-0000-0000-0000000000a2'; // manager user of A
const MGR_B = '50000000-0000-0000-0000-0000000000b2'; // manager user of B
const TR_A = '60000000-0000-0000-0000-0000000000a3'; // active trainer of A
const TR_A_OLD = '60000000-0000-0000-0000-0000000000a4'; // INACTIVE trainer of A
const TR_B = '60000000-0000-0000-0000-0000000000b3'; // trainer of B (victim)
const PROF = '10000000-0000-0000-0000-000000000001'; // registered person P (the child in family cases)
const PROF2 = '10000000-0000-0000-0000-000000000002'; // a different person (the parent in family cases)
const PLAYER_USER = '10000000-0000-0000-0000-0000000000fe'; // auth user of PROF
const PARENT_USER = '10000000-0000-0000-0000-0000000000fd'; // auth user of PROF2
const GA = '20000000-0000-0000-0000-0000000000a0'; // academy-A-owned guest
const GTA = '20000000-0000-0000-0000-0000000000a1'; // trainer-A-owned guest
const GTAOLD = '20000000-0000-0000-0000-0000000000a2'; // inactive-trainer-owned guest
const GB = '20000000-0000-0000-0000-0000000000b0'; // academy-B-owned guest
const GTB = '20000000-0000-0000-0000-0000000000b1'; // trainer-B-owned guest (victim)
const SLOT = '30000000-0000-0000-0000-000000000001';
const LOC = '30000000-0000-0000-0000-0000000000cc';

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid
    $fn$;

    CREATE TABLE profiles (id uuid PRIMARY KEY, user_id uuid, email text, full_name text);
    -- NOTE: deliberately WITHOUT twin_of_profile_id and its indexes — the REAL migration
    -- (20260826210000) adds them below, so the tests exercise the migration's own DDL.
    CREATE TABLE guest_players (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name text, first_name text, last_name text, email text, phone text,
      skill_rating numeric, rating_system text, birth_date date, notes text,
      billing_business_name text, billing_address text, billing_btw_number text,
      preferred_location_id uuid, source text,
      academy_profile_id uuid, trainer_id uuid,
      has_trained boolean DEFAULT false, linked_profile_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE academy_managers (user_id uuid, academy_profile_id uuid);
    CREATE TABLE academy_trainers (academy_profile_id uuid, trainer_profile_id uuid, status text);
    CREATE TABLE trainer_profiles (id uuid PRIMARY KEY, user_id uuid);

    CREATE TABLE locations (id uuid PRIMARY KEY, name text);
    CREATE TABLE availability_slots (
      id uuid PRIMARY KEY, start_time timestamptz, end_time timestamptz, trainer_id uuid,
      max_participants integer, price_per_session numeric, cyclus_name text, location_id uuid,
      cyclus_id uuid, source_cycle_id uuid, priority_window_ends_at timestamptz
    );
    CREATE TABLE cycles (id uuid PRIMARY KEY, settings jsonb DEFAULT '{}'::jsonb);
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, player_id uuid, guest_player_id uuid REFERENCES guest_players(id) ON DELETE SET NULL,
      status text, payment_status text, paid_externally boolean DEFAULT false, notes text,
      paid_by_guest_player_id uuid REFERENCES guest_players(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      status text, booking_ids uuid[], player_id uuid,
      guest_player_id uuid REFERENCES guest_players(id)
    );
    CREATE TABLE intake_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      guest_player_id uuid REFERENCES guest_players(id)
    );
    CREATE TABLE slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, player_id uuid, status text, claim_token text, rebook_group_id uuid,
      guest_player_id uuid REFERENCES guest_players(id) ON DELETE SET NULL,
      booked_by_guest_player_id uuid REFERENCES guest_players(id) ON DELETE SET NULL
    );
    CREATE TABLE academy_player_metadata (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      academy_profile_id uuid, trainer_profile_id uuid,
      guest_player_id uuid REFERENCES guest_players(id) ON DELETE CASCADE,
      tag_ids uuid[] DEFAULT '{}', notes text
    );
    CREATE TABLE session_player_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid, subject_guest_player_id uuid REFERENCES guest_players(id) ON DELETE CASCADE, body text
    );
    CREATE TABLE academy_player_locations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      academy_profile_id uuid NOT NULL,
      guest_player_id uuid REFERENCES guest_players(id) ON DELETE CASCADE,
      location_id uuid NOT NULL, dismissed boolean NOT NULL DEFAULT false
    );

    -- email dedup support index (20260826190000, already deployed — not under test here)
    CREATE INDEX idx_guest_players_lower_email
      ON guest_players (lower(btrim(email))) WHERE email IS NOT NULL AND btrim(email) <> '';

    -- real semantics: the gate reads academy_managers
    CREATE OR REPLACE FUNCTION public.get_user_academy_ids(_user_id uuid)
    RETURNS SETOF uuid LANGUAGE sql STABLE AS $fn$
      SELECT academy_profile_id FROM public.academy_managers WHERE user_id = _user_id
    $fn$;
    CREATE OR REPLACE FUNCTION public.is_academy_manager(_user_id uuid, _academy_profile_id uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $fn$
      SELECT EXISTS (SELECT 1 FROM academy_managers
                     WHERE user_id = _user_id AND academy_profile_id = _academy_profile_id)
    $fn$;
    CREATE OR REPLACE FUNCTION public.get_profile_id_for_user(_user_id uuid)
    RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT id FROM public.profiles WHERE user_id = _user_id LIMIT 1
    $fn$;
    -- can_book_member_window clause (a) dependency — always false here; clauses (d)/(e) are under test
    CREATE OR REPLACE FUNCTION public.is_cycle_member(_user_id uuid, _cycle_id uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;
  `);

  // --- REAL migration files, executed as-is (column, indexes, trigger, functions) ---
  // Only GRANT/REVOKE lines are stripped: PGlite has no anon/authenticated/service_role roles.
  // Everything else — ALTER TABLE, CREATE [UNIQUE] INDEX, CREATE TRIGGER, function bodies — runs
  // verbatim, so weakening the migration DDL fails these tests.
  const fs = await import('node:fs/promises');
  const stripGrants = (sql: string) => sql.replace(/^(REVOKE|GRANT)[^;]*;$/gm, '');
  for (const file of [
    'supabase/migrations/20260826200000_harden_guest_dedup_rpc.sql',
    'supabase/migrations/20260826210000_guest_twin_bridge.sql',
    'supabase/migrations/20260826220000_merge_guest_players_twin_aware.sql',
    'supabase/migrations/20260826230000_twin_visibility_rebook_readers.sql',
    'supabase/migrations/20260826240000_twin_reader_precedence_and_lock.sql',
  ]) {
    await db.exec(stripGrants(await fs.readFile(file, 'utf8')));
  }
});

// PGlite has no anon/authenticated roles, so the grant state itself is untestable here (the CI
// `supabase db reset` job replays it for real). Pin the SECURITY-critical revoke TEXTUALLY: the raw
// arbitrary-_user_id can_book_member_window must stay locked to service_role (20260717100000; the
// re-grant regression shipped in 20260731100000 and was closed again in 20260826240000).
it('the raw can_book_member_window stays revoked from anon/authenticated (textual pin)', async () => {
  const fs = await import('node:fs/promises');
  const sql = await fs.readFile('supabase/migrations/20260826240000_twin_reader_precedence_and_lock.sql', 'utf8');
  expect(sql).toContain(
    'REVOKE EXECUTE ON FUNCTION public.can_book_member_window(uuid, uuid) FROM PUBLIC, anon, authenticated;',
  );
  expect(sql).toContain(
    'GRANT EXECUTE ON FUNCTION public.can_book_member_window(uuid, uuid) TO service_role;',
  );
  // and no LATER migration may re-grant it to clients (this catches the 20260731100000 mistake class)
  const dir = await fs.readdir('supabase/migrations');
  const later = dir.filter((f) => f > '20260826240000').sort();
  for (const f of later) {
    const text = await fs.readFile(`supabase/migrations/${f}`, 'utf8');
    const regrant = /GRANT[^;]*ON FUNCTION public\.can_book_member_window\(uuid, uuid\)[^;]*(anon|authenticated)/.test(text);
    expect(regrant, `${f} re-grants the raw can_book_member_window to clients`).toBe(false);
  }
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE profiles, guest_players, academy_managers, academy_trainers, trainer_profiles,
             locations, availability_slots, cycles, bookings, invoices, intake_requests,
             slot_priority_claims, academy_player_metadata, session_player_notes,
             academy_player_locations CASCADE;
    INSERT INTO profiles (id, user_id, email, full_name) VALUES
      ('${PROF}', '${PLAYER_USER}', 'fam@example.com', 'Jan Jansen'),
      ('${PROF2}', '${PARENT_USER}', 'other@example.com', 'Piet Peters');
    INSERT INTO academy_managers (user_id, academy_profile_id) VALUES
      ('${MGR_A}', '${ACAD_A}'), ('${MGR_B}', '${ACAD_B}');
    INSERT INTO academy_trainers (academy_profile_id, trainer_profile_id, status) VALUES
      ('${ACAD_A}', '${TR_A}', 'active'),
      ('${ACAD_A}', '${TR_A_OLD}', 'inactive'),
      ('${ACAD_B}', '${TR_B}', 'active');
    INSERT INTO guest_players (id, full_name, email, academy_profile_id, trainer_id) VALUES
      ('${GA}',     'Jan Jansen',  'Fam@Example.com', '${ACAD_A}', NULL),
      ('${GTA}',    'Jan Jansen',  'fam@example.com', NULL,        '${TR_A}'),
      ('${GTAOLD}', 'Jan Jansen',  'fam@example.com', NULL,        '${TR_A_OLD}'),
      ('${GB}',     'Jan Jansen',  'fam@example.com', '${ACAD_B}', NULL),
      ('${GTB}',    'Victim Vera', 'victim@example.com', NULL,     '${TR_B}');
  `);
  await db.exec(`SELECT set_config('test.uid', '${MGR_A}', false)`);
});

const emailRpc = (email: string, academy: string, trainerIds: string[]) =>
  db.query<{ id: string }>(
    `SELECT * FROM public.find_guest_players_by_email_for_academy($1, $2, $3)`,
    [email, academy, trainerIds],
  );
const findTwin = async (academy: string, profile: string) => {
  const r = await db.query<{ find_guest_twin_for_academy: string | null }>(
    `SELECT public.find_guest_twin_for_academy($1, $2)`,
    [academy, profile],
  );
  return r.rows[0].find_guest_twin_for_academy;
};
const claim = async (academy: string, guest: string, profile: string) => {
  const r = await db.query<{ claim_guest_twin_for_academy: string | null }>(
    `SELECT public.claim_guest_twin_for_academy($1, $2, $3)`,
    [academy, guest, profile],
  );
  return r.rows[0].claim_guest_twin_for_academy;
};
const twinOf = async (guest: string) => {
  const r = await db.query<{ twin_of_profile_id: string | null }>(
    `SELECT twin_of_profile_id FROM guest_players WHERE id = $1`,
    [guest],
  );
  return r.rows[0]?.twin_of_profile_id ?? null;
};

describe('H1 — hardened email dedup RPC (trainer set derived, never caller-supplied)', () => {
  it('IGNORES forged _trainer_ids: another academy\'s trainer-owned guest is never returned', async () => {
    // Manager of A passes the victim trainer's id (old behavior: leak). Hardened: nothing.
    const res = await emailRpc('victim@example.com', ACAD_A, [TR_B]);
    expect(res.rows).toHaveLength(0);
  });

  it('still finds own-academy + ACTIVE own-trainer guests even with EMPTY _trainer_ids', async () => {
    const res = await emailRpc('fam@example.com', ACAD_A, []);
    const ids = res.rows.map((r) => r.id).sort();
    expect(ids).toEqual([GA, GTA].sort()); // case-folded GA match + active trainer's GTA
  });

  it('excludes the INACTIVE trainer\'s guest', async () => {
    const res = await emailRpc('fam@example.com', ACAD_A, [TR_A_OLD]);
    expect(res.rows.map((r) => r.id)).not.toContain(GTAOLD);
  });

  it('returns nothing for a caller who does not manage the claimed academy', async () => {
    await db.exec(`SELECT set_config('test.uid', '${MGR_B}', false)`);
    const res = await emailRpc('fam@example.com', ACAD_A, []);
    expect(res.rows).toHaveLength(0);
  });
});

describe('H2 — uniq_guest_twin_per_academy + claim compare-and-set', () => {
  it('a concurrent double mint hits 23505 (the loser recovers by re-reading the winner)', async () => {
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';`);
    await expect(
      db.query(
        `INSERT INTO guest_players (full_name, academy_profile_id, twin_of_profile_id)
         VALUES ('Jan Jansen', $1, $2)`,
        [ACAD_A, PROF],
      ),
    ).rejects.toThrow(/uniq_guest_twin_per_academy/);
    // ...and the winner is findable — the loser's recovery path.
    expect(await findTwin(ACAD_A, PROF)).toBe(GA);
  });

  it('two twins of the SAME profile in DIFFERENT academies are allowed (multi-academy player)', async () => {
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';`);
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GB}';`);
    expect(await twinOf(GB)).toBe(PROF);
  });

  it('claim stamps an unclaimed visible row and returns the profile id', async () => {
    expect(await claim(ACAD_A, GA, PROF)).toBe(PROF);
    expect(await twinOf(GA)).toBe(PROF);
  });

  it('claim on a row that is already OURS returns our profile id (idempotent)', async () => {
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';`);
    expect(await claim(ACAD_A, GA, PROF)).toBe(PROF);
  });

  it('claim on a row claimed by ANOTHER profile reports the other owner and does NOT re-claim', async () => {
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF2}' WHERE id = '${GA}';`);
    expect(await claim(ACAD_A, GA, PROF)).toBe(PROF2);
    expect(await twinOf(GA)).toBe(PROF2); // unchanged
  });

  it('claim that would violate the unique index returns NULL and leaves the row unclaimed', async () => {
    // Our twin already exists on GTA→claimed-academy-owned? Use a second academy-owned row.
    await db.exec(`
      INSERT INTO guest_players (id, full_name, email, academy_profile_id, twin_of_profile_id)
      VALUES ('20000000-0000-0000-0000-0000000000ee', 'Jan Jansen', 'fam@example.com', '${ACAD_A}', '${PROF}');
    `);
    expect(await claim(ACAD_A, GA, PROF)).toBeNull();
    expect(await twinOf(GA)).toBeNull(); // CAS rolled back, nothing stamped
    // and the caller's convergence read finds the existing twin
    expect(await findTwin(ACAD_A, PROF)).toBe('20000000-0000-0000-0000-0000000000ee');
  });

  it('claim on a row OUTSIDE the academy\'s scope returns NULL and stamps nothing', async () => {
    expect(await claim(ACAD_A, GB, PROF)).toBeNull();
    expect(await twinOf(GB)).toBeNull();
  });

  it('claim by a non-manager of the academy returns NULL and stamps nothing', async () => {
    await db.exec(`SELECT set_config('test.uid', '${MGR_B}', false)`);
    expect(await claim(ACAD_A, GA, PROF)).toBeNull();
    expect(await twinOf(GA)).toBeNull();
  });

  it('claim stamps an ACTIVE-trainer-owned candidate (the SECURITY DEFINER dedup-scope case)', async () => {
    expect(await claim(ACAD_A, GTA, PROF)).toBe(PROF);
    expect(await twinOf(GTA)).toBe(PROF);
  });

  it('claim on an INACTIVE trainer\'s guest returns NULL and stamps nothing', async () => {
    expect(await claim(ACAD_A, GTAOLD, PROF)).toBeNull();
    expect(await twinOf(GTAOLD)).toBeNull();
  });
});

describe('repurpose detaches the twin stamp (trg_clear_guest_twin_on_repurpose)', () => {
  it('renaming a stamped row CLEARS the stamp (row repurposed to a different human)', async () => {
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';`);
    await db.exec(`UPDATE guest_players SET full_name = 'Bram Jansen', first_name = 'Bram' WHERE id = '${GA}';`);
    expect(await twinOf(GA)).toBeNull();
  });

  it('phone/notes updates KEEP the stamp', async () => {
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';`);
    await db.exec(`UPDATE guest_players SET phone = '0612345678', notes = 'x' WHERE id = '${GA}';`);
    expect(await twinOf(GA)).toBe(PROF);
  });

  it('moving the email AWAY from the twin profile\'s email CLEARS the stamp (email-only repurpose)', async () => {
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';`);
    await db.exec(`UPDATE guest_players SET email = 'someone.else@x.nl' WHERE id = '${GA}';`);
    expect(await twinOf(GA)).toBeNull();
  });

  it('correcting the email TOWARD the profile\'s email KEEPS the stamp (case/whitespace-insensitive)', async () => {
    // GA starts as 'Fam@Example.com'; PROF's profile email is 'fam@example.com'.
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';`);
    await db.exec(`UPDATE guest_players SET email = ' fam@example.com ' WHERE id = '${GA}';`);
    expect(await twinOf(GA)).toBe(PROF);
  });

  it('emptying the email KEEPS the stamp (removal is not a repurpose signal)', async () => {
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';`);
    await db.exec(`UPDATE guest_players SET email = NULL WHERE id = '${GA}';`);
    expect(await twinOf(GA)).toBe(PROF);
  });

  it('a twin of an EMAILLESS profile keeps the stamp on email changes (nothing to validate against)', async () => {
    await db.exec(`UPDATE profiles SET email = NULL WHERE id = '${PROF}';`);
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';`);
    await db.exec(`UPDATE guest_players SET email = 'enriched@later.nl' WHERE id = '${GA}';`);
    expect(await twinOf(GA)).toBe(PROF);
  });

  it('rewriting the stamp TOGETHER with the name keeps the new stamp (explicit re-assertion)', async () => {
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';`);
    await db.exec(`
      UPDATE guest_players SET full_name = 'Piet Peters', twin_of_profile_id = '${PROF2}' WHERE id = '${GA}';
    `);
    expect(await twinOf(GA)).toBe(PROF2);
  });

  it('a cleared stamp re-converges on the next add: the claim re-stamps the SAME row (typo-fix self-heal)', async () => {
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';`);
    await db.exec(`UPDATE guest_players SET full_name = 'Jan Janssen' WHERE id = '${GA}';`); // typo fix → cleared
    expect(await twinOf(GA)).toBeNull();
    expect(await claim(ACAD_A, GA, PROF)).toBe(PROF); // next add claims it right back
    expect(await twinOf(GA)).toBe(PROF);
  });
});

describe('find_guest_twin_for_academy — scope + determinism', () => {
  it('finds an academy-owned twin and an active-trainer-owned twin; oldest wins', async () => {
    await db.exec(`
      UPDATE guest_players SET twin_of_profile_id = '${PROF}', created_at = now() - interval '2 days' WHERE id = '${GTA}';
      UPDATE guest_players SET twin_of_profile_id = '${PROF}', created_at = now() - interval '1 day' WHERE id = '${GA}';
    `);
    expect(await findTwin(ACAD_A, PROF)).toBe(GTA); // deterministic: oldest first
  });

  it('does not cross academies: manager of A cannot see B\'s twin', async () => {
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GB}';`);
    expect(await findTwin(ACAD_A, PROF)).toBeNull();
  });

  it('returns NULL for a caller who does not manage the claimed academy', async () => {
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';`);
    await db.exec(`SELECT set_config('test.uid', '${MGR_B}', false)`);
    expect(await findTwin(ACAD_A, PROF)).toBeNull();
  });
});

describe('M4 — player visibility includes twin-stamped guests', () => {
  beforeEach(async () => {
    await db.exec(`
      INSERT INTO locations (id, name) VALUES ('${LOC}', 'Padel Arena');
      INSERT INTO availability_slots (id, start_time, end_time, trainer_id, max_participants, price_per_session, cyclus_name, location_id)
      VALUES ('${SLOT}', now(), now() + interval '1 hour', '${TR_A}', 4, 20, 'Najaar', '${LOC}');
    `);
    await db.exec(`SELECT set_config('test.uid', '${PLAYER_USER}', false)`);
  });

  it('get_my_linked_guest_bookings returns bookings of a guest TWINNED to me (family shared email)', async () => {
    // GA is Jan's twin but NOT linked (a sibling shares the email → the trigger never linked it).
    await db.exec(`
      UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';
      INSERT INTO bookings (slot_id, guest_player_id, status, payment_status) VALUES
        ('${SLOT}', '${GA}', 'confirmed', 'pending');
    `);
    const r = await db.query<{ j: unknown }>(`SELECT public.get_my_linked_guest_bookings() AS j`);
    const rows = r.rows[0].j as Array<{ slot_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].slot_id).toBe(SLOT);
  });

  it('get_my_paid_booking_ids covers invoices keyed by my twin guest', async () => {
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';`);
    const b = await db.query<{ id: string }>(`
      INSERT INTO bookings (slot_id, guest_player_id, status, payment_status)
      VALUES ('${SLOT}', '${GA}', 'confirmed', 'paid') RETURNING id
    `);
    const bookingId = b.rows[0].id;
    await db.query(
      `INSERT INTO invoices (status, booking_ids, guest_player_id) VALUES ('paid', $1, $2)`,
      [[bookingId], GA],
    );
    const r = await db.query<{ booking_id: string }>(`SELECT * FROM public.get_my_paid_booking_ids()`);
    expect(r.rows.map((x) => x.booking_id)).toContain(bookingId);
  });

  it('the linked_profile_id path still works unchanged', async () => {
    await db.exec(`
      UPDATE guest_players SET linked_profile_id = '${PROF}' WHERE id = '${GTA}';
      INSERT INTO bookings (slot_id, guest_player_id, status, payment_status) VALUES
        ('${SLOT}', '${GTA}', 'confirmed', 'pending');
    `);
    const r = await db.query<{ j: unknown }>(`SELECT public.get_my_linked_guest_bookings() AS j`);
    expect(r.rows[0].j as Array<unknown>).toHaveLength(1);
  });
});

describe('merge_guest_players — twin-aware guard + carry', () => {
  const merge = (src: string, tgt: string) =>
    db.query(`SELECT public.merge_guest_players('academy','${ACAD_A}',$1,$2,'{}'::jsonb) AS r`, [src, tgt]);

  it('REFUSES to merge rows referencing two different persons (twin vs linked)', async () => {
    await db.exec(`
      UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';
      UPDATE guest_players SET linked_profile_id = '${PROF2}' WHERE id = '${GTA}';
    `);
    await expect(merge(GTA, GA)).rejects.toThrow(/two different accounts/);
    // nothing merged
    expect(await twinOf(GA)).toBe(PROF);
    const src = await db.query(`SELECT 1 FROM guest_players WHERE id = '${GA}'`);
    expect(src.rows).toHaveLength(1);
  });

  it('carries the source\'s twin stamp to the target without tripping the unique index', async () => {
    // Duplicate-twin cleanup: GTA (trainer-owned, stamped) merges into GA (academy-owned, unstamped).
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GTA}';`);
    await merge(GTA, GA);
    expect(await twinOf(GA)).toBe(PROF); // inherited — the person mapping survives the cleanup
    const gone = await db.query(`SELECT 1 FROM guest_players WHERE id = '${GTA}'`);
    expect(gone.rows).toHaveLength(0);
  });

  it('same-person references (twin == linked) merge fine', async () => {
    await db.exec(`
      UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';
      UPDATE guest_players SET linked_profile_id = '${PROF}' WHERE id = '${GTA}';
    `);
    await merge(GTA, GA);
    expect(await twinOf(GA)).toBe(PROF);
    const r = await db.query<{ linked_profile_id: string | null }>(
      `SELECT linked_profile_id FROM guest_players WHERE id = '${GA}'`,
    );
    expect(r.rows[0].linked_profile_id).toBe(PROF); // linked carried too (pre-existing coalesce)
  });

  it('carries an ACADEMY-owned stamp into an unstamped academy row — pins the delete-before-update ordering', async () => {
    // Both rows are inside uniq_guest_twin_per_academy's scope: if the target UPDATE ever ran
    // before the source DELETE, this primary duplicate-twin cleanup would abort with 23505.
    await db.exec(`
      INSERT INTO guest_players (id, full_name, email, academy_profile_id, twin_of_profile_id)
      VALUES ('20000000-0000-0000-0000-0000000000f2', 'Jan Jansen', 'fam@example.com', '${ACAD_A}', '${PROF}');
    `);
    await merge('20000000-0000-0000-0000-0000000000f2', GA);
    expect(await twinOf(GA)).toBe(PROF);
  });

  it('a STALE family mislink does not dead-end an explicitly twinned row (per-row twin precedence)', async () => {
    // Emma's row: email-linked to the PARENT (PROF2, the trigger's no-name-guard mislink) but
    // explicitly twinned to HER OWN profile (PROF). Effective ref = twin → merging with a
    // ref-less duplicate of Emma must be allowed, and the twin must carry.
    await db.exec(`
      UPDATE guest_players SET linked_profile_id = '${PROF2}', twin_of_profile_id = '${PROF}' WHERE id = '${GTA}';
    `);
    await merge(GTA, GA);
    expect(await twinOf(GA)).toBe(PROF);
    // Round-2 audit: the conflicting STALE link must NOT be carried onto the survivor — a row
    // that is explicitly Emma's must never also grant the parent visibility into her data.
    const r = await db.query<{ linked_profile_id: string | null }>(
      `SELECT linked_profile_id FROM guest_players WHERE id = '${GA}'`,
    );
    expect(r.rows[0].linked_profile_id).toBeNull();
  });
});

describe('read-time precedence: an explicit twin OUTRANKS a stale inferred link (round-2 audit)', () => {
  // The conflicted-row shape: the CHILD's guest row, email-mislinked to the PARENT (PROF2) by the
  // no-name-guard trigger, then explicitly twinned to the child's own profile (PROF) by a manager
  // claim. Every player-side reader must show it ONLY to the child.
  beforeEach(async () => {
    await db.exec(`
      UPDATE guest_players SET linked_profile_id = '${PROF2}', twin_of_profile_id = '${PROF}' WHERE id = '${GA}';
      INSERT INTO locations (id, name) VALUES ('${LOC}', 'Padel Arena');
      INSERT INTO availability_slots (id, start_time, end_time, location_id, source_cycle_id)
      VALUES ('${SLOT}', now(), now() + interval '1 hour', '${LOC}', '30000000-0000-0000-0000-0000000000dd');
      INSERT INTO cycles (id) VALUES ('30000000-0000-0000-0000-0000000000dd');
      INSERT INTO bookings (slot_id, guest_player_id, status, payment_status) VALUES
        ('${SLOT}', '${GA}', 'confirmed', 'pending');
      INSERT INTO slot_priority_claims (slot_id, guest_player_id, status, claim_token)
      VALUES ('${SLOT}', '${GA}', 'pending', 'tok-conflicted');
    `);
  });

  it('the CHILD (twin) sees the bookings; the PARENT (stale link) does NOT', async () => {
    await db.exec(`SELECT set_config('test.uid', '${PLAYER_USER}', false)`);
    const child = await db.query<{ j: unknown }>(`SELECT public.get_my_linked_guest_bookings() AS j`);
    expect(child.rows[0].j as Array<unknown>).toHaveLength(1);

    await db.exec(`SELECT set_config('test.uid', '${PARENT_USER}', false)`);
    const parent = await db.query<{ j: unknown }>(`SELECT public.get_my_linked_guest_bookings() AS j`);
    expect(parent.rows[0].j as Array<unknown>).toHaveLength(0);
  });

  it('the rebook-claims card follows the same precedence', async () => {
    await db.exec(`SELECT set_config('test.uid', '${PLAYER_USER}', false)`);
    const child = await db.query(`SELECT * FROM public.get_my_pending_priority_claims()`);
    expect(child.rows).toHaveLength(1);

    await db.exec(`SELECT set_config('test.uid', '${PARENT_USER}', false)`);
    const parent = await db.query(`SELECT * FROM public.get_my_pending_priority_claims()`);
    expect(parent.rows).toHaveLength(0);
  });

  it('the member-window gate follows the same precedence', async () => {
    const CYCLE = '30000000-0000-0000-0000-0000000000dd';
    const child = await db.query<{ ok: boolean }>(
      `SELECT public.can_book_member_window($1, $2) AS ok`, [PLAYER_USER, CYCLE]);
    expect(child.rows[0].ok).toBe(true);
    const parent = await db.query<{ ok: boolean }>(
      `SELECT public.can_book_member_window($1, $2) AS ok`, [PARENT_USER, CYCLE]);
    expect(parent.rows[0].ok).toBe(false);
  });

  it('paid-invoice visibility follows the same precedence', async () => {
    const b = await db.query<{ id: string }>(
      `SELECT id FROM bookings WHERE guest_player_id = '${GA}' LIMIT 1`);
    await db.query(
      `INSERT INTO invoices (status, booking_ids, guest_player_id) VALUES ('paid', $1, $2)`,
      [[b.rows[0].id], GA],
    );
    await db.exec(`SELECT set_config('test.uid', '${PLAYER_USER}', false)`);
    const child = await db.query(`SELECT * FROM public.get_my_paid_booking_ids()`);
    expect(child.rows).toHaveLength(1);
    await db.exec(`SELECT set_config('test.uid', '${PARENT_USER}', false)`);
    const parent = await db.query(`SELECT * FROM public.get_my_paid_booking_ids()`);
    expect(parent.rows).toHaveLength(0);
  });

  it('an UNstamped linked row still shows to the linked profile (no regression for real links)', async () => {
    await db.exec(`
      UPDATE guest_players SET linked_profile_id = '${PROF}', twin_of_profile_id = NULL WHERE id = '${GA}';
    `);
    await db.exec(`SELECT set_config('test.uid', '${PLAYER_USER}', false)`);
    const r = await db.query<{ j: unknown }>(`SELECT public.get_my_linked_guest_bookings() AS j`);
    expect(r.rows[0].j as Array<unknown>).toHaveLength(1);
  });
});

describe('rebook readers include twin-stamped guests (verification follow-up)', () => {
  const CYCLE = '30000000-0000-0000-0000-0000000000dd';

  beforeEach(async () => {
    await db.exec(`
      INSERT INTO cycles (id, settings) VALUES ('${CYCLE}', '{}'::jsonb);
      INSERT INTO availability_slots (id, start_time, end_time, source_cycle_id, priority_window_ends_at)
      VALUES ('${SLOT}', now(), now() + interval '1 hour', '${CYCLE}', now() + interval '1 day');
    `);
    await db.exec(`SELECT set_config('test.uid', '${PLAYER_USER}', false)`);
  });

  it('get_my_pending_priority_claims shows a pending guest claim of my TWIN (family shared email)', async () => {
    await db.exec(`
      UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';
      INSERT INTO slot_priority_claims (slot_id, guest_player_id, status, claim_token)
      VALUES ('${SLOT}', '${GA}', 'pending', 'tok-twin');
    `);
    const r = await db.query<{ claim_token: string }>(`SELECT * FROM public.get_my_pending_priority_claims()`);
    expect(r.rows.map((x) => x.claim_token)).toContain('tok-twin');
  });

  it('an UNstamped, UNlinked guest claim stays invisible (no email-based widening)', async () => {
    await db.exec(`
      INSERT INTO slot_priority_claims (slot_id, guest_player_id, status, claim_token)
      VALUES ('${SLOT}', '${GA}', 'pending', 'tok-none');
    `);
    const r = await db.query(`SELECT * FROM public.get_my_pending_priority_claims()`);
    expect(r.rows).toHaveLength(0);
  });

  it('can_book_member_window clause (d): a guest claim in the round TWINNED to me grants the window', async () => {
    await db.exec(`
      INSERT INTO slot_priority_claims (slot_id, guest_player_id, status) VALUES ('${SLOT}', '${GA}', 'pending');
    `);
    const before = await db.query<{ ok: boolean }>(
      `SELECT public.can_book_member_window($1, $2) AS ok`, [PLAYER_USER, CYCLE]);
    expect(before.rows[0].ok).toBe(false); // unstamped → denied
    await db.exec(`UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';`);
    const after = await db.query<{ ok: boolean }>(
      `SELECT public.can_book_member_window($1, $2) AS ok`, [PLAYER_USER, CYCLE]);
    expect(after.rows[0].ok).toBe(true);
  });

  it('can_book_member_window clause (e): a priority-list guest TWINNED to me grants the window', async () => {
    await db.exec(`
      UPDATE cycles SET settings = jsonb_build_object('rebook_priority_guests', jsonb_build_array('${GA}'::text))
      WHERE id = '${CYCLE}';
      UPDATE guest_players SET twin_of_profile_id = '${PROF}' WHERE id = '${GA}';
    `);
    const r = await db.query<{ ok: boolean }>(
      `SELECT public.can_book_member_window($1, $2) AS ok`, [PLAYER_USER, CYCLE]);
    expect(r.rows[0].ok).toBe(true);
  });
});
