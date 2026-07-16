// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Person unification PHASE 2 (BACKFILL + MERGE): the pglite REHEARSAL the plan requires before the
// migration ever touches prod. Runs the REAL migrations (Phase 1 expand + invariant + the real
// repurpose-guard function + Phase 2 backfill) against a fixture set that exercises every locked
// rule — including the shapes the adversarial verification flagged as mutation survivors:
// multi-profile emails, a trusted twin inside a cluster, an agreeing linked_profile_id, both-keyed
// divergent rows on every money pair, the HARD verification firing (negative test), live H1/H2
// trust behavior, the GDPR scrubs, and the invoice-guard interaction with the live collapse.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

// profiles
const P_SOLO = '10000000-0000-0000-0000-000000000001'; // no guest anywhere
const P_PAIR = '10000000-0000-0000-0000-000000000002'; // unique email pair with G_PAIR
const P_TWIN = '10000000-0000-0000-0000-000000000003'; // G_TWIN stamped + same email (in a cluster)
const P_TWIN2 = '10000000-0000-0000-0000-000000000004'; // emailless roster twin
const P_TWIN3 = '10000000-0000-0000-0000-000000000005'; // G_TWIN_FAIL stamped, email mismatch
const P_FAM = '10000000-0000-0000-0000-000000000006'; // family email shared with 2 kid guests
const P_DUP1 = '10000000-0000-0000-0000-000000000007'; // two profiles sharing dup@x.nl
const P_DUP2 = '10000000-0000-0000-0000-000000000008';
// guests
const G_PAIR = '20000000-0000-0000-0000-000000000001'; // linked_profile_id AGREES with its B2 merge
const G_TWIN = '20000000-0000-0000-0000-000000000002';
const G_TWIN_SIB = '20000000-0000-0000-0000-000000000009'; // shares twin@x.nl → cluster with G_TWIN
const G_TWIN_NOEMAIL = '20000000-0000-0000-0000-000000000003';
const G_TWIN_FAIL = '20000000-0000-0000-0000-000000000004';
const G_KID1 = '20000000-0000-0000-0000-000000000005';
const G_KID2 = '20000000-0000-0000-0000-000000000006';
const G_NOEMAIL = '20000000-0000-0000-0000-000000000007';
const G_LINKED = '20000000-0000-0000-0000-000000000008'; // linked_profile_id=P_SOLO, no email match
const G_DUP = '20000000-0000-0000-0000-000000000010'; // email matches BOTH dup profiles
const SLOT = '30000000-0000-0000-0000-000000000001';

