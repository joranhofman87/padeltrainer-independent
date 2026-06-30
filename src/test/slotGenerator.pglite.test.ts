// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Integration test for generateCycleWithSlots (the quick slot/cycle generator create-lib): runs the
// REAL lib (createCycle + insertAvailabilitySlots + planSlots) against real Postgres (PGlite). Asserts
// it creates exactly one DRAFT cycle + N private slots, that drafts are excluded by the public
// booking query, that overlapping starts are deduped, and that a failed slot insert deletes the
// just-created cycle (abort cleanup).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { generateCycleWithSlots, SlotGeneratorError, type GenerateCycleInput } from '@/lib/slotGenerator';
import { planSlots, type SlotPlanConfig } from '@/lib/slotPlan';

let db: PGlite;
let supa: SupabaseClient<Database>;

const TRAINER = '10000000-0000-0000-0000-000000000001';
const LOCATION = '20000000-0000-0000-0000-000000000002';

// Mondays, 15:00–18:00 @60 over 2 weeks → 2 Mondays × 3 slots = 6.
const plan: SlotPlanConfig = {
  weekdays: ['monday'],
  windowStart: '15:00',
  windowEnd: '18:00',
  slotDurationMin: 60,
  startDate: '2026-06-01',
  weeks: 2,
  timezone: 'Europe/Amsterdam',
};

const input = (over: Partial<GenerateCycleInput> = {}): GenerateCycleInput => ({
  ownerType: 'trainer',
  ownerId: TRAINER,
  cycleName: 'Summer training',
  trainerId: TRAINER,
  locationId: LOCATION,
  pricePerSession: 20,
  maxParticipants: 4,
  allowSingleBooking: true,
  publishVisibility: 'public',
  plan,
  ...over,
});

const count = async (sql: string, params: unknown[] = []) =>
  Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0].n);

beforeAll(async () => {
  db = new PGlite();
  supa = createPgliteSupabase(db) as unknown as SupabaseClient<Database>;
  await db.exec(`
    CREATE TABLE cycles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_type text, owner_id uuid, name text, description text,
      start_date date, end_date date, enrollment_deadline date, is_always_open boolean,
      settings jsonb, status text, type text, location_id uuid,
      price_per_session numeric, total_price numeric, currency text, terms text, price_table jsonb,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE availability_slots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trainer_id uuid, academy_profile_id uuid, location_id uuid, court_type text,
      start_time timestamptz NOT NULL, end_time timestamptz,
      price_per_session numeric, total_price numeric,
      max_participants integer CHECK (max_participants IS NULL OR max_participants <= 8),
      allow_single_booking boolean, is_public boolean, prices_include_vat boolean,
      cyclus_id uuid, cyclus_name text, rating_system text, min_rating numeric, max_rating numeric,
      extra_costs jsonb, created_at timestamptz DEFAULT now()
    );
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM availability_slots; DELETE FROM cycles;`);
});

