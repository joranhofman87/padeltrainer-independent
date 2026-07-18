// @vitest-environment node
// Phase 3.5a: get_my_invoices — the person-keyed player invoice LIST (migration
// 20260903100000_phase35a_player_invoice_visibility.sql) + the pure-profile RLS policies.
//
// Pins the BROKEN_NOW fix (a merged person's guest-keyed invoices become visible), the
// twin/linked bridge, the split-pending freeze (whole row withheld, both-keyed included),
// can_edit_billing = pure-profile only, no cross-person leak, draft exclusion — and that the
// direct RLS SELECT/UPDATE paths are now PURE-PROFILE (FAM-02: guest-side rows flow only
// through the frozen reader; players can no longer billing-edit a both-keyed invoice).
//
// Runs the REAL migration file (REVOKE/GRANT stripped only where roles are absent — here the
// authenticated role IS created, so grants are kept). get_profile_id_for_user / get_my_person_id
// are faithful copies of the deployed definitions (20260826290000).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

// merged person: profile P (user U) + guest G via person_links
const U = 'b0000000-0000-0000-0000-000000000001';
const P = 'a0000000-0000-0000-0000-000000000001';
const PERSON = 'e0000000-0000-0000-0000-000000000001';
const G = '70000000-0000-0000-0000-000000000001';
// twin-bridge guest (linked-but-unmerged: twin stamp, NO person link)
const GTWIN = '70000000-0000-0000-0000-000000000002';
// frozen guest of the same person
const GFROZEN = '70000000-0000-0000-0000-000000000003';
// unrelated player
const U9 = 'b0000000-0000-0000-0000-000000000009';
const P9 = 'a0000000-0000-0000-0000-000000000009';
const TRAINER = '30000000-0000-0000-0000-000000000001';