const uid = (n: number) => `40000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);

    CREATE TABLE public.profiles (
      id uuid PRIMARY KEY, user_id uuid NOT NULL, email text, full_name text,
      first_name text, last_name text, phone text, birth_date date,
      skill_rating numeric, rating_system text, rating_member_id text,
      avatar_url text, bio text, location text, preferred_language text,
      billing_business_name text, billing_address text, billing_btw_number text,
      stripe_customer_id text
    );
    CREATE TABLE public.guest_players (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name text, first_name text, last_name text, email text, phone text,
      birth_date date, skill_rating numeric, rating_system text,
      billing_business_name text, billing_address text, billing_btw_number text,
      academy_profile_id uuid, trainer_id uuid, source text,
      linked_profile_id uuid, twin_of_profile_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid,
      player_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
      guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE SET NULL,
      paid_by_player_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
      paid_by_guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE SET NULL,
      status text, payment_status text
    );
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      player_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
      guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE SET NULL,
      status text,
      paid_at timestamptz, sent_at timestamptz, subtotal numeric, vat_amount numeric,
      vat_rate numeric, total numeric, line_items jsonb, vat_breakdown jsonb,
      mollie_payment_id text, mollie_payment_url text, booking_ids uuid[],
      invoice_number text, invoice_date date, due_date date, trainer_id uuid,
      academy_profile_id uuid, player_name text, public_token text,
      public_token_revoked_at timestamptz, forwarded_at timestamptz, notes text,
      prices_include_vat boolean
    );
    CREATE TABLE public.intake_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      player_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
      guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE SET NULL
    );
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid,
      player_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
      guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE SET NULL,
      booked_by_player_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
      booked_by_guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE SET NULL,
      status text
    );
    CREATE TABLE public.session_player_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid,
      subject_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
      subject_guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE SET NULL,
      body text
    );
    CREATE TABLE public.academy_player_locations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      academy_profile_id uuid,
      profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
      guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE SET NULL,
      location_id uuid
    );
    CREATE TABLE public.academy_player_metadata (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      academy_profile_id uuid, trainer_profile_id uuid,
      profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
      guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE SET NULL
    );
    CREATE OR REPLACE FUNCTION public.update_updated_at_column()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN RETURN NEW; END $fn$;
    -- auth stubs (the invoice guard + repurpose guard read them)
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;
    CREATE OR REPLACE FUNCTION public.get_profile_id_for_user(_user_id uuid)
    RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT id FROM public.profiles WHERE user_id = _user_id LIMIT 1 $fn$;
  `);

  // ---- old-world fixture data (inserted BEFORE the backfill, like prod) ----
  await db.exec(`
    INSERT INTO auth.users (id) VALUES
      ('${uid(1)}'),('${uid(2)}'),('${uid(3)}'),('${uid(4)}'),('${uid(5)}'),('${uid(6)}'),('${uid(7)}'),('${uid(8)}');
    INSERT INTO public.profiles (id, user_id, email, full_name, stripe_customer_id, bio, avatar_url) VALUES
      ('${P_SOLO}',  '${uid(1)}', 'solo@x.nl',  'Solo Speler', NULL, NULL, NULL),
      ('${P_PAIR}',  '${uid(2)}', 'Pair@X.nl',  'Paula Pair',  'cus_PAIR', 'private bio', 'avatar.png'),
      ('${P_TWIN}',  '${uid(3)}', 'twin@x.nl',  'Tom Twin',    NULL, NULL, NULL),
      ('${P_TWIN2}', '${uid(4)}', 'twin2@x.nl', 'Tessa Twin',  NULL, NULL, NULL),
      ('${P_TWIN3}', '${uid(5)}', 'p3@x.nl',    'Theo Twin',   NULL, NULL, NULL),
      ('${P_FAM}',   '${uid(6)}', 'fam@x.nl',   'Papa Familie', NULL, NULL, NULL),
      ('${P_DUP1}',  '${uid(7)}', 'dup@x.nl',   'Dubbel Een',  NULL, NULL, NULL),
      ('${P_DUP2}',  '${uid(8)}', 'Dup@X.nl',   'Dubbel Twee', NULL, NULL, NULL);
    INSERT INTO public.guest_players (id, full_name, email, phone, birth_date, source, linked_profile_id, twin_of_profile_id) VALUES
      ('${G_PAIR}',        'Paula Pair',   'pair@x.nl',      '0611111111', '1990-01-01', 'csv_import', '${P_PAIR}', NULL),
      ('${G_TWIN}',        'Tom Twin',     'Twin@X.nl ',     NULL, NULL, 'roster_registered_twin', NULL, '${P_TWIN}'),
      ('${G_TWIN_SIB}',    'Tirza Twin',   'twin@x.nl',      NULL, NULL, 'intake', NULL, NULL),
      ('${G_TWIN_NOEMAIL}','Tessa Twin',   NULL,             NULL, NULL, 'roster_registered_twin', NULL, '${P_TWIN2}'),
      ('${G_TWIN_FAIL}',   'Theo Twin',    'different@x.nl', NULL, NULL, 'roster_registered_twin', NULL, '${P_TWIN3}'),
      ('${G_KID1}',        'Kim Familie',  'fam@x.nl',       NULL, NULL, 'intake', NULL, NULL),
      ('${G_KID2}',        'Koen Familie', 'FAM@x.nl',       NULL, NULL, 'intake', '${P_FAM}', NULL),
      ('${G_NOEMAIL}',     'Walk-in Wim',  NULL,             NULL, NULL, 'manual', NULL, NULL),
      ('${G_LINKED}',      'Lisa Link',    'lisa@x.nl',      NULL, NULL, 'manual', '${P_SOLO}', NULL),
      ('${G_DUP}',         'Diede Dubbel', 'dup@x.nl',       NULL, NULL, 'intake', NULL, NULL);
    -- keyed rows: singles + a both-keyed DIVERGENT row for every money pair
    INSERT INTO public.bookings (id, slot_id, player_id, guest_player_id, paid_by_player_id, paid_by_guest_player_id, status) VALUES
      ('50000000-0000-0000-0000-000000000001', '${SLOT}', NULL, '${G_PAIR}', NULL, NULL, 'confirmed'),
      ('50000000-0000-0000-0000-000000000002', '${SLOT}', '${P_SOLO}', NULL, NULL, NULL, 'confirmed'),
      ('50000000-0000-0000-0000-000000000003', '${SLOT}', '${P_SOLO}', '${G_KID1}', NULL, NULL, 'confirmed'),
      ('50000000-0000-0000-0000-000000000004', '${SLOT}', NULL, '${G_NOEMAIL}', '${P_SOLO}', '${G_KID2}', 'confirmed');
    INSERT INTO public.invoices (id, player_id, guest_player_id, status) VALUES
      ('60000000-0000-0000-0000-000000000001', NULL, '${G_KID1}', 'paid'),
      ('60000000-0000-0000-0000-000000000002', '${P_SOLO}', '${G_LINKED}', 'draft');
    INSERT INTO public.intake_requests (id, player_id) VALUES
      ('70000000-0000-0000-0000-000000000001', '${P_PAIR}');
    INSERT INTO public.slot_priority_claims (id, slot_id, player_id, guest_player_id, booked_by_player_id, booked_by_guest_player_id, status) VALUES
      ('80000000-0000-0000-0000-000000000001', '${SLOT}', NULL, '${G_TWIN}', NULL, '${G_PAIR}', 'pending'),
      ('80000000-0000-0000-0000-000000000002', '${SLOT}', '${P_SOLO}', '${G_KID1}', '${P_FAM}', '${G_KID2}', 'pending');
    INSERT INTO public.session_player_notes (id, slot_id, subject_profile_id, subject_guest_player_id, body) VALUES
      ('90000000-0000-0000-0000-000000000001', '${SLOT}', NULL, '${G_KID2}', 'note'),
      ('90000000-0000-0000-0000-000000000002', '${SLOT}', '${P_SOLO}', '${G_NOEMAIL}', 'both-keyed note');
    INSERT INTO public.academy_player_locations (id, academy_profile_id, profile_id, guest_player_id, location_id) VALUES
      ('a0000000-0000-0000-0000-000000000001', gen_random_uuid(), NULL, '${G_LINKED}', gen_random_uuid()),
      ('a0000000-0000-0000-0000-000000000002', gen_random_uuid(), '${P_SOLO}', '${G_KID1}', gen_random_uuid());
    INSERT INTO public.academy_player_metadata (id, academy_profile_id, profile_id, guest_player_id) VALUES
      ('b0000000-0000-0000-0000-000000000001', gen_random_uuid(), '${P_TWIN}', NULL),
      ('b0000000-0000-0000-0000-000000000002', gen_random_uuid(), '${P_FAM}', '${G_KID2}');
  `);

  // ---- the REAL migrations, in order (strip only GRANT/REVOKE — PGlite has no roles) ----
  const fs = await import('node:fs/promises');
  const strip = (s: string) => s.replace(/^(REVOKE|GRANT)[^;]*;$/gm, '');
  for (const file of [
    'supabase/migrations/20260826260000_persons_expand.sql',
    'supabase/migrations/20260826270000_person_links_one_profile_per_person.sql',
    'supabase/migrations/20260826250000_repurpose_trigger_definer.sql', // the real repurpose fn
    'supabase/migrations/20260826280000_persons_backfill.sql',
  ]) {
    await db.exec(strip(await fs.readFile(file, 'utf8')));
  }
  // bind the repurpose guard + the (re-created) invoice guard — their CREATE TRIGGER statements
  // live in earlier migrations whose other deps are out of scope here; the FUNCTION bodies above
  // are the real ones
  await db.exec(`
    DROP TRIGGER IF EXISTS trg_clear_guest_twin_on_repurpose ON public.guest_players;
    CREATE TRIGGER trg_clear_guest_twin_on_repurpose
      BEFORE UPDATE ON public.guest_players
      FOR EACH ROW EXECUTE FUNCTION public.clear_guest_twin_on_repurpose();
    DROP TRIGGER IF EXISTS trg_protect_invoice_financial_columns_for_players ON public.invoices;
    CREATE TRIGGER trg_protect_invoice_financial_columns_for_players
      BEFORE UPDATE ON public.invoices
      FOR EACH ROW EXECUTE FUNCTION public.protect_invoice_financial_columns_for_players();
  `);
});

