// @vitest-environment node
// P1-6 regression: create_invoice_deduped (migration 20260706120300_p1_6_create_invoice_deduped.sql)
// dedups on booking_ids OVERLAP, not just exact-set equality, so [A] then [A,B] for the same
// trainer+recipient returns the first invoice rather than inserting a second (double-charge).
//
// Phase 3.4 (migration 20260902100000_phase34_create_invoice_deduped_person.sql) extends that guard
// to the PERSON: a merged person holding BOTH a profile ref and a guest ref cannot be double-billed
// across their two keys. The lock + overlap recheck resolve guest-first through person_links; an
// unlinked recipient degrades to the exact pre-3.4 per-key behaviour (first three cases below).
//
// Runs the REAL deployed SQL loaded from the migration files (REVOKE/GRANT stripped: roles absent in
// PGlite). The stamp_person_id_invoices trigger is inlined below as a faithful copy of the deployed
// one (20260826260000_persons_expand.sql) — create_invoice_deduped's INSERT never sets person_id, so
// the trigger is what stamps it, exactly as in production.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

function readMigrations(): string {
  return [
    '20260706120300_p1_6_create_invoice_deduped.sql',
    '20260902100000_phase34_create_invoice_deduped_person.sql',
  ]
    .map((f) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8'))
    .join('\n')
    .split('\n')
    .filter((l) => !/^(REVOKE|GRANT)\b/.test(l))
    .join('\n');
}

const TRAINER = '30000000-0000-0000-0000-000000000001';
const PLAYER_A = '40000000-0000-0000-0000-000000000001';
const PLAYER_B = '40000000-0000-0000-0000-000000000002';
const BK_A = '50000000-0000-0000-0000-00000000000a';
const BK_B = '50000000-0000-0000-0000-00000000000b';

// Phase 3.4 fixtures: merged person X (profile P + guest G) and unrelated person Y (profile Q).
const PERSON_X = '10000000-0000-0000-0000-0000000000e1';
const PERSON_Y = '10000000-0000-0000-0000-0000000000f2';
const PROFILE_P = '40000000-0000-0000-0000-0000000000a1';
const GUEST_G = '20000000-0000-0000-0000-0000000000b1';
const PROFILE_Q = '40000000-0000-0000-0000-0000000000a2';

const createDeduped = async (payload: Record<string, unknown>) =>
  (await db.query<{ r: { deduped: boolean; id: string } }>(`SELECT public.create_invoice_deduped($1::jsonb) AS r`, [JSON.stringify(payload)]))
    .rows[0].r;

const basePayload = (num: string, player: string, bookingIds: string[]) => ({
  trainer_id: TRAINER,
  invoice_number: num,
  invoice_date: '2026-07-02',
  due_date: '2026-07-16',
  player_id: player,
  player_name: 'Test Player',
  line_items: [{ description: 'x', quantity: 1, unit_price: 10 }],
  subtotal: 10,
  vat_rate: 21,
  vat_amount: 2.1,
  total: 12.1,
  status: 'sent',
  booking_ids: bookingIds,
});

// Same as basePayload but addressed to a GUEST ref (player_id absent).
const guestPayload = (num: string, guest: string, bookingIds: string[]) => {
  const { player_id: _drop, ...rest } = basePayload(num, '00000000-0000-0000-0000-000000000000', bookingIds);
  void _drop;
  return { ...rest, invoice_number: num, guest_player_id: guest };
};

const activeCount = async (): Promise<number> =>
  Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.invoices WHERE status <> 'cancelled'`)).rows[0].n);

const link = async (person: string, col: 'profile_id' | 'guest_player_id', ref: string): Promise<void> => {
  await db.query(`INSERT INTO public.persons(id) VALUES ($1) ON CONFLICT DO NOTHING`, [person]);
  await db.query(`INSERT INTO public.person_links(person_id, ${col}) VALUES ($1, $2)`, [person, ref]);
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trainer_id uuid NOT NULL,
      academy_profile_id uuid,
      invoice_number text NOT NULL,
      invoice_date date NOT NULL,
      due_date date NOT NULL,
      player_id uuid,
      guest_player_id uuid,
      person_id uuid,
      player_name text NOT NULL,
      player_business_name text,
      player_address text,
      player_btw_number text,
      line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
      subtotal numeric NOT NULL DEFAULT 0,
      vat_rate numeric NOT NULL DEFAULT 21,
      vat_amount numeric NOT NULL DEFAULT 0,
      total numeric NOT NULL DEFAULT 0,
      vat_breakdown jsonb,
      prices_include_vat boolean NOT NULL DEFAULT true,
      status text NOT NULL DEFAULT 'draft',
      booking_ids uuid[] DEFAULT '{}',
      split_count integer,
      sent_at timestamptz,
      paid_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT unique_invoice_number_per_trainer UNIQUE (trainer_id, invoice_number)
    );
    -- Person model (minimal, prod-shaped): profile_id + guest_player_id are UNIQUE,
    -- matching person_links so the guest-first resolution yields at most one row.
    CREATE TABLE public.persons (id uuid PRIMARY KEY, user_id uuid UNIQUE);
    CREATE TABLE public.person_links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id uuid NOT NULL,
      profile_id uuid UNIQUE,
      guest_player_id uuid UNIQUE
    );
    -- Faithful copy of the deployed BEFORE trigger (20260826260000): the INSERT in
    -- create_invoice_deduped omits person_id, so this is what stamps it.
    CREATE FUNCTION public.stamp_person_id_invoices() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.player_id IS NOT NULL OR NEW.guest_player_id IS NOT NULL
         OR (TG_OP = 'UPDATE' AND (OLD.player_id IS NOT NULL OR OLD.guest_player_id IS NOT NULL)) THEN
        NEW.person_id := COALESCE(
          (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = NEW.guest_player_id),
          (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = NEW.player_id)
        );
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER trg_stamp_person_id_invoices
      BEFORE INSERT OR UPDATE OF player_id, guest_player_id, person_id
      ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.stamp_person_id_invoices();
  `);
  await db.exec(readMigrations()); // the REAL migration files — a hotfix to either fails this suite
});

