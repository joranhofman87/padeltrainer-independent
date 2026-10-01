// @vitest-environment node
//
// ABC-18 Pass B §1 — invoice authority, identity and CONCURRENCY.
//
// Real multi-connection PostgreSQL, not PGlite: the dedup contract is enforced by advisory locks
// across sessions, and a single-connection engine cannot demonstrate that two concurrent creates
// serialize. Every assertion here runs statements on two genuinely different backends.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPreH0, applyH0, FIXTURE_SQL, IDS } from './abc16Fixture';

const { Client } = pg;
const PORT = 54393;

let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let a: pg.Client;   // session A
let b: pg.Client;   // session B
/**
 * A THIRD client used only to observe pg_locks. node-postgres serializes queries per client, so
 * any observer query issued on a BLOCKED client queues behind the blocked statement and can never
 * answer — which is precisely why an earlier version of this harness stalled for the whole lock
 * budget. The observer is never used for invoice work, so it is always free to answer.
 */
let obs: pg.Client;
/** Backend PIDs captured ONCE, before any statement can block. */
let pidA = 0;
let pidB = 0;

const TRAINER = '7b000000-0000-4000-8000-000000000001';
const STALE_PROFILE = IDS.bookedProfile;
const GUEST_A = '2b000000-0000-4000-8000-0000000000f1';
const GUEST_B = '2b000000-0000-4000-8000-0000000000f2';
const PURE_PROFILE = IDS.nascentProfile;
const SHARED_PERSON = '3b000000-0000-4000-8000-0000000000f9';

const BK1 = '8b000000-0000-4000-8000-0000000000f1';
const BK2 = '8b000000-0000-4000-8000-0000000000f2';

const payload = (o: Record<string, unknown>) => JSON.stringify({
  trainer_id: TRAINER, invoice_number: 'INV-' + Math.random().toString(36).slice(2, 8),
  invoice_date: '2026-08-01', due_date: '2026-08-15',
  subtotal: 100, vat_rate: 21, vat_amount: 21, total: 121, status: 'sent', ...o,
});

const create = (c: pg.Client, o: Record<string, unknown>) =>
  c.query(`SELECT public.create_invoice_deduped($1::jsonb) AS v`, [payload(o)])
    .then((r) => r.rows[0].v as { id: string; deduped: boolean; total: string })
    .catch((e) => ({ error: String(e.message) } as unknown as { id: string; deduped: boolean; total: string }));

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abc18-inv-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

  const boot = new Client({ connectionString: url });
  await boot.connect();
  const exec = async (sql: string) => { await boot.query(sql); };
  await applyPreH0(exec);
  await boot.query(FIXTURE_SQL);
  await applyH0(exec);

  // TWO guests sharing one stale profile AND one shared person — the collapse shape.
  await boot.query(`
    INSERT INTO public.guest_players (id, full_name, academy_profile_id, linked_profile_id) VALUES
      ('${GUEST_A}', 'Inv Guest A', '${IDS.attackerAcademy}', '${STALE_PROFILE}'),
      ('${GUEST_B}', 'Inv Guest B', '${IDS.attackerAcademy}', '${STALE_PROFILE}');
    INSERT INTO public.persons (id) VALUES ('${SHARED_PERSON}') ON CONFLICT DO NOTHING;
    UPDATE public.person_links SET person_id = '${SHARED_PERSON}'
      WHERE guest_player_id IN ('${GUEST_A}', '${GUEST_B}') OR profile_id = '${STALE_PROFILE}';
  `);
  await boot.end();

  a = new Client({ connectionString: url }); await a.connect();
  b = new Client({ connectionString: url }); await b.connect();
  obs = new Client({ connectionString: url }); await obs.connect();
  // Captured up front and reused: querying a client for its own PID after it is blocked would
  // itself block.
  pidA = (await a.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  pidB = (await b.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  expect(pidA).not.toBe(pidB);   // otherwise every concurrency assertion below is vacuous
}, 300_000);

beforeEach(async () => { await a.query(`DELETE FROM public.invoices WHERE trainer_id = '${TRAINER}'`); });

afterAll(async () => {
  try { await a?.end(); } catch { /* ignore */ }
  try { await b?.end(); } catch { /* ignore */ }
  try { await obs?.end(); } catch { /* ignore */ }
  try { await epg?.stop(); } catch { /* ignore */ }
});

