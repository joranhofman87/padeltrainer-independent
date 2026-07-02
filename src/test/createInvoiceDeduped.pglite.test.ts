// @vitest-environment node
// P1-6 regression: create_invoice_deduped (migration <ts>_create_invoice_deduped.sql) dedups on
// booking_ids OVERLAP, not just exact-set equality, so [A] then [A,B] for the same trainer+recipient
// returns the first invoice rather than inserting a second (double-charge). Function body copied
// verbatim from the migration; `supabase db reset` in CI validates the migration itself applies.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

const TRAINER = '30000000-0000-0000-0000-000000000001';
const PLAYER_A = '40000000-0000-0000-0000-000000000001';
const PLAYER_B = '40000000-0000-0000-0000-000000000002';
const BK_A = '50000000-0000-0000-0000-00000000000a';
const BK_B = '50000000-0000-0000-0000-00000000000b';

const createDeduped = async (payload: Record<string, unknown>) =>
  (await db.query<{ r: any }>(`SELECT public.create_invoice_deduped($1::jsonb) AS r`, [JSON.stringify(payload)]))
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

const activeCount = async (): Promise<number> =>
  Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.invoices WHERE status <> 'cancelled'`)).rows[0].n);

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
  `);
  // Function body copied verbatim from the migration (GRANT/REVOKE stripped: roles absent in PGlite).
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.create_invoice_deduped(_payload jsonb)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE
      v_trainer_id uuid := (_payload->>'trainer_id')::uuid;
      v_player_id uuid := NULLIF(_payload->>'player_id', '')::uuid;
      v_guest_player_id uuid := NULLIF(_payload->>'guest_player_id', '')::uuid;
      v_booking_ids uuid[];
      v_recipient_key text;
      v_winner public.invoices%ROWTYPE;
      v_new public.invoices%ROWTYPE;
    BEGIN
      IF v_trainer_id IS NULL THEN RAISE EXCEPTION 'create_invoice_deduped: trainer_id is required'; END IF;
      SELECT COALESCE(array_agg(elem::uuid), '{}'::uuid[]) INTO v_booking_ids
      FROM jsonb_array_elements_text(COALESCE(_payload->'booking_ids', '[]'::jsonb)) AS elem;
      v_recipient_key := v_trainer_id::text || ':' || COALESCE(v_player_id::text, v_guest_player_id::text, 'none');
      PERFORM pg_advisory_xact_lock(hashtextextended(v_recipient_key, 0));
      IF array_length(v_booking_ids, 1) > 0 THEN
        SELECT i.* INTO v_winner FROM public.invoices i
        WHERE i.trainer_id = v_trainer_id AND i.status <> 'cancelled' AND i.booking_ids && v_booking_ids
          AND ((v_player_id IS NOT NULL AND i.player_id = v_player_id)
            OR (v_player_id IS NULL AND v_guest_player_id IS NOT NULL AND i.guest_player_id = v_guest_player_id))
        ORDER BY i.created_at ASC LIMIT 1;
        IF FOUND THEN
          RETURN jsonb_build_object('id', v_winner.id, 'invoice_number', v_winner.invoice_number,
            'status', v_winner.status, 'sent_at', v_winner.sent_at,
            'booking_ids', to_jsonb(v_winner.booking_ids), 'total', v_winner.total, 'deduped', true);
        END IF;
      END IF;
      INSERT INTO public.invoices (
        trainer_id, academy_profile_id, invoice_number, invoice_date, due_date, player_id, guest_player_id,
        player_name, player_business_name, player_address, player_btw_number, line_items, subtotal, vat_rate,
        vat_amount, total, vat_breakdown, prices_include_vat, status, booking_ids, split_count, paid_at, sent_at
      ) VALUES (
        v_trainer_id, NULLIF(_payload->>'academy_profile_id', '')::uuid, _payload->>'invoice_number',
        (_payload->>'invoice_date')::date, (_payload->>'due_date')::date, v_player_id, v_guest_player_id,
        _payload->>'player_name', _payload->>'player_business_name', _payload->>'player_address',
        _payload->>'player_btw_number', COALESCE(_payload->'line_items', '[]'::jsonb),
        COALESCE((_payload->>'subtotal')::numeric, 0), COALESCE((_payload->>'vat_rate')::numeric, 21),
        COALESCE((_payload->>'vat_amount')::numeric, 0), COALESCE((_payload->>'total')::numeric, 0),
        CASE WHEN _payload ? 'vat_breakdown' THEN _payload->'vat_breakdown' ELSE NULL END,
        COALESCE((_payload->>'prices_include_vat')::boolean, true), COALESCE(_payload->>'status', 'draft'),
        v_booking_ids, NULLIF(_payload->>'split_count', '')::integer,
        NULLIF(_payload->>'paid_at', '')::timestamptz, NULLIF(_payload->>'sent_at', '')::timestamptz
      ) RETURNING * INTO v_new;
      RETURN jsonb_build_object('id', v_new.id, 'invoice_number', v_new.invoice_number,
        'status', v_new.status, 'sent_at', v_new.sent_at,
        'booking_ids', to_jsonb(v_new.booking_ids), 'total', v_new.total, 'deduped', false);
    END; $$;
  `);
});

beforeEach(async () => { await db.exec(`DELETE FROM public.invoices;`); });

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
});