async function asUser<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET test.uid = '${uid}'; SET ROLE authenticated;`);
  try { return await fn(); } finally { await db.exec(`RESET ROLE; SET test.uid = '';`); }
}

type InvoiceRow = { id: string; invoice_number: string; can_edit_billing: boolean };
const myInvoices = async (): Promise<InvoiceRow[]> =>
  (await db.query<InvoiceRow>(`SELECT * FROM public.get_my_invoices()`)).rows;

let invSeq = 0;
const insertInvoice = async (opts: {
  player?: string | null; guest?: string | null; status?: string; date?: string;
}): Promise<string> => {
  invSeq += 1;
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.invoices (trainer_id, invoice_number, invoice_date, due_date, player_name, status, player_id, guest_player_id)
     VALUES ($1, $2, $3::date, '2026-07-30', 'Test', $4, $5, $6) RETURNING id`,
    [TRAINER, `INV-${invSeq}`, opts.date ?? '2026-07-01', opts.status ?? 'sent', opts.player ?? null, opts.guest ?? null],
  );
  return r.rows[0].id;
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE ROLE anon;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;

    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid UNIQUE);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, twin_of_profile_id uuid, linked_profile_id uuid);
    CREATE TABLE public.persons (id uuid PRIMARY KEY);
    CREATE TABLE public.person_links (person_id uuid, profile_id uuid UNIQUE, guest_player_id uuid UNIQUE);
    CREATE TABLE public.person_merge_review (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text, status text, guest_player_id uuid);
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trainer_id uuid NOT NULL,
      invoice_number text NOT NULL,
      invoice_date date NOT NULL,
      due_date date NOT NULL,
      player_id uuid,
      guest_player_id uuid,
      person_id uuid,
      player_name text NOT NULL,
      player_business_name text, player_address text, player_btw_number text,
      subtotal numeric NOT NULL DEFAULT 0, vat_rate numeric NOT NULL DEFAULT 21,
      vat_amount numeric NOT NULL DEFAULT 0, total numeric NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'draft',
      pdf_url text, sent_at timestamptz, paid_at timestamptz, notes text
    );
    ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
    GRANT SELECT, UPDATE ON public.invoices TO authenticated;
    -- Prod reality: authenticated can self-read profiles (RLS self-row policy); the
    -- UPDATE policy's profiles subquery runs with the caller's privileges.
    GRANT SELECT ON public.profiles TO authenticated;

    -- Faithful copy of the deployed BEFORE trigger's stamp (20260826260000): the person_id
    -- on invoices is derived guest-first from person_links.
    CREATE FUNCTION public.stamp_person_id_invoices() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.player_id IS NOT NULL OR NEW.guest_player_id IS NOT NULL THEN
        NEW.person_id := COALESCE(
          (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = NEW.guest_player_id),
          (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = NEW.player_id));
      END IF;
      RETURN NEW;
    END; $fn$;
    CREATE TRIGGER trg_stamp BEFORE INSERT OR UPDATE OF player_id, guest_player_id
      ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.stamp_person_id_invoices();

    -- Faithful copies of the deployed helpers (20260826290000).
    CREATE OR REPLACE FUNCTION public.get_profile_id_for_user(_u uuid)
      RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT p.id FROM public.profiles p WHERE p.user_id = _u LIMIT 1 $fn$;
    CREATE OR REPLACE FUNCTION public.get_my_person_id()
      RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
        SELECT pl.person_id FROM public.person_links pl
        JOIN public.profiles p ON p.id = pl.profile_id
        WHERE p.user_id = auth.uid() $fn$;
  `);

  // Load the REAL migration (grants kept: authenticated exists here).
  const mig = readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260903100000_phase35a_player_invoice_visibility.sql'),
    'utf8',
  );
  await db.exec(mig);

  // Fixtures.
  await db.exec(`
    INSERT INTO public.profiles (id, user_id) VALUES
      ('${P}', '${U}'), ('${P9}', '${U9}');
    INSERT INTO public.guest_players (id, twin_of_profile_id, linked_profile_id) VALUES
      ('${G}', NULL, NULL),
      ('${GTWIN}', '${P}', NULL),
      ('${GFROZEN}', NULL, NULL);
    INSERT INTO public.persons (id) VALUES ('${PERSON}');
    INSERT INTO public.person_links (person_id, profile_id, guest_player_id) VALUES
      ('${PERSON}', '${P}', NULL),
      ('${PERSON}', NULL, '${G}'),
      ('${PERSON}', NULL, '${GFROZEN}');
    INSERT INTO public.person_merge_review (kind, status, guest_player_id) VALUES
      ('merged_guest_email_moved', 'pending', '${GFROZEN}');
  `);
});

describe('get_my_invoices (Phase 3.5a)', () => {
  it('returns pure-profile invoices with can_edit_billing=true', async () => {
    const id = await insertInvoice({ player: P });
    const rows = await asUser(U, myInvoices);
    const mine = rows.find((r) => r.id === id);
    expect(mine).toBeTruthy();
    expect(mine!.can_edit_billing).toBe(true);
  });

  it('THE FIX: returns a merged person\'s GUEST-keyed invoice (was invisible), can_edit_billing=false', async () => {
    const id = await insertInvoice({ guest: G });
    const rows = await asUser(U, myInvoices);
    const mine = rows.find((r) => r.id === id);
    expect(mine).toBeTruthy();
    expect(mine!.can_edit_billing).toBe(false);
  });

  it('returns a twin-bridge guest invoice (linked-but-unmerged, no person link)', async () => {
    const id = await insertInvoice({ guest: GTWIN });
    const rows = await asUser(U, myInvoices);
    expect(rows.some((r) => r.id === id)).toBe(true);
  });

  it('withholds a split-frozen guest invoice entirely (guest-only AND both-keyed)', async () => {
    const guestOnly = await insertInvoice({ guest: GFROZEN });
    const bothKeyed = await insertInvoice({ player: P, guest: GFROZEN });
    const rows = await asUser(U, myInvoices);
    expect(rows.some((r) => r.id === guestOnly)).toBe(false);
    // both-keyed: player_id came from the email linker (inference) — withheld while frozen
    expect(rows.some((r) => r.id === bothKeyed)).toBe(false);
  });

  it('excludes drafts and other persons\' invoices', async () => {
    const draft = await insertInvoice({ player: P, status: 'draft' });
    const other = await insertInvoice({ player: P9 });
    const rows = await asUser(U, myInvoices);
    expect(rows.some((r) => r.id === draft)).toBe(false);
    expect(rows.some((r) => r.id === other)).toBe(false);
    // and the unrelated user does not see P's invoices
    const otherRows = await asUser(U9, myInvoices);
    expect(otherRows.some((r) => r.can_edit_billing === false)).toBe(false);
    expect(otherRows.every((r) => r.id === other || r.can_edit_billing)).toBe(true);
  });

  it('a both-keyed NON-frozen invoice is visible (person arm) but NOT billing-editable', async () => {
    const id = await insertInvoice({ player: P, guest: G });
    const rows = await asUser(U, myInvoices);
    const mine = rows.find((r) => r.id === id);
    expect(mine).toBeTruthy();
    expect(mine!.can_edit_billing).toBe(false);
  });
});

describe('pure-profile RLS policies (Phase 3.5a)', () => {
  it('direct SELECT returns pure-profile rows only (guest/both-keyed flow via the reader)', async () => {
    const pure = await insertInvoice({ player: P });
    const both = await insertInvoice({ player: P, guest: G });
    const guestOnly = await insertInvoice({ guest: G });
    const rows = await asUser(U, async () =>
      (await db.query<{ id: string }>(`SELECT id FROM public.invoices`)).rows);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(pure);
    expect(ids).not.toContain(both);
    expect(ids).not.toContain(guestOnly);
  });

  it('UPDATE: billing edit works on a pure-profile row, is blocked on a both-keyed row', async () => {
    const pure = await insertInvoice({ player: P });
    const both = await insertInvoice({ player: P, guest: G });
    await asUser(U, async () => {
      await db.query(`UPDATE public.invoices SET player_business_name = 'Acme' WHERE id = $1`, [pure]);
      // RLS silently skips non-visible rows on UPDATE — assert zero rows changed.
      await db.query(`UPDATE public.invoices SET player_business_name = 'Evil' WHERE id = $1`, [both]);
    });
    const check = await db.query<{ id: string; player_business_name: string | null }>(
      `SELECT id, player_business_name FROM public.invoices WHERE id = ANY($1::uuid[])`, [[pure, both]]);
    expect(check.rows.find((r) => r.id === pure)!.player_business_name).toBe('Acme');
    expect(check.rows.find((r) => r.id === both)!.player_business_name).toBeNull();
  });
});