describe('Pass B §1 · create_invoice_deduped — typed identity', () => {
  it('the same guest deduplicates regardless of a stale accompanying profile', async () => {
    const first = await create(a, { guest_player_id: GUEST_A, booking_ids: [BK1] });
    const again = await create(a, { guest_player_id: GUEST_A, player_id: STALE_PROFILE, booking_ids: [BK1] });
    expect(again.deduped).toBe(true);
    expect(again.id).toBe(first.id);
  });

  it('the same pure profile deduplicates', async () => {
    const first = await create(a, { player_id: PURE_PROFILE, booking_ids: [BK1] });
    const again = await create(a, { player_id: PURE_PROFILE, booking_ids: [BK1] });
    expect(again.deduped).toBe(true);
    expect(again.id).toBe(first.id);
  });

  it('two guests sharing a stale profile AND a shared person never collapse', async () => {
    // The person arm used to merge exactly this pair — one human's invoice returned for another.
    const ia = await create(a, { guest_player_id: GUEST_A, player_id: STALE_PROFILE, booking_ids: [BK1] });
    const ib = await create(a, { guest_player_id: GUEST_B, player_id: STALE_PROFILE, booking_ids: [BK2] });
    expect(ib.deduped).toBe(false);
    expect(ib.id).not.toBe(ia.id);
  });

  it('a pure profile and a dual-key guest never collapse', async () => {
    const g = await create(a, { guest_player_id: GUEST_A, player_id: STALE_PROFILE, booking_ids: [BK1] });
    const p = await create(a, { player_id: STALE_PROFILE, booking_ids: [BK2] });
    expect(p.deduped).toBe(false);
    expect(p.id).not.toBe(g.id);
  });

  it('overlapping bookings under ANOTHER typed recipient refuse — never return or reuse that invoice', async () => {
    const owned = await create(a, { guest_player_id: GUEST_A, booking_ids: [BK1, BK2] });
    const intruder = await create(a, { guest_player_id: GUEST_B, booking_ids: [BK2] }) as unknown as { error?: string };
    expect(intruder.error).toMatch(/different recipient/i);

    // the other recipient's invoice was neither returned, mutated nor duplicated
    const rows = await a.query(`SELECT id, guest_player_id FROM public.invoices WHERE trainer_id = $1`, [TRAINER]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].id).toBe(owned.id);
    expect(rows.rows[0].guest_player_id).toBe(GUEST_A);
  });

  it('an unscoped payload is refused rather than invoiced', async () => {
    const r = await create(a, { booking_ids: [BK1] }) as unknown as { error?: string };
    expect(r.error).toMatch(/unscoped recipient/i);
  });

  it('amounts, snapshots and statuses survive unchanged', async () => {
    const made = await create(a, {
      guest_player_id: GUEST_A, booking_ids: [BK1],
      subtotal: 250, vat_rate: 9, vat_amount: 22.5, total: 272.5, status: 'sent',
      player_name: 'Snapshot Name', player_business_name: 'Snapshot BV',
    });
    const row = await a.query(
      `SELECT subtotal, vat_rate, vat_amount, total, status, player_name, player_business_name
         FROM public.invoices WHERE id = $1`, [made.id]);
    expect(row.rows[0]).toMatchObject({
      status: 'sent', player_name: 'Snapshot Name', player_business_name: 'Snapshot BV',
    });
    expect(Number(row.rows[0].total)).toBe(272.5);
    expect(Number(row.rows[0].vat_rate)).toBe(9);
  });
});

