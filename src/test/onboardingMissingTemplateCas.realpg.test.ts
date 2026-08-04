// @vitest-environment node
// 10c-b review #1 — the missing-template path in process-onboarding-emails.
//
// THE DEFECT. That branch runs BEFORE claim_onboarding_email_queue_item, and it used to
// update the row keyed on id alone:
//     .update({ status: 'failed', error_message: 'Template not found' }).eq('id', id)
// Two overlapping invocations therefore both saw the same pending row, both wrote 'failed',
// and both incremented failCount — which drives notifySlackEdgeError, so one broken row
// produced two operator alerts. Removing the cron single-flight lock made the overlap
// reachable rather than merely theoretical, so the ownership had to move into the write.
//
// THE FIX is a CAS: guard the transition on status='pending' and read back the affected row.
// Exactly one invocation transitions the row and therefore owns the failure + the alert;
// the loser updates zero rows and stays silent.
//
// This suite exercises the REAL statement the edge function now issues, on a real
// multi-connection server, because the guarantee is a database guarantee — not something
// a mocked client could demonstrate.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Client } = pg;
const PORT = 54365;
let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let url = '';
let a: pg.Client;
let b: pg.Client;

const QUEUE_ID = '11111111-1111-1111-1111-111111111111';

/** The exact CAS the edge function performs (supabase-js .update().eq().eq().select()). */
const casFail = (c: pg.Client) =>
  c.query(
    `UPDATE public.onboarding_email_queue
        SET status = 'failed', error_message = 'Template not found'
      WHERE id = $1 AND status = 'pending'
      RETURNING id`, [QUEUE_ID]).then((r) => r.rowCount ?? 0);

/** The pre-fix statement, kept as the mutation baseline: no status guard. */
const unguardedFail = (c: pg.Client) =>
  c.query(
    `UPDATE public.onboarding_email_queue
        SET status = 'failed', error_message = 'Template not found'
      WHERE id = $1
      RETURNING id`, [QUEUE_ID]).then((r) => r.rowCount ?? 0);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onboardcas-rp-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
  const boot = new Client({ connectionString: url });
  await boot.connect();
  await boot.query(`
    CREATE TABLE public.onboarding_email_queue (
      id uuid PRIMARY KEY,
      status text NOT NULL DEFAULT 'pending',
      error_message text,
      sent_at timestamptz
    );`);
  await boot.end();
  a = new Client({ connectionString: url }); await a.connect();
  b = new Client({ connectionString: url }); await b.connect();
  expect((await a.query('SELECT pg_backend_pid() AS p')).rows[0].p)
    .not.toBe((await b.query('SELECT pg_backend_pid() AS p')).rows[0].p);
}, 180_000);

beforeEach(async () => {
  await a.query(`DELETE FROM public.onboarding_email_queue`);
  await a.query(`INSERT INTO public.onboarding_email_queue (id, status) VALUES ($1,'pending')`, [QUEUE_ID]);
});

afterAll(async () => {
  try { await a?.end(); } catch { /* ignore */ }
  try { await b?.end(); } catch { /* ignore */ }
  try { await epg?.stop(); } catch { /* ignore */ }
});

describe('10c-b review #1 — missing-template failure is ownership-guarded', () => {
  it('two concurrent invocations: exactly ONE owns the failure (and therefore the alert)', async () => {
    const [x, y] = await Promise.all([casFail(a), casFail(b)]);
    expect(x + y).toBe(1);
    const { rows } = await a.query(`SELECT status, error_message FROM public.onboarding_email_queue WHERE id=$1`, [QUEUE_ID]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error_message).toBe('Template not found');
  });

  it('eight concurrent invocations still yield exactly one owner', async () => {
    const conns = await Promise.all(Array.from({ length: 8 }, async () => {
      const c = new Client({ connectionString: url }); await c.connect(); return c;
    }));
    try {
      const results = await Promise.all(conns.map((c) => casFail(c)));
      expect(results.reduce((s, n) => s + n, 0)).toBe(1);
    } finally {
      await Promise.all(conns.map((c) => c.end().catch(() => undefined)));
    }
  });

  it('a later invocation finds the row already handled and stays silent', async () => {
    expect(await casFail(a)).toBe(1);   // first run owns it
    expect(await casFail(b)).toBe(0);   // a later tick: no rows, no failCount, no alert
    expect(await casFail(a)).toBe(0);   // and it stays that way
  });

  it('does not steal a row another run legitimately claimed (status moved on)', async () => {
    // claim_onboarding_email_queue_item transitions pending -> sent
    await b.query(`UPDATE public.onboarding_email_queue SET status='sent', sent_at=now() WHERE id=$1`, [QUEUE_ID]);
    expect(await casFail(a)).toBe(0);
    const { rows } = await a.query(`SELECT status FROM public.onboarding_email_queue WHERE id=$1`, [QUEUE_ID]);
    expect(rows[0].status).toBe('sent');   // a sent row is never rewritten to failed
  });

  // ---- MUTATION PIN -------------------------------------------------------
  // The guard must be load-bearing, not decorative: the pre-fix statement (no
  // status predicate) must reproduce the exact double-handling this suite forbids.
  it('MUTANT: dropping the status guard lets BOTH invocations own the failure', async () => {
    const [x, y] = await Promise.all([unguardedFail(a), unguardedFail(b)]);
    expect(x + y).toBe(2);              // both would have counted, and both alerted
    expect(x + y).not.toBe(1);          // i.e. the guarded version's assertion fails
  });
});