const personOfGuest = async (g: string) => {
  const r = await db.query<{ person_id: string }>(
    `SELECT person_id FROM person_links WHERE guest_player_id = $1`, [g]);
  return r.rows[0]?.person_id ?? null;
};
const personOfProfile = async (p: string) => {
  const r = await db.query<{ person_id: string }>(
    `SELECT person_id FROM person_links WHERE profile_id = $1`, [p]);
  return r.rows[0]?.person_id ?? null;
};
const reviewRows = async (kind: string) => {
  const r = await db.query<{ guest_player_id: string | null; status: string; email: string | null }>(
    `SELECT guest_player_id, status, email FROM person_merge_review WHERE kind = $1 ORDER BY created_at`, [kind]);
  return r.rows;
};
const col = async (table: string, id: string, c: string) => {
  const r = await db.query<Record<string, string | null>>(
    `SELECT ${c} FROM public.${table} WHERE id = $1`, [id]);
  return r.rows[0]?.[c] ?? null;
};

describe('backfill — the locked merge rules', () => {
  it('every profile has a person with ITS OWN uuid (deterministic ids)', async () => {
    for (const p of [P_SOLO, P_PAIR, P_TWIN, P_TWIN2, P_TWIN3, P_FAM, P_DUP1, P_DUP2]) {
      expect(await personOfProfile(p)).toBe(p);
    }
  });

  it('B1: twin-trust merges — email match (case/space-insensitive, even inside a cluster) and the emailless roster twin', async () => {
    expect(await personOfGuest(G_TWIN)).toBe(P_TWIN);
    expect(await personOfGuest(G_TWIN_NOEMAIL)).toBe(P_TWIN2);
  });

  it('B2: the unique email-pair merge; case-insensitive both sides', async () => {
    expect(await personOfGuest(G_PAIR)).toBe(P_PAIR);
  });

  it('a guest whose email matches TWO profiles NEVER merges — own person + multi_profile_email review row', async () => {
    expect(await personOfGuest(G_DUP)).toBe(G_DUP);
    const rows = await reviewRows('multi_profile_email');
    expect(rows.map((r) => r.guest_player_id)).toContain(G_DUP);
  });

  it('a twin stamp FAILING the trust rule does NOT merge — own person + review row', async () => {
    expect(await personOfGuest(G_TWIN_FAIL)).toBe(G_TWIN_FAIL);
    const rows = await reviewRows('twin_trust_failure');
    expect(rows.map((r) => r.guest_player_id)).toContain(G_TWIN_FAIL);
  });

  it('shared-email family NEVER merges; the cluster review EXCLUDES already-merged members', async () => {
    expect(await personOfGuest(G_KID1)).toBe(G_KID1);
    expect(await personOfGuest(G_KID2)).toBe(G_KID2);
    expect(await personOfGuest(G_TWIN_SIB)).toBe(G_TWIN_SIB); // the twin's cluster-mate stays separate
    const rows = await reviewRows('shared_email_cluster');
    const ids = rows.map((r) => r.guest_player_id).sort();
    // G_TWIN is IN the twin@x.nl cluster but already trust-merged → excluded from the pending queue
    expect(ids).toEqual([G_KID1, G_KID2, G_TWIN_SIB].sort());
  });

  it('linked_profile_id is NEVER consumed — mismatch reported, agreement produces NO noise', async () => {
    expect(await personOfGuest(G_LINKED)).toBe(G_LINKED); // NOT P_SOLO
    const rows = await reviewRows('linked_mismatch');
    const ids = rows.map((r) => r.guest_player_id);
    expect(ids).toContain(G_LINKED);
    expect(ids).not.toContain(G_PAIR); // its link AGREES with the B2 merge → no mismatch row
  });

  it('no-email guest → own person + review row (but NOT the merged emailless twin)', async () => {
    expect(await personOfGuest(G_NOEMAIL)).toBe(G_NOEMAIL);
    const ids = (await reviewRows('no_email_guest')).map((r) => r.guest_player_id);
    expect(ids).toContain(G_NOEMAIL);
    expect(ids).not.toContain(G_TWIN_NOEMAIL);
  });

  it('audit trail: the auto-merges are logged as applied', async () => {
    const twin = await reviewRows('auto_merged_twin_trust');
    expect(twin.map((r) => r.guest_player_id).sort()).toEqual([G_TWIN, G_TWIN_NOEMAIL].sort());
    expect(twin.every((r) => r.status === 'applied')).toBe(true);
    const pair = await reviewRows('auto_merged_email_pair');
    expect(pair.map((r) => r.guest_player_id)).toEqual([G_PAIR]);
  });

  it('gap-fill: profile wins ALL account fields (incl. email); guest fills only true gaps', async () => {
    const r = await db.query<{ full_name: string; email: string; phone: string | null; birth_date: string | null }>(
      `SELECT full_name, email, phone, birth_date FROM persons WHERE id = $1`, [P_PAIR]);
    expect(r.rows[0].full_name).toBe('Paula Pair');
    expect(r.rows[0].email).toBe('Pair@X.nl');   // the ACCOUNT email — never guest-overwritten
    expect(r.rows[0].phone).toBe('0611111111');  // guest filled the gap
    expect(r.rows[0].birth_date).not.toBeNull();
  });

  it('persons/link counts reconcile (8 profiles + 10 guests − 3 merges = 15 persons, 18 links)', async () => {
    const p = await db.query<{ n: string }>(`SELECT count(*)::text n FROM persons`);
    const l = await db.query<{ n: string }>(`SELECT count(*)::text n FROM person_links`);
    expect(Number(p.rows[0].n)).toBe(15);
    expect(Number(l.rows[0].n)).toBe(18);
  });
});