describe('Pass B §1 · two-session concurrency', () => {
  type Outcome = { who: 'A' | 'B'; id?: string; deduped?: boolean; error?: string };

  /**
   * Race two creates across two REAL backends without the harness itself deadlocking.
   *
   * The naive shape — start both, then always await+COMMIT A before awaiting B — hangs whenever
   * B wins the shared advisory lock: A blocks on B, and the harness blocks on A before it would
   * ever commit B. Nothing ever settles.
   *
   * So: tag each promise, COMMIT whichever settles FIRST (releasing its locks), then await and
   * commit the one that was blocked. `lock_timeout`/`statement_timeout` bound the wait, so a
   * genuine ordering bug surfaces as a fast error instead of a 20-minute hang.
   *
   * `firstMover` makes arrival order explicit and PROVEN: the first session's statement is
   * launched and we poll pg_locks until it actually holds an advisory lock before the second is
   * launched. Swapping the two payloads does NOT reverse arrival order on its own — whichever is
   * launched first still gets there first — which is why this is orchestrated rather than assumed.
   */
  async function racePair(
    optsA: Record<string, unknown>,
    optsB: Record<string, unknown>,
    firstMover: 'A' | 'B' = 'A',
  ): Promise<Outcome[]> {
    const run = (c: pg.Client, who: 'A' | 'B', opts: Record<string, unknown>): Promise<Outcome> =>
      c.query(`SELECT public.create_invoice_deduped($1::jsonb) AS v`, [payload(opts)])
        .then((r) => ({ who, ...(r.rows[0].v as object) }) as Outcome)
        .catch((e) => ({ who, error: String(e.message) }));

    const lead = firstMover === 'A' ? { c: a, who: 'A' as const, opts: optsA }
                                    : { c: b, who: 'B' as const, opts: optsB };
    const follow = firstMover === 'A' ? { c: b, who: 'B' as const, opts: optsB }
                                      : { c: a, who: 'A' as const, opts: optsA };

    for (const c of [a, b]) {
      await c.query('BEGIN');
      // The lock budget must EXCEED the verdict window below, or a correctly-blocked follower
      // is killed by lock_timeout before the lead commits — which looks like a failure of the
      // implementation when it is really a failure of the harness. Both are still bounded, so a
      // genuine deadlock surfaces as an error rather than a hang.
      await c.query(`SET LOCAL lock_timeout = '10s'`);
      await c.query(`SET LOCAL statement_timeout = '15s'`);
    }

    try {
      const pLead = run(lead.c, lead.who, lead.opts);

      // PROVE the lead actually arrived first: wait until it holds an advisory lock.
      const leadPid = lead.who === 'A' ? pidA : pidB;
      const deadline = Date.now() + 8000;
      let holds = false;
      while (Date.now() < deadline && !holds) {
        const r = await obs.query(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND pid = $1 AND granted`, [leadPid]);
        holds = r.rows[0].n > 0;
        if (!holds) await new Promise((res) => setTimeout(res, 25));
      }
      expect(holds).toBe(true);   // otherwise arrival order is unproven and the race is meaningless

      // Launch the follower, then WAIT FOR A REAL VERDICT before committing the lead.
      //
      // Racing here would be worthless: the lead has usually already resolved, so committing it
      // immediately releases the locks before the follower ever contends — the "race" then passes
      // under a broken implementation too. Instead, block until one of two things is TRUE:
      //
      //   (a) the follower SETTLED while the lead still holds its locks — which only an
      //       overlap-unsafe implementation permits (it read past the uncommitted row); or
      //   (b) pg_locks shows the follower WAITING (granted = false) on an advisory lock — which
      //       is the corrected implementation serializing it.
      //
      // Either way the window was genuinely concurrent, so the assertions mean something.
      let followSettled = false;
      const pFollow = run(follow.c, follow.who, follow.opts)
        .then((v) => { followSettled = true; return v; });

      const followPid = follow.who === 'A' ? pidA : pidB;
      const verdictBy = Date.now() + 5_000;
      let followBlocked = false;
      while (Date.now() < verdictBy && !followSettled && !followBlocked) {
        const w = await obs.query(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND pid = $1 AND NOT granted`, [followPid]);
        followBlocked = w.rows[0].n > 0;
        if (!followBlocked && !followSettled) await new Promise((res) => setTimeout(res, 25));
      }
      // A genuine concurrent window requires one of the two verdicts; neither means the harness
      // proved nothing and the test must not silently pass.
      expect(followSettled || followBlocked).toBe(true);

      await lead.c.query('COMMIT');
      const followOutcome = await pFollow;
      await follow.c.query('COMMIT');
      const leadOutcome = await pLead;

      const first = { v: lead.who === leadOutcome.who ? leadOutcome : followOutcome };
      const second = first.v.who === leadOutcome.who ? followOutcome : leadOutcome;
      return [first.v, second];
    } finally {
      for (const c of [a, b]) {
        try { await c.query('ROLLBACK'); } catch { /* already committed */ }
      }
    }
  }

  const outcomeOf = (rs: Outcome[], who: 'A' | 'B') => rs.find((r) => r.who === who)!;

  it('concurrent creates for the SAME guest serialize into one invoice', async () => {
    const rs = await racePair(
      { guest_player_id: GUEST_A, booking_ids: [BK1] },
      { guest_player_id: GUEST_A, player_id: STALE_PROFILE, booking_ids: [BK1] },
    );
    const n = await a.query(
      `SELECT count(*)::int AS n FROM public.invoices WHERE trainer_id = $1 AND guest_player_id = $2`,
      [TRAINER, GUEST_A]);
    expect(n.rows[0].n).toBe(1);
    expect(rs.filter((r) => r.deduped === true)).toHaveLength(1);
  });

  it('concurrent creates for the SAME pure profile serialize into one invoice', async () => {
    await racePair(
      { player_id: PURE_PROFILE, booking_ids: [BK1] },
      { player_id: PURE_PROFILE, booking_ids: [BK1] },
    );
    const n = await a.query(
      `SELECT count(*)::int AS n FROM public.invoices
        WHERE trainer_id = $1 AND player_id = $2 AND guest_player_id IS NULL`,
      [TRAINER, PURE_PROFILE]);
    expect(n.rows[0].n).toBe(1);
  });

  // PARTIAL overlap is the case a whole-set lock misses: [A] and [A,B] hash to different keys,
  // and different typed recipients take different recipient locks, so BOTH sessions could pass
  // their overlap SELECT before either INSERT committed — booking A billed twice, to two people.
  // Both ARRIVAL orders are exercised, orchestrated rather than inferred from parameter order.
  it.each([
    ['A first: [A] vs [A,B]', 'A' as const],
    ['B first: [A,B] vs [A]', 'B' as const],
  ])('PARTIAL overlap race — %s — exactly one succeeds', async (_label, firstMover) => {
    const rs = await racePair(
      { guest_player_id: GUEST_A, booking_ids: [BK1] },
      { guest_player_id: GUEST_B, booking_ids: [BK1, BK2] },
      firstMover,
    );

    const winners = rs.filter((r) => r.id && !r.error);
    const losers = rs.filter((r) => r.error);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].error).toMatch(/different recipient/i);

    // the shared booking is billed exactly once, by the winner
    const rows = await a.query(
      `SELECT id FROM public.invoices
        WHERE trainer_id = $1 AND status <> 'cancelled' AND booking_ids && $2::uuid[]`,
      [TRAINER, [BK1]]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].id).toBe(winners[0].id);

    // …and the loser neither created, reused nor mutated anything
    const total = await a.query(
      `SELECT count(*)::int AS n FROM public.invoices WHERE trainer_id = $1 AND status <> 'cancelled'`,
      [TRAINER]);
    expect(total.rows[0].n).toBe(1);
  });

  it('a NON-overlapping pair still both succeed — the lock does not over-serialize', async () => {
    const rs = await racePair(
      { guest_player_id: GUEST_A, booking_ids: [BK1] },
      { guest_player_id: GUEST_B, booking_ids: [BK2] },
    );
    expect(outcomeOf(rs, 'A').error).toBeUndefined();
    expect(outcomeOf(rs, 'B').error).toBeUndefined();
    expect(outcomeOf(rs, 'A').id).not.toBe(outcomeOf(rs, 'B').id);
  });

  it('no two active invoices ever share a booking', async () => {
    await create(a, { guest_player_id: GUEST_A, booking_ids: [BK1, BK2] });
    const dupes = await a.query(`
      SELECT count(*)::int AS n FROM (
        SELECT unnest(booking_ids) AS bk FROM public.invoices
         WHERE trainer_id = $1 AND status <> 'cancelled'
      ) t GROUP BY bk HAVING count(*) > 1`, [TRAINER]);
    expect(dupes.rows).toEqual([]);
  });
});