describe('generateCycleWithSlots (against real Postgres)', () => {
  it('creates one DRAFT cyclus PER (weekday+time) series, each priced for its own sessions', async () => {
    // Mondays 15:00–18:00 @60 over 2 weeks → 3 series (Mon 15:00 / 16:00 / 17:00), 2 sessions each.
    const res = await generateCycleWithSlots(input(), supa);
    expect(res.slotsCreated).toBe(6);
    expect(res.skippedOverlaps).toBe(0);
    expect(res.cyclesCreated).toBe(3);
    expect(res.cycleIds).toHaveLength(3);
    expect(await count('cycles')).toBe(3);

    const names: string[] = [];
    for (const cid of res.cycleIds) {
      const cycle = (
        await db.query<{
          name: string;
          status: string;
          type: string;
          price_per_session: number;
          total_price: number;
          settings: Record<string, unknown>;
        }>(`SELECT name, status, type, price_per_session, total_price, settings FROM cycles WHERE id = $1`, [cid])
      ).rows[0];
      expect(cycle.status).toBe('draft');
      expect(cycle.type).toBe('cyclus');
      expect(Number(cycle.price_per_session)).toBe(20);
      expect(Number(cycle.total_price)).toBe(40); // 20 × 2 weekly sessions in THIS series (not the whole batch)
      expect(cycle.settings.generated_by).toBe('slot_generator');
      expect(cycle.settings.publish_visibility).toBe('public');
      expect(cycle.settings.allow_single_booking).toBe(true);
      expect(cycle.name.startsWith('Summer training – ')).toBe(true); // base name + "ma 15:00" series suffix
      names.push(cycle.name);
      // each series = its own 2 private (draft) slots
      expect(await count('availability_slots WHERE cyclus_id = $1', [cid])).toBe(2);
      expect(await count('availability_slots WHERE cyclus_id = $1 AND is_public = true', [cid])).toBe(0);
    }
    // the three cycli are the three distinct start times
    expect(names.some((n) => n.includes('15:00'))).toBe(true);
    expect(names.some((n) => n.includes('16:00'))).toBe(true);
    expect(names.some((n) => n.includes('17:00'))).toBe(true);

    // the 6 slots span exactly 3 distinct cyclus_ids (one per series)
    expect(
      (await db.query<{ n: number }>(`SELECT count(DISTINCT cyclus_id)::int AS n FROM availability_slots`)).rows[0].n,
    ).toBe(3);
    const slot = (
      await db.query<{ allow_single_booking: boolean; max_participants: number; trainer_id: string }>(
        `SELECT allow_single_booking, max_participants, trainer_id FROM availability_slots LIMIT 1`,
      )
    ).rows[0];
    expect(slot.allow_single_booking).toBe(true);
    expect(slot.max_participants).toBe(4);
    expect(slot.trainer_id).toBe(TRAINER);
  });

  it('stores the public/private intent so publish can apply it (private cycle)', async () => {
    const res = await generateCycleWithSlots(input({ publishVisibility: 'private' }), supa);
    const settings = (
      await db.query<{ settings: Record<string, unknown> }>(`SELECT settings FROM cycles WHERE id = $1`, [
        res.cycleIds[0],
      ])
    ).rows[0].settings;
    expect(settings.publish_visibility).toBe('private');
    // still draft + private regardless of intent
    expect(await count('availability_slots WHERE is_public = true')).toBe(0);
  });

  it('dedups: a planned start the trainer already has is skipped (never double-created)', async () => {
    const firstStart = planSlots(plan)[0].startISO;
    await db.query(
      `INSERT INTO availability_slots (trainer_id, start_time, is_public) VALUES ($1, $2, false)`,
      [TRAINER, firstStart],
    );
    const res = await generateCycleWithSlots(input(), supa);
    expect(res.skippedOverlaps).toBe(1);
    expect(res.slotsCreated).toBe(5);
    // exactly one slot at the colliding start (the pre-existing one), not duplicated
    expect(await count('availability_slots WHERE trainer_id = $1 AND start_time = $2', [TRAINER, firstStart])).toBe(1);
  });

  it('throws and creates NO cycle when every planned start already exists', async () => {
    for (const d of planSlots(plan)) {
      await db.query(`INSERT INTO availability_slots (trainer_id, start_time, is_public) VALUES ($1, $2, false)`, [
        TRAINER,
        d.startISO,
      ]);
    }
    await expect(generateCycleWithSlots(input(), supa)).rejects.toThrow(SlotGeneratorError);
    expect(await count('cycles')).toBe(0);
  });

  it('abort cleanup: a failing slot insert deletes ALL the just-created draft cycli', async () => {
    // max_participants 99 violates the table CHECK (<= 8) → the single slot insert fails after all 3
    // per-series cycle rows exist → cleanup must delete every one of them.
    await expect(generateCycleWithSlots(input({ maxParticipants: 99 }), supa)).rejects.toThrow(SlotGeneratorError);
    expect(await count('cycles')).toBe(0); // all per-series cycli rolled back by the abort cleanup
    expect(await count('availability_slots')).toBe(0);
  });
});