describe('backfill — the 9-pair stamp sweep (guest-side first on EVERY pair)', () => {
  it('stamps every keyed row with the right person', async () => {
    expect(await col('bookings', '50000000-0000-0000-0000-000000000001', 'person_id')).toBe(P_PAIR);
    expect(await col('bookings', '50000000-0000-0000-0000-000000000002', 'person_id')).toBe(P_SOLO);
    expect(await col('bookings', '50000000-0000-0000-0000-000000000003', 'person_id')).toBe(G_KID1); // both-keyed: guest side
    expect(await col('bookings', '50000000-0000-0000-0000-000000000004', 'person_id')).toBe(G_NOEMAIL);
    expect(await col('bookings', '50000000-0000-0000-0000-000000000004', 'paid_by_person_id')).toBe(G_KID2); // both-keyed paid_by: guest side
    expect(await col('invoices', '60000000-0000-0000-0000-000000000001', 'person_id')).toBe(G_KID1);
    expect(await col('invoices', '60000000-0000-0000-0000-000000000002', 'person_id')).toBe(G_LINKED); // both-keyed: guest side
    expect(await col('intake_requests', '70000000-0000-0000-0000-000000000001', 'person_id')).toBe(P_PAIR);
    expect(await col('slot_priority_claims', '80000000-0000-0000-0000-000000000001', 'person_id')).toBe(P_TWIN);
    expect(await col('slot_priority_claims', '80000000-0000-0000-0000-000000000001', 'booked_by_person_id')).toBe(P_PAIR);
    expect(await col('slot_priority_claims', '80000000-0000-0000-0000-000000000002', 'person_id')).toBe(G_KID1); // both-keyed: guest side
    expect(await col('slot_priority_claims', '80000000-0000-0000-0000-000000000002', 'booked_by_person_id')).toBe(G_KID2); // both-keyed booked_by: guest side
    expect(await col('session_player_notes', '90000000-0000-0000-0000-000000000001', 'subject_person_id')).toBe(G_KID2);
    expect(await col('session_player_notes', '90000000-0000-0000-0000-000000000002', 'subject_person_id')).toBe(G_NOEMAIL); // both-keyed subject: guest side
    expect(await col('academy_player_locations', 'a0000000-0000-0000-0000-000000000001', 'person_id')).toBe(G_LINKED);
    expect(await col('academy_player_locations', 'a0000000-0000-0000-0000-000000000002', 'person_id')).toBe(G_KID1); // both-keyed: guest side
    expect(await col('academy_player_metadata', 'b0000000-0000-0000-0000-000000000001', 'person_id')).toBe(P_TWIN);
    expect(await col('academy_player_metadata', 'b0000000-0000-0000-0000-000000000002', 'person_id')).toBe(G_KID2); // both-keyed: guest side
  });

  it('the backfill is IDEMPOTENT — content-level, not just counts', async () => {
    const snap = async () => ({
      links: (await db.query(
        `SELECT person_id, profile_id, guest_player_id FROM person_links ORDER BY person_id, profile_id, guest_player_id`)).rows,
      persons: (await db.query(
        `SELECT id, user_id, full_name, email, phone FROM persons ORDER BY id`)).rows,
      review: (await db.query(
        `SELECT kind, guest_player_id, profile_id, status FROM person_merge_review ORDER BY kind, guest_player_id, profile_id, status`)).rows,
    });
    const before = await snap();
    const fs = await import('node:fs/promises');
    const sql = (await fs.readFile('supabase/migrations/20260826280000_persons_backfill.sql', 'utf8'))
      .replace(/^(REVOKE|GRANT)[^;]*;$/gm, '');
    await db.exec(sql);
    expect(await snap()).toEqual(before);
  });
});

