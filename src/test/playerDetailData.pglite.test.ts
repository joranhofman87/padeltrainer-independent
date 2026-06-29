// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Cross-tenant isolation characterization for fetchPlayerInvoices (the player-detail invoice fetch
// shared by the trainer + academy pages). Runs the REAL helper against real Postgres (PGlite) and
// proves a trainer/academy only ever sees invoices it owns — the tenant `.eq` is the isolation
// guarantee. Also unit-tests the pure groupSlotsIntoCycluses grouping. See src/lib/playerDetailData.ts.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { fetchPlayerInvoices, groupSlotsIntoCycluses } from '@/lib/playerDetailData';

let db: PGlite;
let supa: SupabaseClient<Database>;

const TRAINER_A = '10000000-0000-0000-0000-0000000000a0';
const TRAINER_B = '10000000-0000-0000-0000-0000000000b0';
const ACADEMY_X = '11000000-0000-0000-0000-0000000000e0';
const GUEST_G = '20000000-0000-0000-0000-00000000000a';
const GUEST_H = '20000000-0000-0000-0000-00000000000b';
const PROFILE_P = '30000000-0000-0000-0000-0000000000a1';

const INV_A_G = 'a0000000-0000-0000-0000-0000000000a1'; // trainer A, guest G
const INV_B_G = 'a0000000-0000-0000-0000-0000000000b1'; // trainer B, guest G (must NOT leak to A)
const INV_X_G = 'a0000000-0000-0000-0000-0000000000c1'; // academy X, guest G
const INV_A_H = 'a0000000-0000-0000-0000-0000000000a2'; // trainer A, guest H (must NOT leak to G)
const INV_A_P = 'a0000000-0000-0000-0000-0000000000a3'; // trainer A, profile P
const INV_A_G2 = 'a0000000-0000-0000-0000-0000000000a4'; // trainer A, guest G — older date (ordering)

beforeAll(async () => {
  db = new PGlite();
  supa = createPgliteSupabase(db) as unknown as SupabaseClient<Database>;
  await db.exec(`
    CREATE TABLE invoices (
      id uuid PRIMARY KEY,
      invoice_number text, invoice_date text, due_date text, total numeric,
      status text, pdf_url text, sent_at text,
      trainer_id uuid, academy_profile_id uuid,
      guest_player_id uuid, player_id uuid
    );
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM invoices;`);
  await db.exec(`INSERT INTO invoices (id, invoice_number, invoice_date, trainer_id, academy_profile_id, guest_player_id, player_id) VALUES
    ('${INV_A_G}','A-G','2026-03-01','${TRAINER_A}', NULL, '${GUEST_G}', NULL),
    ('${INV_A_G2}','A-G2','2026-01-01','${TRAINER_A}', NULL, '${GUEST_G}', NULL),
    ('${INV_B_G}','B-G','2026-03-01','${TRAINER_B}', NULL, '${GUEST_G}', NULL),
    ('${INV_X_G}','X-G','2026-03-01', NULL, '${ACADEMY_X}', '${GUEST_G}', NULL),
    ('${INV_A_H}','A-H','2026-03-01','${TRAINER_A}', NULL, '${GUEST_H}', NULL),
    ('${INV_A_P}','A-P','2026-03-01','${TRAINER_A}', NULL, NULL, '${PROFILE_P}');`);
});

describe('fetchPlayerInvoices — cross-tenant + per-player isolation', () => {
  it('trainer scope returns ONLY this trainer’s invoices for the guest (not trainer B, not academy X)', async () => {
    const rows = await fetchPlayerInvoices({ kind: 'trainer', id: TRAINER_A }, { kind: 'guest', id: GUEST_G }, supa);
    expect(rows.map((r) => r.id).sort()).toEqual([INV_A_G, INV_A_G2].sort());
  });

  it('academy scope returns ONLY this academy’s invoice (not either trainer)', async () => {
    const rows = await fetchPlayerInvoices({ kind: 'academy', id: ACADEMY_X }, { kind: 'guest', id: GUEST_G }, supa);
    expect(rows.map((r) => r.id)).toEqual([INV_X_G]);
  });

  it('isolates by player within the same tenant (guest G ≠ guest H)', async () => {
    const rows = await fetchPlayerInvoices({ kind: 'trainer', id: TRAINER_A }, { kind: 'guest', id: GUEST_G }, supa);
    expect(rows.map((r) => r.id)).not.toContain(INV_A_H);
  });

  it('registered-profile path filters on player_id', async () => {
    const rows = await fetchPlayerInvoices({ kind: 'trainer', id: TRAINER_A }, { kind: 'profile', id: PROFILE_P }, supa);
    expect(rows.map((r) => r.id)).toEqual([INV_A_P]);
  });

  it('orders newest invoice_date first', async () => {
    const rows = await fetchPlayerInvoices({ kind: 'trainer', id: TRAINER_A }, { kind: 'guest', id: GUEST_G }, supa);
    expect(rows.map((r) => r.id)).toEqual([INV_A_G, INV_A_G2]); // 2026-03-01 before 2026-01-01
  });
});

describe('groupSlotsIntoCycluses — pure grouping', () => {
  it('groups slots by cyclus_id, counts sessions, and sorts newest last_session first', () => {
    const out = groupSlotsIntoCycluses(
      [
        { id: 's1', cyclus_id: 'c1', cyclus_name: 'Spring', start_time: '2026-01-06T10:00:00Z' },
        { id: 's2', cyclus_id: 'c1', cyclus_name: 'Spring', start_time: '2026-01-13T10:00:00Z' },
        { id: 's3', cyclus_id: 'c2', cyclus_name: 'Summer', start_time: '2026-06-01T10:00:00Z' },
      ],
      'Single sessions',
    );
    expect(out.map((c) => c.cyclus_id)).toEqual(['c2', 'c1']); // Summer (newer) first
    const spring = out.find((c) => c.cyclus_id === 'c1')!;
    expect(spring.session_count).toBe(2);
    expect(spring.first_session).toBe('2026-01-06T10:00:00.000Z');
    expect(spring.last_session).toBe('2026-01-13T10:00:00.000Z');
  });

  it('falls back to the single-sessions label + slot id when cyclus_id is null', () => {
    const out = groupSlotsIntoCycluses([{ id: 's9', cyclus_id: null, cyclus_name: null, start_time: '2026-02-01T10:00:00Z' }], 'Single sessions');
    expect(out).toHaveLength(1);
    expect(out[0].cyclus_id).toBe('s9');
    expect(out[0].cyclus_name).toBe('Single sessions');
  });
});