beforeEach(async () => {
  await db.exec(`DELETE FROM public.invoices; DELETE FROM public.person_links; DELETE FROM public.persons;`);
});

describe('create_invoice_deduped', () => {
  it('dedups an OVERLAPPING-BUT-UNEQUAL set to the first invoice (no double-charge)', async () => {
    const first = await createDeduped(basePayload('INV-1', PLAYER_A, [BK_A]));
    expect(first.deduped).toBe(false);
    const second = await createDeduped(basePayload('INV-2', PLAYER_A, [BK_A, BK_B]));
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
    expect(await activeCount()).toBe(1);
  });

  it('does NOT dedup across different recipients', async () => {
    const a = await createDeduped(basePayload('INV-1', PLAYER_A, [BK_A]));
    const b = await createDeduped(basePayload('INV-2', PLAYER_B, [BK_A]));
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(false);
    expect(await activeCount()).toBe(2);
  });

  it('does NOT dedup against a cancelled prior invoice', async () => {
    const first = await createDeduped(basePayload('INV-1', PLAYER_A, [BK_A]));
    await db.query(`UPDATE public.invoices SET status = 'cancelled' WHERE id = $1`, [first.id]);
    const second = await createDeduped(basePayload('INV-2', PLAYER_A, [BK_A, BK_B]));
    expect(second.deduped).toBe(false);
    expect(await activeCount()).toBe(1);
  });

  describe('Phase 3.4 — person-keyed cross-key dedup', () => {
    it('dedups a merged person across their two keys: guest invoice then profile invoice, same booking', async () => {
      await link(PERSON_X, 'profile_id', PROFILE_P);
      await link(PERSON_X, 'guest_player_id', GUEST_G);

      // First invoice addressed to the GUEST ref.
      const first = await createDeduped(guestPayload('INV-1', GUEST_G, [BK_A]));
      expect(first.deduped).toBe(false);

      // Second addressed to the PROFILE ref, overlapping booking → the person arm
      // finds the sibling under the guest key and returns it (no second invoice).
      const second = await createDeduped(basePayload('INV-2', PROFILE_P, [BK_A, BK_B]));
      expect(second.deduped).toBe(true);
      expect(second.id).toBe(first.id);
      expect(await activeCount()).toBe(1);
    });

    it('dedups in the other direction too: profile invoice then guest invoice', async () => {
      await link(PERSON_X, 'profile_id', PROFILE_P);
      await link(PERSON_X, 'guest_player_id', GUEST_G);

      const first = await createDeduped(basePayload('INV-1', PROFILE_P, [BK_A]));
      expect(first.deduped).toBe(false);
      const second = await createDeduped(guestPayload('INV-2', GUEST_G, [BK_A, BK_B]));
      expect(second.deduped).toBe(true);
      expect(second.id).toBe(first.id);
      expect(await activeCount()).toBe(1);
    });

    it('does NOT over-merge: two DIFFERENT persons sharing a booking id stay separate', async () => {
      await link(PERSON_X, 'profile_id', PROFILE_P);
      await link(PERSON_Y, 'profile_id', PROFILE_Q);

      const a = await createDeduped(basePayload('INV-1', PROFILE_P, [BK_A]));
      const b = await createDeduped(basePayload('INV-2', PROFILE_Q, [BK_A]));
      expect(a.deduped).toBe(false);
      expect(b.deduped).toBe(false);
      expect(await activeCount()).toBe(2);
    });

    it('does NOT dedup a merged person across their keys when bookings DO NOT overlap (distinct charges)', async () => {
      await link(PERSON_X, 'profile_id', PROFILE_P);
      await link(PERSON_X, 'guest_player_id', GUEST_G);

      const first = await createDeduped(guestPayload('INV-1', GUEST_G, [BK_A]));
      expect(first.deduped).toBe(false);
      // Non-overlapping bookings → legitimately a second, separate invoice.
      const second = await createDeduped(basePayload('INV-2', PROFILE_P, [BK_B]));
      expect(second.deduped).toBe(false);
      expect(await activeCount()).toBe(2);
    });
  });
});