describe('Pass B §1 · get_my_invoices is pure-profile only', () => {
  const asUser = (uid: string) => a.query(`SELECT set_config('abc16.uid', $1, false)`, [uid]);
  const mine = async (uid: string) => {
    await asUser(uid);
    const r = await a.query(`SELECT id FROM public.get_my_invoices()`);
    return r.rows.map((x) => x.id as string);
  };

  beforeEach(async () => {
    await a.query(`DELETE FROM public.invoices WHERE trainer_id = '${TRAINER}'`);
    await a.query(`
      INSERT INTO auth.users (id, email) VALUES ('${IDS.nascentUser}', 'n@example.test')
        ON CONFLICT (id) DO NOTHING;
    `);
  });

  it('returns the caller\'s own pure-profile invoice', async () => {
    const own = await create(a, { player_id: PURE_PROFILE, booking_ids: [BK1] });
    expect(await mine(IDS.nascentUser)).toContain(own.id);
  });

  it('never returns a DUAL-KEY invoice carrying the caller\'s stale player_id', async () => {
    // account first: persons.user_id FKs auth.users and the profile mirror copies it, so the
    // UPDATE below fails if the account does not exist yet.
    await a.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'stale@example.test') ON CONFLICT DO NOTHING`,
      ['6b000000-0000-4000-8000-0000000000f1']);
    await a.query(`UPDATE public.profiles SET user_id = $1 WHERE id = $2`,
      ['6b000000-0000-4000-8000-0000000000f1', STALE_PROFILE]);
    const dual = await create(a, { guest_player_id: GUEST_A, player_id: STALE_PROFILE, booking_ids: [BK1] });
    expect(await mine('6b000000-0000-4000-8000-0000000000f1')).not.toContain(dual.id);
  });

  it('never returns an invoice reachable only through a shared person', async () => {
    const guestInv = await create(a, { guest_player_id: GUEST_B, booking_ids: [BK2] });
    // GUEST_B shares SHARED_PERSON with STALE_PROFILE; person equality must grant nothing
    expect(await mine('6b000000-0000-4000-8000-0000000000f1')).not.toContain(guestInv.id);
  });

  it('draft invoices stay hidden', async () => {
    const draft = await create(a, { player_id: PURE_PROFILE, booking_ids: [BK2], status: 'draft' });
    expect(await mine(IDS.nascentUser)).not.toContain(draft.id);
  });
});
