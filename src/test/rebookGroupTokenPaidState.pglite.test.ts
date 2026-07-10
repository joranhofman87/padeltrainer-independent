// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Paid-group gating (migration 20260803100100): get_rebook_group_by_token must surface
// group_invoice_status and drop can_rebook_group once the group invoice is PAID (teammates get the
// informational state, not pay buttons) — while an UNPAID active invoice keeps can_rebook_group
// true (any member may complete an abandoned captain checkout). Runs the real fn against Postgres.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const S = '52000000-0000-0000-0000-000000000001';
const G_PAID = 'a1000000-0000-0000-0000-000000000001';
const G_OPEN = 'a1000000-0000-0000-0000-000000000002';
const G_NONE = 'a1000000-0000-0000-0000-000000000003';
const P1 = 'ee000000-0000-0000-0000-000000000001';
const P2 = 'ee000000-0000-0000-0000-000000000002';
const P3 = 'ee000000-0000-0000-0000-000000000003';

const grp = async (token: string) =>
  (await db.query<{ r: { can_rebook_group: boolean; group_invoice_status: string | null } }>(
    `SELECT public.get_rebook_group_by_token($1) AS r`, [token])).rows[0].r;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, status text, booking_id uuid,
      rebook_group_id uuid, claim_token text, player_id uuid, guest_player_id uuid);
    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY, start_time timestamptz, end_time timestamptz, cyclus_id uuid,
      cyclus_name text, price_per_session numeric, max_participants integer,
      priority_window_ends_at timestamptz, trainer_id uuid, academy_profile_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY, payment_status text);
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rebook_group_id uuid, status text,
      created_at timestamptz DEFAULT now());
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, first_name text, full_name text, email text);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, first_name text, full_name text, email text);

    INSERT INTO public.availability_slots (id, start_time, end_time, priority_window_ends_at, trainer_id)
      VALUES ('${S}', now() + interval '7 days', now() + interval '7 days 1 hour', now() + interval '3 days', gen_random_uuid());
    INSERT INTO public.profiles VALUES
      ('${P1}', 'Anna', 'Anna A', 'a@x.nl'), ('${P2}', 'Bo', 'Bo B', 'b@x.nl'), ('${P3}', 'Cas', 'Cas C', 'c@x.nl');

    INSERT INTO public.slot_priority_claims (slot_id, status, rebook_group_id, claim_token, player_id) VALUES
      ('${S}', 'pending', '${G_PAID}', 'mate-paidgrp', '${P2}'),  -- teammate in a PAID group
      ('${S}', 'claimed', '${G_PAID}', 'captain-paid', '${P1}'),  -- its captain
      ('${S}', 'pending', '${G_OPEN}', 'mate-opengrp', '${P2}'),  -- member of a group with an UNPAID invoice
      ('${S}', 'pending', '${G_NONE}', 'mate-noinv',   '${P3}');  -- member of a group with NO invoice

    INSERT INTO public.invoices (rebook_group_id, status) VALUES
      ('${G_PAID}', 'paid'),
      ('${G_OPEN}', 'sent');
  `);
  const combined = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260803100100_group_token_paid_state.sql'), 'utf8');
  // Load only the group-token half (the resume RPC has its own suite + schema).
  const groupHalf = combined.slice(0, combined.indexOf('-- (2) Resume RPC'));
  await db.exec(groupHalf);
});

describe('get_rebook_group_by_token — paid-group gating', () => {
  it('drops can_rebook_group + surfaces status for a PAID group invoice', async () => {
    const r = await grp('mate-paidgrp');
    expect(r.group_invoice_status).toBe('paid');
    expect(r.can_rebook_group).toBe(false);
  });

  it('keeps can_rebook_group for an UNPAID active invoice (abandoned-captain completion)', async () => {
    const r = await grp('mate-opengrp');
    expect(r.group_invoice_status).toBe('sent');
    expect(r.can_rebook_group).toBe(true);
  });

  it('keeps can_rebook_group when no invoice exists', async () => {
    const r = await grp('mate-noinv');
    expect(r.group_invoice_status).toBeNull();
    expect(r.can_rebook_group).toBe(true);
  });
});