describe('live map maintenance (H1/H2/H3)', () => {
  it('H1: a new profile mints its person + link at signup', async () => {
    const NP = '10000000-0000-0000-0000-000000000099';
    await db.exec(`
      INSERT INTO auth.users (id) VALUES ('${uid(99)}');
      INSERT INTO profiles (id, user_id, email, full_name) VALUES ('${NP}', '${uid(99)}', 'new@x.nl', 'Nieuw Persoon');
    `);
    expect(await personOfProfile(NP)).toBe(NP);
  });

  it('H1: the account-claim flow — a signup collapses its pre-existing unique-pair guest', async () => {
    const GC = '20000000-0000-0000-0000-000000000090';
    const PC = '10000000-0000-0000-0000-000000000090';
    await db.exec(`INSERT INTO guest_players (id, full_name, email) VALUES ('${GC}', 'Claim Kees', 'claim@x.nl');`);
    const b = await db.query<{ id: string }>(
      `INSERT INTO bookings (slot_id, guest_player_id, status) VALUES ('${SLOT}', '${GC}', 'confirmed') RETURNING id`);
    expect(await personOfGuest(GC)).toBe(GC); // own person pre-signup
    await db.exec(`
      INSERT INTO auth.users (id) VALUES ('${uid(90)}');
      INSERT INTO profiles (id, user_id, email, full_name) VALUES ('${PC}', '${uid(90)}', 'claim@x.nl', 'Claim Kees');
    `);
    expect(await personOfGuest(GC)).toBe(PC); // collapsed into the new profile person
    expect((await db.query(`SELECT 1 FROM persons WHERE id = '${GC}'`)).rows).toHaveLength(0);
    expect(await col('bookings', b.rows[0].id, 'person_id')).toBe(PC); // rows re-stamped
    const audit = await reviewRows('auto_merged_email_pair');
    expect(audit.map((r) => r.guest_player_id)).toContain(GC);
  });

  it('H2: a new guest with a unique email pair joins the profile person at INSERT + audit row', async () => {
    const NG = '20000000-0000-0000-0000-000000000098';
    await db.exec(`INSERT INTO guest_players (id, full_name, email) VALUES ('${NG}', 'Nieuw Persoon', 'new@x.nl');`);
    expect(await personOfGuest(NG)).toBe('10000000-0000-0000-0000-000000000099');
    const audit = await reviewRows('auto_merged_email_pair');
    expect(audit.map((r) => r.guest_player_id)).toContain(NG);
  });

  it('H2: a SECOND guest with that email mints its own person + a live cluster review row', async () => {
    const NG2 = '20000000-0000-0000-0000-000000000097';
    await db.exec(`INSERT INTO guest_players (id, full_name, email) VALUES ('${NG2}', 'Ander Mens', 'new@x.nl');`);
    expect(await personOfGuest(NG2)).toBe(NG2);
    const rows = await reviewRows('shared_email_cluster');
    expect(rows.map((r) => r.guest_player_id)).toContain(NG2);
  });

  it('H2: the Phase-0 twin mint (stamp + matching email) lands on the profile person', async () => {
    const NG3 = '20000000-0000-0000-0000-000000000096';
    await db.exec(`
      INSERT INTO guest_players (id, full_name, email, source, twin_of_profile_id)
      VALUES ('${NG3}', 'Solo Speler', 'solo@x.nl', 'roster_registered_twin', '${P_SOLO}');
    `);
    expect(await personOfGuest(NG3)).toBe(P_SOLO);
  });

  it('H2: a stamped insert with a MISMATCHED email does NOT merge — own person + live trust-failure row', async () => {
    const NG8 = '20000000-0000-0000-0000-000000000089';
    await db.exec(`
      INSERT INTO guest_players (id, full_name, email, source, twin_of_profile_id)
      VALUES ('${NG8}', 'Foute Stempel', 'elders@x.nl', 'roster_registered_twin', '${P_TWIN3}');
    `);
    expect(await personOfGuest(NG8)).toBe(NG8); // never the profile's person
    const rows = await reviewRows('twin_trust_failure');
    expect(rows.map((r) => r.guest_player_id)).toContain(NG8);
  });

  it('H2: an EMAILLESS roster-twin insert merges (trust rule, emailless branch)', async () => {
    const NG9 = '20000000-0000-0000-0000-000000000088';
    await db.exec(`
      INSERT INTO guest_players (id, full_name, source, twin_of_profile_id)
      VALUES ('${NG9}', 'Theo Twin', 'roster_registered_twin', '${P_TWIN3}');
    `);
    expect(await personOfGuest(NG9)).toBe(P_TWIN3);
  });

  it('H3: a LIVE claim (trust passes, safe) collapses into the profile person and re-stamps rows — even past a PAID both-keyed invoice owned by the caller (guard exemption)', async () => {
    const NG4 = '20000000-0000-0000-0000-000000000095';
    await db.exec(`INSERT INTO guest_players (id, full_name, email) VALUES ('${NG4}', 'Tessa Twin', 'twin2b@x.nl');`);
    const b = await db.query<{ id: string }>(
      `INSERT INTO bookings (slot_id, guest_player_id, status) VALUES ('${SLOT}', '${NG4}', 'confirmed') RETURNING id`);
    // a PAID invoice keyed by BOTH the guest and the claiming caller's own profile — the exact
    // shape that hard-failed before the guard's person-column exemption
    const inv = await db.query<{ id: string }>(
      `INSERT INTO invoices (player_id, guest_player_id, status) VALUES ('${P_TWIN2}', '${NG4}', 'paid') RETURNING id`);
    await db.exec(`
      UPDATE guest_players SET email = 'twin2@x.nl' WHERE id = '${NG4}';
      SET test.uid = '${uid(4)}';
      UPDATE guest_players SET twin_of_profile_id = '${P_TWIN2}' WHERE id = '${NG4}';
      SET test.uid = '';
    `);
    expect(await personOfGuest(NG4)).toBe(P_TWIN2);
    expect((await db.query(`SELECT 1 FROM persons WHERE id = '${NG4}'`)).rows).toHaveLength(0);
    expect(await col('bookings', b.rows[0].id, 'person_id')).toBe(P_TWIN2);
    expect(await col('invoices', inv.rows[0].id, 'person_id')).toBe(P_TWIN2); // guard exempted the person-only update
  });

  it('H3: an email MOVED AWAY on a link-merged guest (no stamp) files a merged_guest_email_moved review row', async () => {
    // G_PAIR was B2-merged (no twin stamp). Repurposing it by email is the split signal.
    await db.exec(`UPDATE guest_players SET email = 'iemand.anders@y.nl' WHERE id = '${G_PAIR}';`);
    const rows = await reviewRows('merged_guest_email_moved');
    expect(rows.map((r) => r.guest_player_id)).toContain(G_PAIR);
    expect(await personOfGuest(G_PAIR)).toBe(P_PAIR); // data untouched — split needs human judgment
  });

  it('H3: a repurpose-RENAME on a merged twin detaches the stamp and files a needs-split review row', async () => {
    await db.exec(`UPDATE guest_players SET full_name = 'Iemand Anders' WHERE id = '${G_TWIN}';`);
    const twin = await db.query<{ twin_of_profile_id: string | null }>(
      `SELECT twin_of_profile_id FROM guest_players WHERE id = '${G_TWIN}'`);
    expect(twin.rows[0].twin_of_profile_id).toBeNull(); // repurpose guard cleared it
    const rows = await reviewRows('twin_detached_needs_split');
    expect(rows.map((r) => r.guest_player_id)).toContain(G_TWIN);
    expect(await personOfGuest(G_TWIN)).toBe(P_TWIN);
  });

  it('H3: an UNSAFE collapse (guest person has other sources) files a review row instead', async () => {
    const NG5 = '20000000-0000-0000-0000-000000000094';
    const NG6 = '20000000-0000-0000-0000-000000000093';
    await db.exec(`
      INSERT INTO guest_players (id, full_name, email) VALUES
        ('${NG5}', 'Twee Bronnen', 'twee@x.nl'), ('${NG6}', 'Andere Bron', 'ander2@x.nl');
      UPDATE person_links SET person_id = '${NG5}' WHERE guest_player_id = '${NG6}';
      DELETE FROM persons WHERE id = '${NG6}';
      UPDATE guest_players SET email = 'p3@x.nl' WHERE id = '${NG5}';
      UPDATE guest_players SET twin_of_profile_id = '${P_TWIN3}' WHERE id = '${NG5}';
    `);
    expect(await personOfGuest(NG5)).toBe(NG5);
    const rows = await reviewRows('twin_detached_needs_split');
    expect(rows.map((r) => r.guest_player_id)).toContain(NG5);
  });
});

