// @vitest-environment node
// Behaviour test for setCyclePublicVisibility (the "Show on public page" toggle) against real
// Postgres: it sets settings.publish_visibility (the flag the public lists filter on) AND flips
// the cycle's slots' is_public to match, merging into existing settings.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { setCyclePublicVisibility } from '@/lib/cycleWrites';

let db: PGlite;
let supa: SupabaseClient<Database>;

const settings = async (id: string) =>
  (await db.query<{ settings: Record<string, unknown> }>(`SELECT settings FROM cycles WHERE id = $1`, [id])).rows[0].settings;
const slotPublic = async (id: string) =>
  (await db.query<{ is_public: boolean }>(`SELECT is_public FROM availability_slots WHERE id = $1`, [id])).rows[0].is_public;

beforeAll(async () => {
  db = new PGlite();
  supa = createPgliteSupabase(db) as unknown as SupabaseClient<Database>;
  await db.exec(`
    CREATE TABLE cycles (id text PRIMARY KEY, settings jsonb, updated_at timestamptz);
    CREATE TABLE availability_slots (id text PRIMARY KEY, cyclus_id text, is_public boolean);
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM availability_slots; DELETE FROM cycles;`);
});

describe('setCyclePublicVisibility (against real Postgres)', () => {
  it('publish: marks the cycle public + its slots bookable, preserving other settings', async () => {
    await db.exec(`INSERT INTO cycles (id, settings) VALUES ('C1', '{"payment_timing":"upfront"}'::jsonb);`);
    await db.exec(`INSERT INTO availability_slots (id, cyclus_id, is_public) VALUES ('S1','C1',false), ('S2','C1',false);`);

    await setCyclePublicVisibility('C1', true, { payment_timing: 'upfront' }, ['S1', 'S2'], supa);

    const s = await settings('C1');
    expect(s.publish_visibility).toBe('public');
    expect(s.payment_timing).toBe('upfront'); // existing setting preserved
    expect(await slotPublic('S1')).toBe(true);
    expect(await slotPublic('S2')).toBe(true);
  });

  it('unpublish: marks the cycle private + hides its slots', async () => {
    await db.exec(`INSERT INTO cycles (id, settings) VALUES ('C2', '{"publish_visibility":"public"}'::jsonb);`);
    await db.exec(`INSERT INTO availability_slots (id, cyclus_id, is_public) VALUES ('S3','C2',true);`);

    await setCyclePublicVisibility('C2', false, { publish_visibility: 'public' }, ['S3'], supa);

    expect((await settings('C2')).publish_visibility).toBe('private');
    expect(await slotPublic('S3')).toBe(false);
  });

  it('a cycle with no slots (registration cycle) just updates settings', async () => {
    await db.exec(`INSERT INTO cycles (id, settings) VALUES ('C3', '{}'::jsonb);`);
    await expect(setCyclePublicVisibility('C3', true, {}, [], supa)).resolves.toBeUndefined();
    expect((await settings('C3')).publish_visibility).toBe('public');
  });
});
