// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Behaviour test for publishCycle (slot-generator publish lifecycle) against real Postgres:
// opening a draft cycle + applying the stored public/private intent to its slots.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { publishCycle, openDraftCycles } from '@/lib/cycleWrites';

let db: PGlite;
let supa: SupabaseClient<Database>;

const cycleRow = async (id: string) =>
  (await db.query<{ status: string }>(`SELECT status FROM cycles WHERE id = $1`, [id])).rows[0];
const slotPublic = async (id: string) =>
  (await db.query<{ is_public: boolean }>(`SELECT is_public FROM availability_slots WHERE id = $1`, [id])).rows[0]
    .is_public;

beforeAll(async () => {
  db = new PGlite();
  supa = createPgliteSupabase(db) as unknown as SupabaseClient<Database>;
  await db.exec(`
    CREATE TABLE cycles (id text PRIMARY KEY, status text, updated_at timestamptz);
    CREATE TABLE availability_slots (id text PRIMARY KEY, cyclus_id text, is_public boolean);
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM availability_slots; DELETE FROM cycles;`);
});

describe('publishCycle (against real Postgres)', () => {
  it('public publish: opens the cycle AND makes its slots bookable', async () => {
    await db.exec(`INSERT INTO cycles (id, status) VALUES ('C1','draft');`);
    await db.exec(`INSERT INTO availability_slots (id, cyclus_id, is_public) VALUES
      ('S1','C1',false), ('S2','C1',false);`);

    await publishCycle('C1', true, supa);

    expect((await cycleRow('C1')).status).toBe('open');
    expect(await slotPublic('S1')).toBe(true);
    expect(await slotPublic('S2')).toBe(true);
  });

  it('private publish: opens the cycle but slots stay private (staff-bookable only)', async () => {
    await db.exec(`INSERT INTO cycles (id, status) VALUES ('C2','draft');`);
    await db.exec(`INSERT INTO availability_slots (id, cyclus_id, is_public) VALUES ('S3','C2',false);`);

    await publishCycle('C2', false, supa);

    expect((await cycleRow('C2')).status).toBe('open');
    expect(await slotPublic('S3')).toBe(false);
  });

  it('only touches THIS cycle\'s slots, not another cycle\'s', async () => {
    await db.exec(`INSERT INTO cycles (id, status) VALUES ('C1','draft'),('C2','draft');`);
    await db.exec(`INSERT INTO availability_slots (id, cyclus_id, is_public) VALUES
      ('S1','C1',false), ('OTHER','C2',false);`);

    await publishCycle('C1', true, supa);

    expect(await slotPublic('S1')).toBe(true);
    expect(await slotPublic('OTHER')).toBe(false); // C2 untouched
    expect((await cycleRow('C2')).status).toBe('draft'); // C2 still draft
  });

  it('a draft cycle with no slots just opens (no error)', async () => {
    await db.exec(`INSERT INTO cycles (id, status) VALUES ('C3','draft');`);
    await expect(publishCycle('C3', true, supa)).resolves.toBeUndefined();
    expect((await cycleRow('C3')).status).toBe('open');
  });
});

describe('openDraftCycles (status-only heal)', () => {
  it('opens draft cycles WITHOUT touching slot visibility (the unpublish trap)', async () => {
    await db.query(`INSERT INTO cycles (id, status) VALUES ('cd1', 'draft')`);
    await db.query(`INSERT INTO availability_slots (id, cyclus_id, is_public) VALUES ('sd1', 'cd1', true), ('sd2', 'cd1', false)`);
    await openDraftCycles(['cd1'], supa);
    expect((await cycleRow('cd1')).status).toBe('open');
    // slots untouched: the already-public booked one stays public, the private one stays private
    expect(await slotPublic('sd1')).toBe(true);
    expect(await slotPublic('sd2')).toBe(false);
  });

  it('only flips rows still in draft — open/closed cycles are left alone', async () => {
    await db.query(`INSERT INTO cycles (id, status) VALUES ('co1', 'open'), ('cc1', 'closed'), ('cd2', 'draft')`);
    await openDraftCycles(['co1', 'cc1', 'cd2'], supa);
    expect((await cycleRow('co1')).status).toBe('open');
    expect((await cycleRow('cc1')).status).toBe('closed');
    expect((await cycleRow('cd2')).status).toBe('open');
  });

  it('empty input is a no-op', async () => {
    await openDraftCycles([], supa);
  });
});