describe('H4 + GDPR — no orphaned PII copies anywhere', () => {
  it('hard-deleting a sole-source guest removes its person, NULLs stamps, and scrubs its review rows', async () => {
    const NG7 = '20000000-0000-0000-0000-000000000092';
    await db.exec(`
      INSERT INTO guest_players (id, full_name, source, twin_of_profile_id)
      VALUES ('${NG7}', 'Tijdelijk Iemand', 'roster_registered_twin', NULL);
    `);
    const b = await db.query<{ id: string }>(
      `INSERT INTO bookings (slot_id, guest_player_id, status) VALUES ('${SLOT}', '${NG7}', 'confirmed') RETURNING id`);
    // it has a pending review row (no_email_guest, via live parity? backfill-only kind — create one for the test)
    await db.exec(`
      INSERT INTO person_merge_review (kind, email, guest_player_id, details)
      VALUES ('no_email_guest', NULL, '${NG7}', jsonb_build_object('guest_name', 'Tijdelijk Iemand'));
      INSERT INTO person_merge_review (kind, status, email, guest_player_id, details)
      VALUES ('auto_merged_email_pair', 'applied', 'x@x.nl', '${NG7}', jsonb_build_object('guest_name', 'Tijdelijk Iemand'));
      DELETE FROM guest_players WHERE id = '${NG7}';
    `);
    expect((await db.query(`SELECT 1 FROM persons WHERE id = '${NG7}'`)).rows).toHaveLength(0);
    expect(await col('bookings', b.rows[0].id, 'person_id')).toBeNull();
    // pending row deleted; applied audit row kept but SCRUBBED
    const remaining = await db.query<{ kind: string; email: string | null; details: Record<string, unknown> }>(
      `SELECT kind, email, details FROM person_merge_review
       WHERE details ? 'guest_name' AND details->>'guest_name' = 'Tijdelijk Iemand'`);
    expect(remaining.rows).toHaveLength(0); // no PII payload survives
  });

  it('GDPR account deletion with a surviving merged person: account fields scrubbed, identity re-derived from the guest, user_id freed for re-signup', async () => {
    // P_PAIR's person = profile + G_PAIR. Delete the profile (the delete-user-data flow).
    await db.exec(`DELETE FROM profiles WHERE id = '${P_PAIR}';`);
    const kept = await db.query<Record<string, string | null>>(
      `SELECT user_id, stripe_customer_id, bio, avatar_url, full_name, email FROM persons WHERE id = '${P_PAIR}'`);
    expect(kept.rows).toHaveLength(1); // person survives (guest source remains)
    expect(kept.rows[0].user_id).toBeNull();            // account link gone
    expect(kept.rows[0].stripe_customer_id).toBeNull(); // account-only PII scrubbed
    expect(kept.rows[0].bio).toBeNull();
    expect(kept.rows[0].avatar_url).toBeNull();
    expect(kept.rows[0].email).toBe('iemand.anders@y.nl'); // re-derived from the remaining guest
    // the freed user_id no longer blocks a fresh profile for the same auth user
    await db.exec(`
      INSERT INTO profiles (id, user_id, email, full_name)
      VALUES ('10000000-0000-0000-0000-000000000091', '${uid(2)}', 'nieuw2@x.nl', 'Paula Nieuw');
    `);
    expect(await personOfProfile('10000000-0000-0000-0000-000000000091')).toBe('10000000-0000-0000-0000-000000000091');
  });

  it('deleting the LAST source of that person removes it entirely', async () => {
    await db.exec(`DELETE FROM guest_players WHERE id = '${G_PAIR}';`);
    expect((await db.query(`SELECT 1 FROM persons WHERE id = '${P_PAIR}'`)).rows).toHaveLength(0);
  });
});

describe('the HARD verification actually fires (negative test — run last)', () => {
  it('a user_id integrity violation makes the backfill RAISE (and restoring it heals the re-run)', async () => {
    // corrupt: point a linked person's user_id at a different auth user
    await db.exec(`
      INSERT INTO auth.users (id) VALUES ('${uid(77)}');
      UPDATE persons SET user_id = '${uid(77)}' WHERE id = '${P_SOLO}';
    `);
    const fs = await import('node:fs/promises');
    const sql = (await fs.readFile('supabase/migrations/20260826280000_persons_backfill.sql', 'utf8'))
      .replace(/^(REVOKE|GRANT)[^;]*;$/gm, '');
    await expect(db.exec(sql)).rejects.toThrow(/user_id mismatching/);
    await db.exec(`UPDATE persons SET user_id = '${uid(1)}' WHERE id = '${P_SOLO}';`);
    await db.exec(sql); // green again
  });
});
