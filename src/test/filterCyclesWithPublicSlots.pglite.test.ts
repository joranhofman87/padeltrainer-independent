// @vitest-environment node
// Privacy regression: the public "Open for Registration" list (getActiveCycles /
// getLocationCycles) keeps ONLY cycles that have a public, future slot — so private
// cycles + empty shells (0 slots, like RL Padel Performance) never leak publicly.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteSupabase } from '@/test/fixtures/pgliteSupabase';
import { filterCyclesWithPublicSlots } from '@/lib/cycles';
import type { Cycle } from '@/lib/cycleTypes';

let db: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;

const future = "now() + interval '7 days'";
const past = "now() - interval '7 days'";
const cyc = (id: string): Cycle => ({ id }) as unknown as Cycle;

beforeAll(async () => {
  db = new PGlite();
  client = createPgliteSupabase(db);
  await db.exec(`CREATE TABLE availability_slots (id text PRIMARY KEY, cyclus_id text, is_public boolean, start_time timestamptz);`);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM availability_slots;`);
});

describe('filterCyclesWithPublicSlots', () => {
  it('keeps a cycle with a public future slot; drops one whose slots are all private', async () => {
    await db.exec(`INSERT INTO availability_slots (id, cyclus_id, is_public, start_time) VALUES
      ('a','PUB', true,  ${future}),
      ('b','PRIV', false, ${future});`);
    const out = await filterCyclesWithPublicSlots([cyc('PUB'), cyc('PRIV')], client);
    expect(out.map((c) => c.id)).toEqual(['PUB']);
  });

  it('drops an empty shell (0 slots) — the RL case', async () => {
    const out = await filterCyclesWithPublicSlots([cyc('SHELL')], client);
    expect(out).toEqual([]);
  });

  it('drops a cycle whose only public slots are in the PAST', async () => {
    await db.exec(`INSERT INTO availability_slots (id, cyclus_id, is_public, start_time) VALUES ('c','OLD', true, ${past});`);
    const out = await filterCyclesWithPublicSlots([cyc('OLD')], client);
    expect(out).toEqual([]);
  });

  it('returns [] for no cycles without querying', async () => {
    expect(await filterCyclesWithPublicSlots([], client)).toEqual([]);
  });
});
