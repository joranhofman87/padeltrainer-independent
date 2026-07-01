// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Slice B regression: record_priority_claim_intent stamps WHICH button a player clicked on a rebook
// invite, on a still-pending claim only, without changing status. Runs the ACTUAL migration
// (20260705120000_priority_claim_response_intent.sql) against real Postgres (PGlite).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

function readMigration(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  return readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260705120000_priority_claim_response_intent.sql'),
    'utf8',
  );
}

async function intent(token: string): Promise<{ response_intent: string | null; stamped: boolean }> {
  const r = (
    await db.query<{ response_intent: string | null; response_intent_at: string | null }>(
      `SELECT response_intent, response_intent_at FROM public.slot_priority_claims WHERE claim_token = $1`,
      [token],
    )
  ).rows[0];
  return { response_intent: r.response_intent, stamped: r.response_intent_at !== null };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    -- Minimal slot_priority_claims; the migration ALTERs it to add the intent columns.
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_token text, status text);
  `);
  await db.exec(readMigration()); // adds response_intent/at + the RPC
});

beforeEach(async () => {
  await db.exec(`DELETE FROM public.slot_priority_claims;`);
  await db.exec(`
    INSERT INTO public.slot_priority_claims (claim_token, status) VALUES
      ('t-pending', 'pending'),
      ('t-claimed', 'claimed');
  `);
});

describe('record_priority_claim_intent (Slice B)', () => {
  it('stamps the accept intent on a PENDING claim', async () => {
    await db.query(`SELECT public.record_priority_claim_intent('t-pending', 'accept')`);
    expect(await intent('t-pending')).toEqual({ response_intent: 'accept', stamped: true });
  });

  it('is a NO-OP on an already-settled (claimed) claim — never overwrites a decided one', async () => {
    await db.query(`SELECT public.record_priority_claim_intent('t-claimed', 'accept')`);
    expect(await intent('t-claimed')).toEqual({ response_intent: null, stamped: false });
  });

  it('ignores an invalid intent value (no status/column change)', async () => {
    await db.query(`SELECT public.record_priority_claim_intent('t-pending', 'accept')`);
    await db.query(`SELECT public.record_priority_claim_intent('t-pending', 'bogus')`);
    // still the last valid intent, not clobbered by the bogus call
    expect((await intent('t-pending')).response_intent).toBe('accept');
  });

  it('a later valid intent overwrites the earlier one while still pending', async () => {
    await db.query(`SELECT public.record_priority_claim_intent('t-pending', 'accept')`);
    await db.query(`SELECT public.record_priority_claim_intent('t-pending', 'decline')`);
    expect((await intent('t-pending')).response_intent).toBe('decline');
  });

  it('never changes the claim status', async () => {
    await db.query(`SELECT public.record_priority_claim_intent('t-pending', 'accept')`);
    const status = (
      await db.query<{ status: string }>(`SELECT status FROM public.slot_priority_claims WHERE claim_token = 't-pending'`)
    ).rows[0].status;
    expect(status).toBe('pending');
  });
});
