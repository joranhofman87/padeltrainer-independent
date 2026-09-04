// @vitest-environment node
//
// D7 RUNTIME — BEHAVIOURAL EVIDENCE on the real chain (E-1, E-3, E-12, P-1, P-5).
//
// The worker core under test here is the SAME MODULE the edge function ships. It is wired to a
// `pg` client and a scripted provider instead of supabase-js and Resend, which is the whole point
// of it being a dependency-injected core: the loop that will reach a real provider in production
// is literally the loop this file exercises against a real database.
//
// EVERY DATABASE IS A FRESH CLONE OF THE REPLAYED CHAIN. Channel kills are immutable by design and
// leases are cluster-visible, so per-test transactions would either be unable to set up an arm or
// would leak state into the next one. A clone is a `CREATE DATABASE … TEMPLATE`, which is cheap
// enough that perfect isolation is the right default.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  runRebookMemberOpenWorker, REBOOK_MEMBER_OPEN_WORKER_LIMITS,
} from '../../supabase/functions/_shared/rebook-member-open-worker-core.ts';
import {
  runRebookMemberOpenJanitor, REBOOK_MEMBER_OPEN_JANITOR_LIMITS,
} from '../../supabase/functions/_shared/rebook-member-open-janitor-core.ts';
import { OBSERVED_SEND_TIMEOUT_MS } from '../../supabase/functions/_shared/rebook-member-open-observed-send.ts';
import type { ObservedSendResult } from '../../supabase/functions/_shared/rebook-member-open-observed-send.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asActor, bootD7Chain, type D7Chain } from './d7RealChain';

const PORT = 54504;
const PREFIX = 'd7rt';
const ACADEMY = '11111111-1111-4111-8111-111111111111';
const TRAINER = '55555555-5555-4555-8555-555555555555';
const FIXTURE_ACTOR = '88888888-8888-4888-8888-888888888888';

let chain: D7Chain;
let dbSeq = 0;

/** One never-reused hour lane per slot: `check_trainer_slot_overlap` is live on this chain. */
let laneSeq = 0;
const nextLane = () => (laneSeq += 1);

beforeAll(async () => {
  // No `holdBack`: every database here is the COMPLETE chain, index and retirements included.
  chain = await bootD7Chain({ port: PORT, prefix: PREFIX, vaultServiceRoleKey: 'd7-runtime-test-key' });
}, 300_000);

afterAll(async () => { await chain?.shutdown(); });

/**
 * A fresh clone of the replayed chain, with the tenant pinned INSIDE the quiet-hours window.
 *
 * THIS IS NOT A CONVENIENCE. `pre_dispatch_resolve` defers any row whose tenant's LOCAL time is
 * outside 09:00-20:00, and `notif_digest_recipient_timezone` falls back to `Europe/Amsterdam` when
 * the academy carries none. Without this every dispatch test silently became a quiet-hours test
 * after 20:00 local — passing all afternoon and failing in the evening, which is the exact shape of
 * a gate that cannot tell a regression from the time of day.
 *
 * The zone is chosen from the DATABASE's own clock rather than the process's, and the quiet-hours
 * test below picks the complementary zone the same way, so the two are deterministic mirrors.
 */
async function freshDb(opts: { quietHours?: boolean } = {}): Promise<pg.Client> {
  const c = await chain.clone(`${PREFIX}_${(dbSeq += 1)}`);
  await c.query(`
    INSERT INTO public.academy_profiles(id,name) VALUES ('${ACADEMY}','d7 academy') ON CONFLICT DO NOTHING;
    INSERT INTO public.trainer_profiles(id) VALUES ('${TRAINER}') ON CONFLICT DO NOTHING;`);
  const { rows } = await c.query(`
    SELECT name FROM pg_timezone_names
     WHERE name LIKE 'Etc/GMT%'
       AND extract(hour FROM now() AT TIME ZONE name) ${opts.quietHours ? '< 9' : 'BETWEEN 10 AND 18'}
     ORDER BY name LIMIT 1`);
  expect(rows, 'a timezone in the required half of the day must exist for any instant').toHaveLength(1);
  await c.query(`UPDATE public.academy_profiles SET timezone=$1 WHERE id=$2`, [rows[0].name, ACADEMY]);
  return c;
}

interface SeededRound {
  round: string;
  cycle: string;
  recipients: { user: string; profile: string; recipient: string; slot: string; claim: string }[];
}

/**
 * A round in `materializing` with a completed `create` receipt, `n` account recipients each with a
 * verified email contact, an open sibling slot with free seats, an outstanding claim and the
 * snapshot's claim-source row.
 *
 * Every one of those is load-bearing. Without the receipt the due scan cannot see the round at
 * all; without the claim and the claim source the pre-dispatch resolver stops at `ineligible` and
 * every gate after it is never reached — the kind of silent short-circuit that makes a chain test
 * look green while proving nothing about the chain.
 *
 * `memberWindow` is a SQL EXPRESSION, not a value, because the round's window boundaries are
 * immutable once written: a test that needs a closing window has to seed one.
 */
async function seedRound(
  c: pg.Client,
  n: number,
  opts: { memberWindow?: string; cycleSettings?: Record<string, unknown> } = {},
): Promise<SeededRound> {
  const memberWindow = opts.memberWindow ?? `now()+interval '7 days'`;
  const round = (await c.query(
    `INSERT INTO public.rebook_rounds (academy_profile_id,label,priority_window_ends_at,member_window_ends_at)
     VALUES ($1,'d7 runtime',now()-interval '1 hour',${memberWindow}) RETURNING id`, [ACADEMY])).rows[0].id;
  const cycle = (await c.query(
    `INSERT INTO public.cycles(id,owner_id,owner_type,name,status,start_date,settings)
     VALUES (gen_random_uuid(),$1,'academy','D7 sibling','open',current_date,$2) RETURNING id`,
    [ACADEMY, JSON.stringify(opts.cycleSettings ?? {})])).rows[0].id;
  // The attach transition demands a consumed same-transaction apply capability at the DML boundary.
  // Tests that are ABOUT transport still need an attached sibling as INPUT STATE, so the sanctioned
  // plumbing is a scoped disable of exactly that one guard trigger — never a policy change, and
  // always re-enabled (the forward-chain suite re-proves `tgenabled` on the installed catalog).
  await c.query(`ALTER TABLE public.cycles DISABLE TRIGGER trg_guard_cycle_zz2_apply_capability`);
  try {
    await c.query(`UPDATE public.cycles SET rebook_round_id=$1 WHERE id=$2`, [round, cycle]);
  } finally {
    await c.query(`ALTER TABLE public.cycles ENABLE TRIGGER trg_guard_cycle_zz2_apply_capability`);
  }
  await c.query(`UPDATE public.rebook_rounds
    SET lifecycle='materializing',materialization_started_at=clock_timestamp(),extension_closed_at=clock_timestamp()
    WHERE id=$1`, [round]);
  await c.query(`INSERT INTO public.rebook_round_commands
    (command_id,academy_profile_id,actor_user_id,round_id,command_kind,request_fingerprint,
     canonical_payload,result_receipt,result_receipt_canonical,result_receipt_digest)
    VALUES (gen_random_uuid(),$1,$3,$2,'create',extensions.digest($4,'sha256'),'{}','{}',
            pg_catalog.convert_to('{}','UTF8'), pg_catalog.sha256(pg_catalog.convert_to('{}','UTF8')))`,
  // A DISTINCT FINGERPRINT PER ROUND, passed as its own text parameter.
  // `uq_rebook_round_commands_actor_review` keys on (actor, fingerprint), so a constant digest
  // collides the moment a second round is seeded into the same database — which the cross-cycle
  // and cross-round arms below have to do.
  [ACADEMY, round, FIXTURE_ACTOR, String(round)]);

  const recipients: SeededRound['recipients'] = [];
  for (let i = 0; i < n; i += 1) {
    const user = (await c.query(`INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
    const profile = (await c.query(`SELECT id FROM public.profiles WHERE user_id=$1`, [user])).rows[0].id;
    const recipient = (await c.query(`INSERT INTO public.rebook_round_recipients
      (rebook_round_id,academy_profile_id,recipient_player_profile_id,captured_at)
      VALUES ($1,$2,$3,clock_timestamp()) RETURNING id`, [round, ACADEMY, profile])).rows[0].id;
    await c.query(`INSERT INTO public.notification_contacts
      (user_id,channel,destination_normalized,destination_redacted,verified_at,consent_status,consent_scope,is_primary)
      VALUES ($1,'email',$2,'r***@example.test',clock_timestamp(),'unknown','global',true)`,
    [user, `${user}@example.test`]);
    const lane = nextLane();
    const slot = (await c.query(`INSERT INTO public.availability_slots
      (id,trainer_id,academy_profile_id,source_cycle_id,start_time,end_time,max_participants,member_window_ends_at)
      VALUES (gen_random_uuid(),$1,$2,$3,now()+interval '2 days'+make_interval(hours => ${lane}),
              now()+interval '2 days 1 hour'+make_interval(hours => ${lane}),4,now()+interval '30 days')
      RETURNING id`, [TRAINER, ACADEMY, cycle])).rows[0].id;
    const claim = (await c.query(`INSERT INTO public.slot_priority_claims(slot_id,player_id,status)
      VALUES ($1,$2,'pending') RETURNING id`, [slot, profile])).rows[0].id;
    await c.query(`INSERT INTO public.rebook_round_recipient_claim_sources
      (rebook_round_recipient_id,rebook_round_id,academy_profile_id,source_claim_id,
       source_slot_id,source_cycle_id,claimed_player_profile_id,claim_status,captured_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',clock_timestamp())`,
    [recipient, round, ACADEMY, claim, slot, cycle, profile]);
    recipients.push({ user, profile, recipient, slot, claim });
  }
  return { round, cycle, recipients };
}

/** Run `rebook_round_materialize` as `service_role`, exactly as the materializer function does. */
async function materialize(c: pg.Client, rounds = 1, recipients = 500): Promise<Record<string, unknown>[]> {
  await c.query('SET ROLE service_role');
  try {
    return (await c.query(`SELECT * FROM public.rebook_round_materialize($1,$2)`, [rounds, recipients])).rows;
  } finally {
    await c.query('RESET ROLE');
  }
}

// ── The RPC adapter, and the two carrier shapes ──────────────────────────────────────────────

/**
 * NAMED-NOTATION calls, which is exactly how PostgREST invokes an RPC. The worker core hands over
 * `{p_worker: …, p_limit: …}` and this turns it into `f(p_worker => $1, p_limit => $2)` — so the
 * parameter binding under test here is the same binding production performs.
 */
function rpcOn(client: pg.Client, opts: { postgrestShaped?: boolean } = {}) {
  return async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const keys = Object.keys(args);
    const call = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
    await client.query('SET ROLE service_role');
    try {
      const { rows } = await client.query(
        `SELECT * FROM public.${name}(${call})`, keys.map((k) => args[k]));
      return opts.postgrestShaped ? rows.map(asPostgrestRow) : rows;
    } finally {
      await client.query('RESET ROLE');
    }
  };
}

/**
 * Render one row the way PostgREST renders it on the wire.
 *
 * The only shape that differs from `pg`'s is `bytea`: PostgREST emits PostgreSQL's `hex` text
 * output — a JSON string `"\\x<hex>"` — where `pg` emits a Buffer. Everything else is already the
 * same JSON scalar. Feeding that string back as a bytea parameter is the exact inverse: PostgREST
 * casts the JSON string through bytea's text input function, which is what a named-notation `$n`
 * bound to a bytea parameter does here too.
 *
 * THIS IS A MODEL OF PostgREST, NOT PostgREST. It is stated plainly rather than implied: no
 * PostgREST process runs in this suite. What it proves is the property the worker actually depends
 * on — that a bytea capability survives a round trip through the hex text form byte-for-byte — and
 * that is the property whose failure would silently turn every dispatch into
 * `frozen_request_mismatch`.
 */
function asPostgrestRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = Buffer.isBuffer(v) ? `\\x${(v as Buffer).toString('hex')}` : v;
  }
  return out;
}

const ACCEPTED: ObservedSendResult = {
  observed: true, httpStatus: 202, providerErrorCode: null,
  providerMessageId: 'msg_accepted', transportFault: 'none', envelopeStructurallyValid: true,
};

interface WorkerRun {
  summary: Awaited<ReturnType<typeof runRebookMemberOpenWorker>>;
  sends: { idempotencyKey: string; requestBytes: string }[];
  logs: Record<string, unknown>[];
}

async function runWorker(
  c: pg.Client,
  opts: {
    token?: string;
    send?: ObservedSendResult | ((n: number) => ObservedSendResult);
    postgrestShaped?: boolean;
    claimLimit?: number;
    /**
     * Fires AFTER the named RPC has returned and BEFORE the worker's next step — the seam a real
     * race lives in. This is how a payment is committed between `pre_dispatch_resolve` and
     * `begin_dispatch` without stubbing either of them: both are the shipped functions, called in
     * the shipped order, and the only thing injected is a concurrent commit at a chosen instant.
     */
    onRpc?: (name: string) => Promise<void>;
  } = {},
): Promise<WorkerRun> {
  const sends: WorkerRun['sends'] = [];
  const logs: Record<string, unknown>[] = [];
  const base = rpcOn(c, { postgrestShaped: opts.postgrestShaped });
  const summary = await runRebookMemberOpenWorker({
    limits: { ...REBOOK_MEMBER_OPEN_WORKER_LIMITS, rpcTimeoutMs: 60_000,
      ...(opts.claimLimit !== undefined ? { claimLimit: opts.claimLimit } : {}) },
    rpc: async (name, args) => {
      const result = await base(name, args);
      if (opts.onRpc) await opts.onRpc(name);
      return result;
    },
    sendOnce: (frozen) => {
      sends.push(frozen);
      const s = opts.send ?? ACCEPTED;
      return Promise.resolve(typeof s === 'function' ? s(sends.length) : s);
    },
    monotonicNowMs: () => performance.now(),
    newToken: () => opts.token ?? 'd7-runtime-test-worker',
    log: (e) => logs.push(e),
  });
  return { summary, sends, logs };
}

/**
 * Run the janitor core against a real database.
 *
 * `staleAfterMinutes` defaults to the OD-5 value and is overridden to 0 only where an arm needs a
 * lease recovered deterministically. A ZERO FLOOR IS SANCTIONED BY THE MIGRATION ITSELF, in those
 * words, and it is fail-SAFE rather than fail-open: recovering a live lease only bumps the
 * generation, which makes that worker's next begin or outcome refuse on capability. The alternative
 * — a direct `UPDATE … SET locked_at` — is refused outright by the unconditional D7 outbox guard,
 * for the table owner as much as for anyone else, which is exactly the property S-5 promises.
 */
const runJanitor = (c: pg.Client, staleAfterMinutes = REBOOK_MEMBER_OPEN_JANITOR_LIMITS.staleAfterMinutes) =>
  runRebookMemberOpenJanitor({
    limits: { ...REBOOK_MEMBER_OPEN_JANITOR_LIMITS, staleAfterMinutes },
    rpc: rpcOn(c), log: () => {}, rpcTimeoutMs: 60_000,
  });

const outboxOf = async (c: pg.Client, round: string): Promise<Record<string, unknown>[]> =>
  (await c.query(`SELECT id, transport_state, status, lease_generation, dispatch_authorized_generation,
                         first_dispatch_at, uncertainty_deadline_at, provider_message_id, leased_from_state,
                         locked_by, scheduled_for
                    FROM public.notification_outbox WHERE related_rebook_round_id=$1 ORDER BY id`, [round])).rows;

const decisionsOf = async (c: pg.Client, round: string): Promise<string[]> =>
  (await c.query(`SELECT outcome FROM public.rebook_round_recipient_decisions
                   WHERE rebook_round_id=$1 ORDER BY outcome`, [round])).rows.map((r) => r.outcome);

// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E-3 — the transport chain, end to end on the real schema', () => {
  it('materializes a queued D7 row carrying a frozen request, key and hash', async () => {
    const c = await freshDb();
    const { round } = await seedRound(c, 1);
    const mat = await materialize(c);
    expect(mat[0]).toMatchObject({ decisions_written: 1 });
    const rows = await outboxOf(c, round);
    expect(rows).toHaveLength(1);
    expect(rows[0].transport_state).toBe('queued');
    expect(rows[0].lease_generation).toBe(0);
    const frozen = (await c.query(
      `SELECT canonical_request_bytes IS NOT NULL AS bytes, provider_idempotency_key IS NOT NULL AS key,
              request_hash IS NOT NULL AS hash FROM public.notification_outbox WHERE id=$1`, [rows[0].id])).rows[0];
    expect(frozen).toEqual({ bytes: true, key: true, hash: true });
  });

  it('HAPPY PATH — claim, resolve, begin, ONE send, record, and the SERVER decides the outcome', async () => {
    const c = await freshDb();
    const { round } = await seedRound(c, 1);
    await materialize(c);
    const run = await runWorker(c);
    expect(run.summary.status).toBe('ok');
    expect(run.summary.claimed).toBe(1);
    expect(run.summary.authorized).toBe(1);
    expect(run.summary.observed).toBe(1);
    expect(run.summary.recorded).toBe(1);
    expect(run.sends).toHaveLength(1);
    // The provider key the worker sent is the one the DATABASE froze — never one it invented.
    const frozenKey = (await c.query(
      `SELECT provider_idempotency_key k FROM public.notification_outbox WHERE related_rebook_round_id=$1`,
      [round])).rows[0].k;
    expect(run.sends[0].idempotencyKey).toBe(frozenKey);
    expect(await decisionsOf(c, round)).toEqual(['dispatch_accepted']);
    const rows = await outboxOf(c, round);
    expect(rows[0].provider_message_id).toBe('msg_accepted');
    expect(rows[0].first_dispatch_at).not.toBeNull();
  });

  it('a SECOND run finds nothing: a decided member is finished whatever state its row is in', async () => {
    const c = await freshDb();
    await seedRound(c, 1);
    await materialize(c);
    await runWorker(c);
    const again = await runWorker(c, { token: 'second-worker' });
    expect(again.summary.claimed).toBe(0);
    expect(again.sends).toHaveLength(0);
  });

  it('TWO WORKERS get DISJOINT rows — FOR UPDATE SKIP LOCKED, proved with real concurrency', async () => {
    const c = await freshDb();
    const { round } = await seedRound(c, 2);
    await materialize(c);
    expect(await outboxOf(c, round)).toHaveLength(2);

    const a = chain.connect(c.database as unknown as string);
    const b = chain.connect(c.database as unknown as string);
    await a.connect(); await b.connect();
    try {
      await a.query('SET ROLE service_role'); await b.query('SET ROLE service_role');
      await a.query('BEGIN'); await b.query('BEGIN');
      // A takes ONE and holds its lock open; B must SKIP that row and take the other.
      const ra = (await a.query(`SELECT * FROM public.rebook_member_open_claim_batch('worker-a', 1)`)).rows;
      const rb = (await b.query(`SELECT * FROM public.rebook_member_open_claim_batch('worker-b', 8)`)).rows;
      expect(ra, 'worker A leases exactly one row').toHaveLength(1);
      expect(rb, 'worker B is not blocked, and gets the row A did not take').toHaveLength(1);
      expect(ra[0].outbox_id).not.toBe(rb[0].outbox_id);
      await a.query('COMMIT'); await b.query('COMMIT');
    } finally {
      await a.end().catch(() => undefined);
      await b.end().catch(() => undefined);
    }
    const rows = await outboxOf(c, round);
    expect(rows.every((r) => r.transport_state === 'leased')).toBe(true);
    expect(new Set(rows.map((r) => r.locked_by)).size, 'each row is held by a DIFFERENT worker').toBe(2);
  });

  it('STALE LEASE, never authorized → recovered to the EXACT stored origin, generation bumped', async () => {
    const c = await freshDb();
    const { round } = await seedRound(c, 1);
    await materialize(c);
    await c.query('SET ROLE service_role');
    const claimed = (await c.query(
      `SELECT * FROM public.rebook_member_open_claim_batch('abandoning-worker', 8)`)).rows;
    await c.query('RESET ROLE');
    expect(claimed).toHaveLength(1);
    expect(claimed[0].leased_from_state).toBe('queued');
    // THE WORKER DIES HERE: leased, never authorized, so no provider request can have crossed.
    // A LIVE lease is untouched at the production threshold — proved first, so the recovery below
    // is a recovery of an ABANDONED lease and not merely of any lease.
    const untouched = await runJanitor(c);
    expect(untouched.recovered, 'a lease younger than the threshold is nobody else\'s to take').toBe(0);
    const janitor = await runJanitor(c, 0);
    expect(janitor.status).toBe('ok');
    expect(janitor.recovered).toBe(1);
    expect(janitor.recoveredTo, 'never authorized → back to its exact stored origin, still sendable')
      .toEqual({ queued: 1 });
    const rows = await outboxOf(c, round);
    expect(rows[0].transport_state).toBe('queued');
    expect(rows[0].lease_generation as number, 'every capability handed to the dead worker is now dead')
      .toBeGreaterThan(claimed[0].lease_generation);
    expect(rows[0].locked_by).toBeNull();
    // ...and the recovered row is claimable and sendable again.
    const run = await runWorker(c, { token: 'recovering-worker' });
    expect(run.summary.recorded).toBe(1);
    expect(await decisionsOf(c, round)).toEqual(['dispatch_accepted']);
  });

  it('BEGUN THEN LOST → acceptance_uncertain → close_unresolved → dispatch_unknown', async () => {
    const c = await freshDb();
    // A SHORT MEMBER WINDOW, because the uncertainty deadline is `least(member_window_ends_at,
    // now + 23 hours)` and it is write-once. Six seconds is long enough for materialize, claim,
    // resolve and begin to run inside an OPEN window — which they must, or the arm under test is
    // never reached — and short enough for the deadline to arrive during the test.
    const { round } = await seedRound(c, 1, { memberWindow: `now()+interval '6 seconds'` });
    await materialize(c);
    await c.query('SET ROLE service_role');
    const claimed = (await c.query(
      `SELECT * FROM public.rebook_member_open_claim_batch('lost-worker', 8)`)).rows[0];
    await c.query(`SELECT * FROM public.rebook_member_open_pre_dispatch_resolve($1,'lost-worker',$2)`,
      [claimed.outbox_id, claimed.lease_generation]);
    const begun = (await c.query(
      `SELECT * FROM public.rebook_member_open_begin_dispatch($1,'lost-worker',$2,$3,$4,$5,$6)`,
      [claimed.outbox_id, claimed.lease_generation, claimed.request_hash,
        claimed.canonical_request_bytes, claimed.provider_idempotency_key, claimed.leased_from_state])).rows[0];
    await c.query('RESET ROLE');
    expect(begun.outcome).toBe('begun');
    // The response never comes back. A request MAY have crossed the boundary.
    const recovery = await runJanitor(c, 0);
    expect(recovery.recoveredTo,
      'authorized-but-unanswered must NOT return to a sendable origin — that would authorize a second call')
      .toEqual({ acceptance_uncertain: 1 });
    expect((await outboxOf(c, round))[0].transport_state).toBe('acceptance_uncertain');
    // The claim deliberately excludes `acceptance_uncertain`: an uncertain origin is unsendable.
    const blocked = await runWorker(c, { token: 'later-worker' });
    expect(blocked.summary.claimed, 'an uncertain row is never re-leased for sending').toBe(0);
    // Closure decides it honestly once the row's OWN write-once deadline has passed. The deadline
    // is `least(member_window_ends_at, now + 23 hours)`, and it cannot be edited afterwards — an
    // absent or invented deadline would finalize a member on a clock the row never agreed to — so
    // the arm is reached by seeding a round whose window closes in seconds and waiting for the
    // DATABASE's own clock to pass it.
    for (let i = 0; i < 200; i += 1) {
      const { rows } = await c.query(
        `SELECT uncertainty_deadline_at <= clock_timestamp() AS due
           FROM public.notification_outbox WHERE id=$1`, [claimed.outbox_id]);
      if (rows[0].due) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const closing = await runJanitor(c, 0);
    expect(closing.closed).toBe(1);
    expect(closing.closedAs).toEqual({ dispatch_unknown: 1 });
    expect(await decisionsOf(c, round)).toEqual(['dispatch_unknown']);
  });

  it('CHANNEL KILL → deferred, with ZERO provider calls and NO decision', async () => {
    const c = await freshDb();
    const { round } = await seedRound(c, 1);
    await materialize(c);
    await c.query(`INSERT INTO public.notification_channel_kill_switches(channel,reason,request_id)
                   VALUES ('email','d7 runtime evidence kill',gen_random_uuid())`);
    const run = await runWorker(c);
    expect(run.summary.status, 'a kill is an operational deferral, not a failure').toBe('ok');
    expect(run.summary.deferred).toBe(1);
    expect(run.sends, 'a killed channel must reach no provider at all').toHaveLength(0);
    const rows = await outboxOf(c, round);
    expect(rows[0].transport_state).toBe('channel_kill_deferred');
    expect(rows[0].first_dispatch_at, 'nothing was authorized').toBeNull();
    expect(await decisionsOf(c, round), 'a deferral decides nothing').toEqual([]);
    // ...and the deferred state is a claim ORIGIN, so the row is not wedged: it comes back.
    const origins = (await c.query(`SELECT public.rebook_round_transport_states() v`)).rows[0].v;
    expect(origins).toContain('channel_kill_deferred');
  });

  it('QUIET HOURS → deferred with a computed release instant, ZERO provider calls', async () => {
    // The complementary fixture to every other dispatch test: a tenant whose LOCAL clock is
    // currently outside the 09:00–20:00 window, chosen from the database's own clock.
    const c = await freshDb({ quietHours: true });
    const { round } = await seedRound(c, 1);
    await materialize(c);
    const run = await runWorker(c);
    expect(run.summary.deferred).toBe(1);
    expect(run.sends).toHaveLength(0);
    const rows = await outboxOf(c, round);
    expect(rows[0].transport_state).toBe('quiet_hours_deferred');
    expect(rows[0].scheduled_for, 'quiet hours carries its computed release instant').not.toBeNull();
    expect(await decisionsOf(c, round)).toEqual([]);
  });

  it('MEMBER WINDOW CLOSED between materialize and dispatch → terminal, ZERO provider calls', async () => {
    const c = await freshDb();
    const { round } = await seedRound(c, 1, { memberWindow: `now()+interval '2 seconds'` });
    await materialize(c);
    expect(await outboxOf(c, round)).toHaveLength(1);
    // Wait for the window the round itself declared. Polling the DATABASE's clock, not the
    // process's, is what makes this deterministic rather than a race against a fixed sleep.
    for (let i = 0; i < 100; i += 1) {
      const { rows } = await c.query(
        `SELECT member_window_ends_at <= clock_timestamp() AS closed FROM public.rebook_rounds WHERE id=$1`, [round]);
      if (rows[0].closed) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const run = await runWorker(c);
    expect(run.sends, 'an invitation into a closed window is a promise the product cannot keep').toHaveLength(0);
    expect(run.summary.terminalRetained + run.summary.terminalDeleted).toBe(1);
    expect(await decisionsOf(c, round)).toEqual(['member_window_closed']);
  });

  it('G-8 — a never-dispatched row that becomes terminally ineligible is DECIDED AND DELETED', async () => {
    const c = await freshDb();
    const { round, recipients } = await seedRound(c, 1);
    await materialize(c);
    expect(await outboxOf(c, round)).toHaveLength(1);
    // The person rebooks after the universe was frozen: they now have a seat, so the live
    // eligibility arm that put them in the round no longer holds.
    await c.query(`UPDATE public.slot_priority_claims SET status='claimed' WHERE id=$1`, [recipients[0].claim]);
    const run = await runWorker(c);
    expect(run.sends).toHaveLength(0);
    expect(run.summary.terminalDeleted, 'never authorized → the transport row is deleted, not retained').toBe(1);
    expect(run.summary.terminalRetained).toBe(0);
    expect(await outboxOf(c, round), 'the transport row is gone').toHaveLength(0);
    expect(await decisionsOf(c, round),
      'the DECISION is what proves the member was disposed of — it survives the row').toEqual(['ineligible']);
  });

  it('the CAPABILITY READER answers after a lost response, and refuses a wrong capability identically', async () => {
    const c = await freshDb();
    await seedRound(c, 1);
    await materialize(c);
    await c.query('SET ROLE service_role');
    const claimed = (await c.query(
      `SELECT * FROM public.rebook_member_open_claim_batch('reader-worker', 8)`)).rows[0];
    await c.query(`SELECT * FROM public.rebook_member_open_pre_dispatch_resolve($1,'reader-worker',$2)`,
      [claimed.outbox_id, claimed.lease_generation]);
    await c.query(`SELECT * FROM public.rebook_member_open_begin_dispatch($1,'reader-worker',$2,$3,$4,$5,$6)`,
      [claimed.outbox_id, claimed.lease_generation, claimed.request_hash,
        claimed.canonical_request_bytes, claimed.provider_idempotency_key, claimed.leased_from_state]);
    const good = (await c.query(
      `SELECT * FROM public.rebook_member_open_dispatch_status_by_capability($1,$2,$3,$4)`,
      [claimed.outbox_id, claimed.lease_generation, claimed.request_hash, claimed.provider_idempotency_key])).rows;
    const wrongKey = (await c.query(
      `SELECT * FROM public.rebook_member_open_dispatch_status_by_capability($1,$2,$3,$4)`,
      [claimed.outbox_id, claimed.lease_generation, claimed.request_hash, 'not-the-key'])).rows;
    const noSuchRow = (await c.query(
      `SELECT * FROM public.rebook_member_open_dispatch_status_by_capability($1,$2,$3,$4)`,
      ['00000000-0000-4000-8000-000000000000', claimed.lease_generation,
        claimed.request_hash, claimed.provider_idempotency_key])).rows;
    await c.query('RESET ROLE');
    expect(good).toHaveLength(1);
    expect(good[0].outcome).toBe('observed');
    expect(good[0].first_dispatch_at, 'the reader is how a worker learns its lost request WAS authorized')
      .not.toBeNull();
    // A CAPABILITY MISMATCH AND A NON-EXISTENT ROW MUST BE INDISTINGUISHABLE, or the surface is an
    // enumeration oracle for anyone who reaches it.
    expect(wrongKey).toHaveLength(1);
    expect(noSuchRow).toHaveLength(1);
    expect(wrongKey[0]).toEqual(noSuchRow[0]);
    expect(wrongKey[0].outcome).toBe('refused');
    // A REFUSAL IS A ROW WITH EVERYTHING ELSE NULL, which is what makes it carry no information.
    expect(wrongKey[0].transport_state).toBeNull();
    expect(wrongKey[0].first_dispatch_at).toBeNull();
  });
});

// ── E-1: the bytea round trip ────────────────────────────────────────────────────────────────

describe('E-1 — a bytea capability survives the PostgREST hex text form byte-for-byte', () => {
  it('round-trips request_hash through the "\\\\x…" wire form without changing a byte', async () => {
    const c = await freshDb();
    const { round } = await seedRound(c, 1);
    await materialize(c);
    const { rows } = await c.query(
      `SELECT request_hash FROM public.notification_outbox WHERE related_rebook_round_id=$1`, [round]);
    const buf = rows[0].request_hash as Buffer;
    const wire = `\\x${buf.toString('hex')}`;
    const back = await c.query(
      `SELECT $1::bytea = $2::bytea AS same, octet_length($1::bytea) AS n`, [wire, buf]);
    expect(back.rows[0].same, 'the hex text form must decode to the identical bytes').toBe(true);
    expect(back.rows[0].n).toBe(32);
  });

  it('the WHOLE worker chain runs on the PostgREST-shaped carrier, and nothing mismatches', async () => {
    const c = await freshDb();
    const { round } = await seedRound(c, 1);
    await materialize(c);
    // Every bytea coming back is rendered as PostgREST renders it, and the worker hands the string
    // straight back. A byte-level failure here would surface as `frozen_request_mismatch`, so a
    // `begun` outcome and a recorded acceptance IS the round-trip proof.
    const run = await runWorker(c, { postgrestShaped: true, token: 'postgrest-shaped-worker' });
    expect(run.summary.status).toBe('ok');
    expect(run.summary.authorized).toBe(1);
    expect(run.summary.recorded).toBe(1);
    expect(run.logs.some((l) => l.refusal_reason === 'frozen_request_mismatch')).toBe(false);
    expect(await decisionsOf(c, round)).toEqual(['dispatch_accepted']);
  });

  it('a CORRUPTED hash is refused — so the round trip above is proving something', async () => {
    const c = await freshDb();
    await seedRound(c, 1);
    await materialize(c);
    await c.query('SET ROLE service_role');
    const claimed = (await c.query(
      `SELECT * FROM public.rebook_member_open_claim_batch('corrupt-worker', 8)`)).rows[0];
    await c.query(`SELECT * FROM public.rebook_member_open_pre_dispatch_resolve($1,'corrupt-worker',$2)`,
      [claimed.outbox_id, claimed.lease_generation]);
    const flipped = Buffer.from(claimed.request_hash as Buffer);
    flipped[0] ^= 0xff;
    const begun = (await c.query(
      `SELECT * FROM public.rebook_member_open_begin_dispatch($1,'corrupt-worker',$2,$3,$4,$5,$6)`,
      [claimed.outbox_id, claimed.lease_generation, flipped,
        claimed.canonical_request_bytes, claimed.provider_idempotency_key, claimed.leased_from_state])).rows[0];
    await c.query('RESET ROLE');
    expect(begun.outcome, 'a byte-corrupted capability must never authorize a send').toBe('refused');
    // THE CAPABILITY FENCE CATCHES IT FIRST, and that is the stronger answer: the request hash is
    // PART of the capability the claim handed out, so a flipped byte fails capability verification
    // before `frozen_request_mismatch` is ever reached. Either way no send is authorized — which
    // is what makes the clean round trip above evidence rather than coincidence.
    expect(begun.refusal_reason).toBe('capability_mismatch');
  });
});

// ── P-1 / P-5: bounds ────────────────────────────────────────────────────────────────────────

describe('P-5 — the worst-case invocation arithmetic, stated and defended', () => {
  it('keeps the absolute ceiling an order of magnitude under the stale-lease threshold', () => {
    const L = REBOOK_MEMBER_OPEN_WORKER_LIMITS;
    // The bound is NOT claimLimit x send timeout: the wall-clock budget stops the loop STARTING a
    // row, so at most one row is admitted after the budget is already spent.
    const worst = L.rpcTimeoutMs            // the claim
      + L.wallClockMs                       // the last row admitted at budget - 1ms
      + 3 * L.rpcTimeoutMs                  // that row's resolve + begin + record
      + OBSERVED_SEND_TIMEOUT_MS;           // that row's ONE provider call
    expect(worst).toBe(85_000);
    const staleMs = L.staleAfterMinutes * 60_000;
    expect(staleMs).toBe(900_000);
    expect(worst, 'a healthy invocation must never have its own leases recovered underneath it')
      .toBeLessThan(staleMs / 10);
    // The janitor SHIPS with the same threshold, so the two cannot drift in production.
    expect(REBOOK_MEMBER_OPEN_JANITOR_LIMITS.staleAfterMinutes).toBe(L.staleAfterMinutes);
  });
});

// ── E-12 / RP-3: the paid-group court hold, for EVERY payment mode ───────────────────────────
//
// The owner ruled that a freed seat on a court a PAID rebook group already holds must not be
// offered, whatever `rebook_payment_mode` says. Since `20261203130000` that rule is enforced at
// EVERY point this system observes eligibility — the materializer, the live pre-dispatch resolve,
// and the durable `begin_dispatch` authorization, which is the LINEARIZATION POINT. It is a rule
// about observations, not an impossibility claim: a payment committed after the linearization point
// does not retroactively invalidate an already-authorized send. E-14 proves both halves. `20261203120000` folds the canonical
// SLOT-LEVEL hold into arm (4) of the live-eligibility authority and RETAINS the cycle-wide
// `upfront` suppression in arm (5) beside it.
//
// These are the discriminating proofs of that rule, not a recording of a residual. Each one is
// paired with the control that makes it mean something: a suppression is only evidence if the same
// fixture WITHOUT the hold stays eligible, and a non-suppression is only evidence if the fixture
// really did carry a group and an invoice.

/**
 * THE CANONICAL HOLD FIXTURE: a court held by a paid rebook group.
 *
 * The hold is a fact about a BOOKING, not about a claim and not about an invoice — a covered re-seat
 * is written straight onto the court as `payment_status = 'paid'` with the CAPTAIN recorded in
 * `paid_by_player_id` / `paid_by_guest_player_id`, and `rebook_group_manage` decides a group is paid
 * by reading exactly that. So the fixture writes what the product writes.
 *
 * `paid_by_*` is what separates a GROUP hold from a member who paid for their own seat: it is set
 * only when somebody else paid. That distinction has its own adversarial arm below.
 */
async function holdSlot(c: pg.Client, slot: string): Promise<string> {
  const captain = (await c.query(`SELECT id FROM public.profiles LIMIT 1`)).rows[0].id;
  return (await c.query(`
    INSERT INTO public.bookings (slot_id, player_id, status, payment_status, paid_at,
                                 paid_by_player_id, created_at, updated_at)
    VALUES ($1, $2, 'confirmed', 'paid', now(), $3, now(), now())
    RETURNING id`, [slot, captain, captain])).rows[0].id;
}

/**
 * A booking on `slot` that is paid but NOT by anyone else — a member paying for their own seat.
 *
 * It occupies a seat, which the capacity arm handles, and it must NOT hold the whole court.
 */
async function selfPaidBooking(c: pg.Client, slot: string): Promise<string> {
  const who = (await c.query(`SELECT id FROM public.profiles LIMIT 1`)).rows[0].id;
  return (await c.query(`
    INSERT INTO public.bookings (slot_id, player_id, status, payment_status, paid_at, created_at, updated_at)
    VALUES ($1, $2, 'confirmed', 'paid', now(), now(), now()) RETURNING id`, [slot, who])).rows[0].id;
}

/** Give `claim` a fresh rebook group. Retained ONLY to build the retired claim/invoice shape. */
async function attachGroup(c: pg.Client, claim: string): Promise<string> {
  const group = (await c.query(`SELECT gen_random_uuid() g`)).rows[0].g;
  await c.query(`UPDATE public.slot_priority_claims SET rebook_group_id=$1::uuid WHERE id=$2`,
    [group, claim]);
  return group;
}

/**
 * Mint a group-captain invoice.
 *
 * Retained for the arms that prove the RETIRED anchors are inert. `invoices_status_check` admits
 * exactly `draft`, `sent`, `paid`, `cancelled` and `overdue`.
 */
async function invoiceFor(c: pg.Client, group: string, status = 'paid'): Promise<void> {
  await c.query(
    `INSERT INTO public.invoices(invoice_number,due_date,player_name,status,rebook_group_id)
     VALUES ('D7-E12-' || left(gen_random_uuid()::text, 12), current_date, 'D7 evidence', $2, $1::uuid)`,
    [group, status]);
}

/** One more open slot on `cycle`, with `max_participants` free seats and nobody booked. */
async function addSlot(c: pg.Client, cycle: string): Promise<string> {
  const lane = nextLane();
  return (await c.query(`INSERT INTO public.availability_slots
    (id,trainer_id,academy_profile_id,source_cycle_id,start_time,end_time,max_participants,member_window_ends_at)
    VALUES (gen_random_uuid(),$1,$2,$3,now()+interval '2 days'+make_interval(hours => ${lane}),
            now()+interval '2 days 1 hour'+make_interval(hours => ${lane}),4,now()+interval '30 days')
    RETURNING id`, [TRAINER, ACADEMY, cycle])).rows[0].id;
}

/**
 * A SECOND sibling cycle inside an existing round, with its own court, recipient and provenance.
 *
 * Built in dependency order — cycle, court, recipient, claim, then the append-only claim source —
 * because the snapshot relations refuse UPDATE and DELETE even for the owner.
 */
async function addSiblingRecipient(
  c: pg.Client,
  round: string,
): Promise<{ cycle: string; slot: string; recipient: string; claim: string }> {
  const cycle = (await c.query(
    `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
     VALUES (gen_random_uuid(),$1,'academy','cyclus','D7 sibling two','open',current_date) RETURNING id`,
    [ACADEMY])).rows[0].id;
  await c.query(`ALTER TABLE public.cycles DISABLE TRIGGER trg_guard_cycle_zz2_apply_capability`);
  try {
    await c.query(`UPDATE public.cycles SET rebook_round_id=$1 WHERE id=$2`, [round, cycle]);
  } finally {
    await c.query(`ALTER TABLE public.cycles ENABLE TRIGGER trg_guard_cycle_zz2_apply_capability`);
  }
  const slot = await addSlot(c, cycle);
  const user = (await c.query(`INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
  const profile = (await c.query(`SELECT id FROM public.profiles WHERE user_id=$1`, [user])).rows[0].id;
  await c.query(`INSERT INTO public.notification_contacts
    (user_id,channel,destination_normalized,destination_redacted,verified_at,consent_status,consent_scope,is_primary)
    VALUES ($1,'email',$2,'r***@example.test',clock_timestamp(),'unknown','global',true)`,
  [user, `${user}@example.test`]);
  const recipient = (await c.query(`INSERT INTO public.rebook_round_recipients
    (rebook_round_id,academy_profile_id,recipient_player_profile_id,captured_at)
    VALUES ($1,$2,$3,clock_timestamp()) RETURNING id`, [round, ACADEMY, profile])).rows[0].id;
  const claim = (await c.query(`INSERT INTO public.slot_priority_claims(slot_id,player_id,status)
    VALUES ($1,$2,'pending') RETURNING id`, [slot, profile])).rows[0].id;
  await c.query(`INSERT INTO public.rebook_round_recipient_claim_sources
    (rebook_round_recipient_id,rebook_round_id,academy_profile_id,source_claim_id,
     source_slot_id,source_cycle_id,claimed_player_profile_id,claim_status,captured_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',clock_timestamp())`,
  [recipient, round, ACADEMY, claim, slot, cycle, profile]);
  return { cycle, slot, recipient, claim };
}

/**
 * A SECOND provenance cycle for an EXISTING recipient inside the same round.
 *
 * This is the shape the union in arm (4) is for: one snapshot recipient whose immutable provenance
 * names TWO sibling cycles, so eligibility is `bool_or` over them rather than a single answer. A
 * second RECIPIENT in a second cycle cannot exercise it — each of those is judged alone.
 */
async function addProvenanceCycle(
  c: pg.Client,
  round: string,
  recipient: string,
  profile: string,
): Promise<{ cycle: string; slot: string; claim: string }> {
  const cycle = (await c.query(
    `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
     VALUES (gen_random_uuid(),$1,'academy','cyclus','D7 second provenance','open',current_date) RETURNING id`,
    [ACADEMY])).rows[0].id;
  await c.query(`ALTER TABLE public.cycles DISABLE TRIGGER trg_guard_cycle_zz2_apply_capability`);
  try {
    await c.query(`UPDATE public.cycles SET rebook_round_id=$1 WHERE id=$2`, [round, cycle]);
  } finally {
    await c.query(`ALTER TABLE public.cycles ENABLE TRIGGER trg_guard_cycle_zz2_apply_capability`);
  }
  const slot = await addSlot(c, cycle);
  const claim = (await c.query(`INSERT INTO public.slot_priority_claims(slot_id,player_id,status)
    VALUES ($1,$2,'pending') RETURNING id`, [slot, profile])).rows[0].id;
  await c.query(`INSERT INTO public.rebook_round_recipient_claim_sources
    (rebook_round_recipient_id,rebook_round_id,academy_profile_id,source_claim_id,
     source_slot_id,source_cycle_id,claimed_player_profile_id,claim_status,captured_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',clock_timestamp())`,
  [recipient, round, ACADEMY, claim, slot, cycle, profile]);
  return { cycle, slot, claim };
}

const eligible = async (c: pg.Client, round: string, recipient: string): Promise<boolean> => {
  const { rows } = await c.query(
    `SELECT * FROM public.rebook_round_eligible_recipients($1, ARRAY[$2]::uuid[])`, [round, recipient]);
  expect(rows, 'the authority answers for every id it is asked about').toHaveLength(1);
  return (rows[0].eligible ?? rows[0].ok) as boolean;
};

describe('E-12 / RP-3 — a paid group holds its court against every payment mode', () => {
  it('the fixture writes the product\'s own paid fact, where the product keeps it', async () => {
    // `rebook_group_manage` decides a group is paid by reading `bookings.payment_status = 'paid'`
    // on the claim's booking, and a covered re-seat is inserted with `paid_by_*` set to the captain.
    // This asserts the fixture produces exactly that row, so every arm below is exercising the
    // product's shape rather than a shape invented for the test.
    const c = await freshDb();
    const { recipients } = await seedRound(c, 1);
    const shape = async () => (await c.query(`
      SELECT count(*)::int AS n
        FROM public.bookings b
       WHERE b.slot_id = $1 AND b.status IS DISTINCT FROM 'cancelled'
         AND b.payment_status = 'paid'
         AND (b.paid_by_player_id IS NOT NULL OR b.paid_by_guest_player_id IS NOT NULL)`,
    [recipients[0].slot])).rows[0].n;
    expect(await shape(), 'CONTROL — an ordinary court carries no paid-group booking').toBe(0);
    await holdSlot(c, recipients[0].slot);
    expect(await shape(), 'and the fixture makes it one').toBe(1);
  });

  it('DEFERRED_SPLIT + a paid-group-held court → SUPPRESSED (the repair)', async () => {
    const c = await freshDb();
    // No `rebook_payment_mode` at all: the cycle-wide arm cannot be what suppresses this.
    const { round, recipients } = await seedRound(c, 1);
    expect(await eligible(c, round, recipients[0].recipient),
      'CONTROL — before the hold, this recipient is eligible').toBe(true);
    await holdSlot(c, recipients[0].slot);
    expect(await eligible(c, round, recipients[0].recipient),
      'a freed seat on a paid group\'s court is not offered').toBe(false);
  });

  it('the same holds when the mode is spelled out as deferred_split', async () => {
    const c = await freshDb();
    const { round, recipients } = await seedRound(c, 1, {
      cycleSettings: { rebook_payment_mode: 'deferred_split' },
    });
    expect(await eligible(c, round, recipients[0].recipient)).toBe(true);
    await holdSlot(c, recipients[0].slot);
    expect(await eligible(c, round, recipients[0].recipient)).toBe(false);
  });

  it('UPFRONT stays cycle-wide suppressed, with or without a paid group', async () => {
    // Arm (5) is RETAINED, not replaced: an upfront round is paid in full at claim time whether or
    // not a group invoice exists, so it is suppressed for its own, still-valid reason.
    for (const withGroup of [false, true]) {
      const c = await freshDb();
      const { round, recipients } = await seedRound(c, 1, {
        cycleSettings: { rebook_payment_mode: 'upfront' },
      });
      if (withGroup) await holdSlot(c, recipients[0].slot);
      expect(await eligible(c, round, recipients[0].recipient),
        `upfront (paid group: ${withGroup}) must be suppressed`).toBe(false);
    }
  });

  it('NO CROSS-SLOT OVER-SUPPRESSION: a free seat on another court still invites', async () => {
    // This is the property that makes the hold slot-level rather than cycle-level. The recipient's
    // OWN court is held; a sibling court in the same cycle has free seats and nobody holding it.
    const c = await freshDb();
    const { round, cycle, recipients } = await seedRound(c, 1);
    await holdSlot(c, recipients[0].slot);
    expect(await eligible(c, round, recipients[0].recipient), 'held, and no alternative yet').toBe(false);
    await addSlot(c, cycle);
    expect(await eligible(c, round, recipients[0].recipient),
      'a genuinely free seat on an unheld court in the same sibling is still an invitation')
      .toBe(true);
  });

  it('…and when EVERY court in the sibling is held, it is suppressed again', async () => {
    const c = await freshDb();
    const { round, cycle, recipients } = await seedRound(c, 1);
    await holdSlot(c, recipients[0].slot);
    const other = await addSlot(c, cycle);
    expect(await eligible(c, round, recipients[0].recipient)).toBe(true);
    await holdSlot(c, other);
    expect(await eligible(c, round, recipients[0].recipient),
      'no unheld court is left to offer').toBe(false);
  });

  it('AN UNPAID GROUP NEVER SUPPRESSES — the invoice status is the whole rule', async () => {
    for (const status of ['draft', 'sent', 'cancelled', 'overdue']) {
      const c = await freshDb();
      const { round, recipients } = await seedRound(c, 1);
      const group = await attachGroup(c, recipients[0].claim);
      await invoiceFor(c, group, status);
      expect((await c.query(`SELECT public.slot_held_by_paid_group($1) AS h`, [recipients[0].slot]))
        .rows[0].h, `${status}: the canonical authority agrees it is NOT held`).toBe(false);
      expect(await eligible(c, round, recipients[0].recipient),
        `an invoice in '${status}' must not hold the court`).toBe(true);
    }
  });

  it('a group with NO invoice at all never suppresses', async () => {
    const c = await freshDb();
    const { round, recipients } = await seedRound(c, 1);
    await attachGroup(c, recipients[0].claim);
    expect(await eligible(c, round, recipients[0].recipient)).toBe(true);
  });

  it('a PAID invoice for a DIFFERENT group never suppresses', async () => {
    const c = await freshDb();
    const { round, recipients } = await seedRound(c, 1);
    await attachGroup(c, recipients[0].claim);
    const unrelated = (await c.query(`SELECT gen_random_uuid() g`)).rows[0].g;
    await invoiceFor(c, unrelated, 'paid');
    expect(await eligible(c, round, recipients[0].recipient),
      'the join is by group identity; an unrelated paid group is not this court\'s').toBe(true);
  });

  it('NO CROSS-ROUND OVER-SUPPRESSION: a held court in another round is not this one', async () => {
    const c = await freshDb();
    const a = await seedRound(c, 1);
    const b = await seedRound(c, 1);
    await holdSlot(c, b.recipients[0].slot);
    expect(await eligible(c, b.round, b.recipients[0].recipient), 'the held round is suppressed').toBe(false);
    expect(await eligible(c, a.round, a.recipients[0].recipient),
      'and the other round, in the same academy, is untouched').toBe(true);
  });

  it('NO CROSS-CYCLE OVER-SUPPRESSION *within one round*: sibling cycles are judged apart', async () => {
    // The harder case, and the one a round-scoped mistake would pass: TWO sibling cycles of the
    // SAME round, one of them holding a paid court. Judging per round rather than per cycle would
    // suppress both. The sibling is built BEFORE its provenance, because
    // `rebook_round_recipient_claim_sources` is append-only by design and refuses an UPDATE — so a
    // fixture cannot retarget a snapshot after the fact, which is exactly the property that makes
    // the snapshot trustworthy.
    const c = await freshDb();
    const { round, recipients } = await seedRound(c, 1);
    const sibling = await addSiblingRecipient(c, round);
    expect(await eligible(c, round, recipients[0].recipient), 'CONTROL — both start eligible').toBe(true);
    expect(await eligible(c, round, sibling.recipient)).toBe(true);

    await holdSlot(c, recipients[0].slot);
    expect(await eligible(c, round, recipients[0].recipient), 'the held sibling is suppressed').toBe(false);
    expect(await eligible(c, round, sibling.recipient),
      'and the OTHER sibling cycle of the SAME round is untouched').toBe(true);
  });

  it('A FOREIGN TENANT\'s paid group never suppresses', async () => {
    const c = await freshDb();
    const OTHER = '22222222-2222-4222-8222-222222222222';
    await c.query(`INSERT INTO public.academy_profiles(id,name) VALUES ($1,'other') ON CONFLICT DO NOTHING`,
      [OTHER]);
    const { round, recipients } = await seedRound(c, 1);
    // A whole paid-group-held court belonging to another academy.
    const foreignTrainer = (await c.query(
      `INSERT INTO public.trainer_profiles(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
    const foreignCycle = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','foreign','open',current_date) RETURNING id`, [OTHER])).rows[0].id;
    const lane = nextLane();
    const foreignSlot = (await c.query(`INSERT INTO public.availability_slots
      (id,trainer_id,academy_profile_id,source_cycle_id,start_time,end_time,max_participants,member_window_ends_at)
      VALUES (gen_random_uuid(),$1,$2,$3,now()+interval '2 days'+make_interval(hours => ${lane}),
              now()+interval '2 days 1 hour'+make_interval(hours => ${lane}),4,now()+interval '30 days')
      RETURNING id`, [foreignTrainer, OTHER, foreignCycle])).rows[0].id;
    await holdSlot(c, foreignSlot);
    // The foreign court really IS held, by the authority this release uses — the assertion below is
    // therefore about containment and not about an unbuilt fixture.
    expect((await c.query(`
      SELECT count(*)::int n FROM public.bookings b
       WHERE b.slot_id = $1 AND b.payment_status = 'paid'
         AND (b.paid_by_player_id IS NOT NULL OR b.paid_by_guest_player_id IS NOT NULL)`,
    [foreignSlot])).rows[0].n, 'the foreign court is genuinely held').toBe(1);
    expect(await eligible(c, round, recipients[0].recipient),
      'another academy\'s held court says nothing about this one — the booking-to-slot join IS the boundary')
      .toBe(true);
  });

  it('PARITY WITH THE PRODUCT\'S OWN PAID READER, slot for slot', async () => {
    // WHAT REPLACED LEGACY PARITY, AND WHY. The retired `slot_held_by_paid_group` derives the hold
    // from a claim joined to a paid invoice, and this release deliberately no longer agrees with it:
    // an ordinary guest merge deletes that claim while the payment survives. Asserting agreement
    // with a predicate the owner retired would pin the defect in place.
    //
    // The authority parity is measured against instead is the one the PRODUCT uses:
    // `rebook_group_manage` decides a group is paid by reading `bookings.payment_status = 'paid'`,
    // and a covered re-seat records the captain in `paid_by_*`. This compares the installed
    // eligibility hold against that reading over EVERY slot in the database rather than the ones the
    // test remembered to name.
    const c = await freshDb();
    const { cycle, recipients } = await seedRound(c, 1);
    await holdSlot(c, recipients[0].slot);                                    // held by a group
    const selfPaid = await addSlot(c, cycle);
    await selfPaidBooking(c, selfPaid);                                       // paid, nobody else
    const cancelled = await addSlot(c, cycle);
    await c.query(`UPDATE public.bookings SET status='cancelled' WHERE id=$1`,
      [await holdSlot(c, cancelled)]);                                        // group-paid, cancelled
    const unpaid = await addSlot(c, cycle);
    const cap = (await c.query(`SELECT id FROM public.profiles LIMIT 1`)).rows[0].id;
    await c.query(`INSERT INTO public.bookings (slot_id, player_id, status, payment_status,
                                                paid_by_player_id, created_at, updated_at)
                   VALUES ($1,$2,'confirmed','pending',$2,now(),now())`, [unpaid, cap]);
    const bare = await addSlot(c, cycle);                                     // nothing at all
    const held2 = await addSlot(c, cycle);
    await holdSlot(c, held2);                                                 // a second held court

    // THE PREDICATE UNDER TEST IS LIFTED FROM THE INSTALLED FUNCTION, not retyped beside it — a
    // test-local copy proves only that the copy agrees with itself. It is pinned against the
    // comment-stripped `prosrc` first, so a body that merely MENTIONS it cannot satisfy the pin,
    // and only then run.
    const HOLD_PREDICATE = `EXISTS (
               SELECT 1
                 FROM public.bookings hb
                WHERE hb.slot_id = s.id
                  AND hb.status IS DISTINCT FROM 'cancelled'
                  AND hb.payment_status = 'paid'
                  AND (hb.paid_by_player_id IS NOT NULL OR hb.paid_by_guest_player_id IS NOT NULL)
             )`;
    const squash = (x: string) => x.replace(/\s+/g, ' ').trim();
    const raw = (await c.query(`
      SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.abc27_p_live_eligibility(uuid,uuid,uuid[],uuid[],text[],uuid[])')`
    )).rows[0].prosrc as string;
    const installed = raw.replace(/--[^\n]*|'(?:[^']|'')*'/g, (m) => (m.startsWith("'") ? m : ' '));
    expect(squash(installed),
      'the predicate exercised below must be the one the installed authority EXECUTES')
      .toContain(squash(HOLD_PREDICATE));

    const { rows } = await c.query(`
      SELECT s.id::text AS slot,
             ${HOLD_PREDICATE} AS installed_hold,
             EXISTS (SELECT 1 FROM public.bookings pb
                      WHERE pb.slot_id = s.id
                        AND pb.status IS DISTINCT FROM 'cancelled'
                        AND pb.payment_status = 'paid'
                        AND (pb.paid_by_player_id IS NOT NULL
                             OR pb.paid_by_guest_player_id IS NOT NULL)) AS product_reading
        FROM public.availability_slots s
       ORDER BY s.id`);
    expect(rows.length, 'the matrix must actually have slots').toBeGreaterThanOrEqual(6);
    expect(rows.filter((r) => r.installed_hold).length,
      'the matrix must exercise BOTH answers, or parity is vacuous').toBeGreaterThanOrEqual(2);
    expect(rows.filter((r) => !r.installed_hold).length).toBeGreaterThanOrEqual(4);
    expect(rows.filter((r) => r.installed_hold !== r.product_reading),
      'the installed hold must agree with the product\'s own paid reading on every slot').toEqual([]);
    expect(new Set(rows.map((r) => r.installed_hold)).size).toBe(2);
    void bare;
  });

  it('ONE RECIPIENT, TWO PROVENANCE CYCLES: the union is per cycle, not per recipient', async () => {
    // The `bool_or` in arm (4), exercised directly. The cross-CYCLE test above proves two separate
    // recipients are judged apart; this proves the harder half — a SINGLE recipient whose immutable
    // provenance names two sibling cycles is eligible while EITHER of them still has a free court,
    // and only stops being eligible when BOTH are held.
    //
    // A per-recipient short-circuit — "this recipient touches a held court, suppress" — passes
    // every other arm in this block and fails exactly here.
    const c = await freshDb();
    const { round, recipients } = await seedRound(c, 1);
    const second = await addProvenanceCycle(c, round, recipients[0].recipient, recipients[0].profile);
    expect(await eligible(c, round, recipients[0].recipient), 'CONTROL — neither cycle is held').toBe(true);

    await holdSlot(c, recipients[0].slot);
    expect(await eligible(c, round, recipients[0].recipient),
      'one provenance cycle is held; the OTHER still has a free court, so the invitation stands')
      .toBe(true);

    await holdSlot(c, second.slot);
    expect(await eligible(c, round, recipients[0].recipient),
      'now every court in every provenance cycle is held by a paid group').toBe(false);
  });

  it('DURABILITY: the hold SURVIVES the guest merge that deletes the claim', async () => {
    // THE DEFECT THIS RELEASE REPAIRS, reproduced with the shipped merge's own statement. Every
    // merge revision drops the source claim on a slot collision and REPOINTS the invoice, so a
    // claim-derived hold vanished on an ordinary merge while the payment and the booking survived.
    const c = await freshDb();
    const { round, recipients } = await seedRound(c, 1);
    await holdSlot(c, recipients[0].slot);
    expect(await eligible(c, round, recipients[0].recipient), 'held before the merge').toBe(false);

    // The merge's exact effect on this court: the claim is gone.
    await c.query(`DELETE FROM public.slot_priority_claims WHERE slot_id = $1`, [recipients[0].slot]);
    expect((await c.query(
      `SELECT count(*)::int n FROM public.slot_priority_claims WHERE slot_id = $1`,
      [recipients[0].slot])).rows[0].n, 'the claim really is deleted').toBe(0);

    expect(await eligible(c, round, recipients[0].recipient),
      'and the court is STILL held — the payment and the booking are what hold it').toBe(false);
  });

  it('STALE BLOCKS ARE GONE: a paid invoice with no paid booking never suppresses', async () => {
    // THE OTHER DIRECTION THE OWNER DIRECTED, and the one a durability-only test would miss. The
    // retired anchors — a claim carrying a `rebook_group_id`, and a `paid` invoice tagged to that
    // group — are built here in full and must now be INERT. A release must not be blocked by a
    // record that no longer represents a paid seat on this court.
    const c = await freshDb();
    const { round, recipients } = await seedRound(c, 1);
    const group = await attachGroup(c, recipients[0].claim);
    await invoiceFor(c, group, 'paid');
    // The retired shape is genuinely present…
    expect((await c.query(`
      SELECT count(*)::int n FROM public.slot_priority_claims spc
        JOIN public.invoices i ON i.rebook_group_id = spc.rebook_group_id
       WHERE spc.slot_id = $1 AND i.status = 'paid'`, [recipients[0].slot])).rows[0].n,
    'the retired claim+paid-invoice shape is fully built').toBe(1);
    // …and it holds nothing.
    expect(await eligible(c, round, recipients[0].recipient),
      'the retired claim/invoice anchor is inert — only a paid booking holds a court').toBe(true);
  });

  it('A CANCELLED paid-group booking never suppresses', async () => {
    const c = await freshDb();
    const { round, recipients } = await seedRound(c, 1);
    const booking = await holdSlot(c, recipients[0].slot);
    expect(await eligible(c, round, recipients[0].recipient), 'held while the booking is live').toBe(false);
    await c.query(`UPDATE public.bookings SET status='cancelled' WHERE id=$1`, [booking]);
    expect(await eligible(c, round, recipients[0].recipient),
      'a cancelled booking is not a hold — it must not block the release').toBe(true);
  });

  it('AN UNPAID booking never suppresses, whatever else is true of it', async () => {
    // `payment_status` is NOT NULL on `bookings`, so the arm below is the real closed set rather
    // than an invented one; a NULL cannot exist to be tested.
    for (const status of ['pending', 'failed']) {
      const c = await freshDb();
      const { round, recipients } = await seedRound(c, 1);
      const captain = (await c.query(`SELECT id FROM public.profiles LIMIT 1`)).rows[0].id;
      await c.query(`
        INSERT INTO public.bookings (slot_id, player_id, status, payment_status,
                                     paid_by_player_id, created_at, updated_at)
        VALUES ($1, $2, 'confirmed', $3, $2, now(), now())`,
      [recipients[0].slot, captain, status]);
      expect(await eligible(c, round, recipients[0].recipient),
        `payment_status '${status}' is not paid, so it holds nothing`).toBe(true);
    }
  });

  it('A SELF-PAID seat occupies a seat but does NOT hold the court', async () => {
    // `paid_by_*` is what makes a paid booking a GROUP hold: it is set only when somebody ELSE paid.
    // A member who paid for their own seat takes one seat — which the capacity arm handles — and
    // must not lock the remaining seats away from everyone.
    const c = await freshDb();
    const { round, recipients } = await seedRound(c, 1);
    await selfPaidBooking(c, recipients[0].slot);
    expect((await c.query(
      `SELECT count(*)::int n FROM public.bookings WHERE slot_id=$1 AND payment_status='paid'`,
      [recipients[0].slot])).rows[0].n, 'the paid booking really is there').toBe(1);
    expect(await eligible(c, round, recipients[0].recipient),
      'nobody else paid for it, so the court is not held').toBe(true);
  });

  it('THE LIVE SEND-TIME GATE USES THE REPLACEMENT, not only materialization', async () => {
    // The order here is the whole point, and it is the reverse of the end-to-end case below: the
    // round is materialized while the court is FREE, so a real queued transport row exists and is
    // claimable. The payment lands afterwards. Nothing re-materializes.
    //
    // If the closure had only reached the materializer, this row would sail through
    // `pre_dispatch_resolve` and be sent. It is the live pre-dispatch gate — the same authority,
    // re-read at resolve time through `abc27_a_live_eligible` — that has to catch it.
    const c = await freshDb();
    const { round, recipients } = await seedRound(c, 1);
    await materialize(c);
    const queued = await outboxOf(c, round);
    expect(queued, 'the round really did materialize a transport row while the court was free')
      .toHaveLength(1);
    expect(queued[0].transport_state, 'and it is claimable').toBe('queued');
    expect(await decisionsOf(c, round), 'with no terminal decision yet').toEqual([]);

    // …and only NOW does the group captain's invoice settle.
    await holdSlot(c, recipients[0].slot);

    const run = await runWorker(c, { token: 'late-payment-worker' });
    expect(run.summary.claimed, 'the worker does claim the already-queued row').toBe(1);
    expect(run.sends, 'and it sends NOTHING: the live gate re-read the hold').toHaveLength(0);
    expect(run.summary.authorized, 'no dispatch is ever authorized').toBe(0);
    expect(await decisionsOf(c, round), 'the recipient is terminally decided as ineligible')
      .toEqual(['ineligible']);
  });

  it('END TO END: a held deferred_split round decides `ineligible` and sends NOTHING', async () => {
    // The product consequence, through the real materializer and the real worker rather than
    // through the eligibility reader alone.
    const c = await freshDb();
    const { round, recipients } = await seedRound(c, 1);
    await holdSlot(c, recipients[0].slot);
    const mat = await materialize(c);
    expect(mat[0]).toMatchObject({ recipients_considered: 1, decisions_written: 1 });
    expect(await outboxOf(c, round), 'no transport row is created for a held court').toHaveLength(0);
    expect(await decisionsOf(c, round), 'the recipient is terminally, honestly decided')
      .toEqual(['ineligible']);
    const run = await runWorker(c, { token: 'held-court-worker' });
    expect(run.summary.claimed).toBe(0);
    expect(run.sends, 'and nothing whatsoever is sent').toHaveLength(0);
  });
});

// ── E-14 / LINEARIZATION: the durable begin_dispatch transaction decides ─────────────────────
//
// THE RACE THESE TESTS RUN IS THE REAL ONE. Nothing is stubbed: `claim_batch`,
// `pre_dispatch_resolve`, `begin_dispatch` and `record_dispatch_outcome` are the shipped functions,
// called by the shipped worker in the shipped order. The only thing injected is a COMMIT at a
// chosen instant — the `onRpc` seam — which is exactly what a group captain paying their invoice at
// an awkward moment looks like from this system's point of view.
//
// HOW THE INJECTED COMMIT IS MODELLED, STATED SO IT IS NOT MISTAKEN FOR SOMETHING ELSE. The payment
// is committed on the SAME connection the worker's RPCs use, in the gap between two of them, rather
// than from a second concurrent session. That is deliberate and it is the stronger choice for this
// property: what is under test is an ORDERING — "a payment that commits before `begin_dispatch`
// starts is seen by it" — and a same-session commit in the gap realises that ordering EXACTLY,
// every run. A genuinely concurrent session would realise it only sometimes, and a test that
// sometimes exercises the property it is named after is not evidence. Nothing about the ordering
// depends on the session: each RPC is its own auto-committed transaction, so by the time
// `begin_dispatch` opens, the payment is committed and visible to any snapshot taken afterwards —
// which is the same state a concurrent commit at that instant would leave behind.
//
// The two arms that matter are deliberately symmetric, and only the INSTANT differs:
//
//   • pay AFTER `pre_dispatch_resolve`, BEFORE `begin_dispatch` → the authorization is refused and
//     nothing is sent. This is what `20261203130000` bought.
//   • pay AFTER `begin_dispatch` has committed                  → the send happens. This is the
//     documented boundary, not a defect: an authorized email cannot be taken back.

/**
 * The complete durable footprint one outbox row can leave behind on the A side.
 *
 * `grants` counts SURVIVING transition rows, and a healthy transition leaves NONE: the grant is
 * single-use and `abc27_a_consume_transition_grant` DELETEs it in the same transaction that spends
 * it. So a non-zero count is a LEAK — standing authority nobody consumed — and it is the number a
 * refusal must not create. `operations` is the durable trace that a dispatch authorization really
 * happened, because operation rows are not deleted.
 */
const artifactsOf = async (
  c: pg.Client, outboxId: string, round: string,
): Promise<Record<string, unknown>> =>
  (await c.query(`
    SELECT (SELECT count(*)::int FROM public.rebook_round_transport_transitions t
              WHERE t.outbox_id = $1)                                              AS leaked_grants,
           (SELECT count(*)::int FROM public.rebook_round_operations op
             WHERE op.round_id = $2 AND op.purpose = 'dispatch_outcome')           AS dispatch_operations,
           o.first_dispatch_at, o.uncertainty_deadline_at, o.dispatch_authorized_generation,
           o.transport_transition_action, o.transport_transition_grant_id, o.transport_state
      FROM public.notification_outbox o WHERE o.id = $1`, [outboxId, round])).rows[0];

/** Seed a round, materialize it, and hand back the one queued transport row. */
async function queuedRound(c: pg.Client, opts: Parameters<typeof seedRound>[2] = {}) {
  const seeded = await seedRound(c, 1, opts);
  await materialize(c);
  const rows = await outboxOf(c, seeded.round);
  expect(rows, 'the fixture must produce exactly one queued transport row').toHaveLength(1);
  expect(rows[0].transport_state).toBe('queued');
  return { ...seeded, outboxId: rows[0].id as string };
}

describe('E-14 — the durable begin_dispatch transaction is the linearization point', () => {
  it('A PAYMENT LANDING BETWEEN RESOLVE AND BEGIN IS SEEN: nothing is sent, nothing is written', async () => {
    const c = await freshDb();
    const { round, recipients, outboxId } = await queuedRound(c);
    const clean = await artifactsOf(c, outboxId, round);
    expect(clean.leaked_grants, 'CONTROL — no grant is outstanding before the run').toBe(0);
    expect(clean.dispatch_operations, 'CONTROL — and no dispatch operation has happened').toBe(0);

    let paidAt: string | null = null;
    const run = await runWorker(c, {
      token: 'seam-worker',
      onRpc: async (name) => {
        // THE SEAM. The resolver has just answered `proceed` in its own committed transaction; the
        // worker has not yet called `begin_dispatch`. This is precisely the interval that used to
        // be invisible.
        if (name === 'rebook_member_open_pre_dispatch_resolve' && paidAt === null) {
          await holdSlot(c, recipients[0].slot);
          paidAt = 'resolved';
        }
      },
    });

    expect(paidAt, 'the injection must actually have fired').toBe('resolved');
    expect(run.summary.claimed, 'the row was claimed and resolved normally').toBe(1);
    expect(run.sends, 'ZERO provider calls — the whole point').toHaveLength(0);
    expect(run.summary.authorized, 'and no dispatch was ever authorized').toBe(0);
    expect(run.summary.refused, 'begin_dispatch refused the row').toBe(1);
    // The refusal names the fence, and it names it with this unit's own vocabulary.
    const refusal = run.logs.find((l) => l.event === 'rebook_member_open_worker_begin_refused');
    expect(refusal, 'the refusal is logged').toBeTruthy();
    expect(refusal!.refusal_reason).toBe('ineligible');

    // ── FULL ATOMIC ROLLBACK, READ FROM THE DATABASE ────────────────────────────────────────
    // A refusal must leave NO artifact: no operation, no target, no grant, and not one column of
    // the outbox row moved. A stray unconsumed grant would be standing authority for a transition
    // that was just judged inadmissible.
    const after = await artifactsOf(c, outboxId, round);
    expect({ ...after, transport_state: undefined }, 'the refusal wrote nothing at all')
      .toEqual({ ...clean, transport_state: undefined });
    expect(after.leaked_grants, 'no unconsumed grant is left behind').toBe(0);
    expect(after.dispatch_operations, 'and no dispatch operation was opened at all').toBe(0);
    expect(after.first_dispatch_at).toBeNull();
    expect(after.dispatch_authorized_generation).toBeNull();
    expect(after.transport_transition_grant_id).toBeNull();
    // The row keeps its lease rather than being dropped, so recovery returns it and the NEXT
    // resolve writes the honest terminal decision. A refusal defers judgement; it never discards.
    expect(after.transport_state, 'the row is still leased, awaiting recovery').toBe('leased');
    expect(await decisionsOf(c, round), 'and no terminal decision was invented here').toEqual([]);
  });

  it('…and the NEXT pass decides it honestly: recovered, re-resolved, terminally ineligible', async () => {
    // The refusal above is only safe if the row does not wedge. This is the continuation: the
    // janitor returns the lease to its exact stored origin and the resolver — which owns terminal
    // decisions — writes `ineligible`. No provider call happens on either pass.
    const c = await freshDb();
    const { round, recipients } = await queuedRound(c);
    const first = await runWorker(c, {
      token: 'seam-worker-1',
      onRpc: async (name) => {
        if (name === 'rebook_member_open_pre_dispatch_resolve') await holdSlot(c, recipients[0].slot);
      },
    });
    expect(first.sends).toHaveLength(0);

    // A ZERO FLOOR IS SANCTIONED BY THE MIGRATION ITSELF; it is how evidence ages a lease without
    // the direct UPDATE the unconditional outbox guard refuses.
    await runJanitor(c, 0);
    const second = await runWorker(c, { token: 'seam-worker-2' });
    expect(second.sends, 'still nothing is sent').toHaveLength(0);
    expect(await decisionsOf(c, round), 'and the resolver writes the honest terminal decision')
      .toEqual(['ineligible']);
  });

  it('CONTROL — the SAME injection with an UNPAID group sends normally', async () => {
    // Without this the test above proves only that injecting anything at that instant breaks the
    // send. The instant is identical; only the invoice status differs.
    const c = await freshDb();
    const { round, recipients, outboxId } = await queuedRound(c);
    const run = await runWorker(c, {
      token: 'unpaid-seam-worker',
      onRpc: async (name) => {
        if (name === 'rebook_member_open_pre_dispatch_resolve') {
          const group = await attachGroup(c, recipients[0].claim);
          await invoiceFor(c, group, 'sent');
        }
      },
    });
    expect(run.sends, 'an unpaid group holds nothing, so the send proceeds').toHaveLength(1);
    expect(run.summary.authorized).toBe(1);
    const done = await artifactsOf(c, outboxId, round);
    expect(done.dispatch_operations, 'and the authorization DID open its dispatch operation')
      .toBeGreaterThan(0);
    expect(done.leaked_grants, 'whose single-use grant was consumed, not left standing').toBe(0);
  });

  it('CONTROL — a FOREIGN TENANT paying in the seam changes nothing here', async () => {
    const c = await freshDb();
    const OTHER = '22222222-2222-4222-8222-222222222222';
    await c.query(`INSERT INTO public.academy_profiles(id,name) VALUES ($1,'other') ON CONFLICT DO NOTHING`,
      [OTHER]);
    const { round, outboxId } = await queuedRound(c);
    const foreignTrainer = (await c.query(
      `INSERT INTO public.trainer_profiles(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
    const foreignCycle = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','foreign','open',current_date) RETURNING id`, [OTHER])).rows[0].id;
    const lane = nextLane();
    const foreignSlot = (await c.query(`INSERT INTO public.availability_slots
      (id,trainer_id,academy_profile_id,source_cycle_id,start_time,end_time,max_participants,member_window_ends_at)
      VALUES (gen_random_uuid(),$1,$2,$3,now()+interval '2 days'+make_interval(hours => ${lane}),
              now()+interval '2 days 1 hour'+make_interval(hours => ${lane}),4,now()+interval '30 days')
      RETURNING id`, [foreignTrainer, OTHER, foreignCycle])).rows[0].id;
    const run = await runWorker(c, {
      token: 'foreign-seam-worker',
      onRpc: async (name) => {
        if (name === 'rebook_member_open_pre_dispatch_resolve') {
          await holdSlot(c, foreignSlot);
        }
      },
    });
    expect(run.sends, 'another academy\'s payment says nothing about this round').toHaveLength(1);
    expect((await artifactsOf(c, outboxId, round)).dispatch_operations).toBeGreaterThan(0);
  });

  it('CONTROL — MULTI-SLOT: paying for one court in the seam, while another is free, still sends', async () => {
    // The re-read is the same per-slot authority as everywhere else: it must not become a
    // round-wide kill switch just because it now runs later.
    const c = await freshDb();
    const seeded = await seedRound(c, 1);
    const spare = await addSlot(c, seeded.cycle);
    await materialize(c);
    const rows = await outboxOf(c, seeded.round);
    expect(rows).toHaveLength(1);
    const run = await runWorker(c, {
      token: 'multislot-seam-worker',
      onRpc: async (name) => {
        if (name === 'rebook_member_open_pre_dispatch_resolve') await holdSlot(c, seeded.recipients[0].slot);
      },
    });
    expect(run.sends, 'a genuinely free seat on an unheld court is still an invitation').toHaveLength(1);
    void spare;
  });

  it('A PAYMENT LANDING AFTER THE DURABLE DECISION DOES NOT UNDO IT — the documented boundary', async () => {
    // THIS TEST ASSERTS THE LIMIT, NOT A DEFECT. `begin_dispatch` has committed; the authorization
    // is durable and the provider call is the next thing that happens. A payment committing here is
    // not seen, the send goes out, and no code pretends it can be taken back. Recording it as a
    // passing expectation is how the boundary stays honest instead of drifting into a claim.
    const c = await freshDb();
    const { round, recipients, outboxId } = await queuedRound(c);
    const run = await runWorker(c, {
      token: 'post-decision-worker',
      onRpc: async (name) => {
        if (name === 'rebook_member_open_begin_dispatch') await holdSlot(c, recipients[0].slot);
      },
    });
    expect(run.sends, 'the authorization was already durable, so exactly one send happens')
      .toHaveLength(1);
    expect(run.summary.authorized).toBe(1);
    const after = await artifactsOf(c, outboxId, round);
    expect(after.dispatch_operations, 'and the dispatch operation exists, because it really happened')
      .toBeGreaterThan(0);
    expect(after.first_dispatch_at, 'with the immutable first-dispatch instant written').not.toBeNull();
    expect(await decisionsOf(c, round), 'and the send is recorded as accepted, not as ineligible')
      .toEqual(['dispatch_accepted']);
  });

  it('CONTROL — an UPFRONT round never reaches the transport at all', async () => {
    // The cycle-wide arm is retained and runs at materialization, so there is no row for the
    // linearization point to judge. Stated here so "the seam refused it" is never mistaken for the
    // reason an upfront round sends nothing.
    const c = await freshDb();
    const seeded = await seedRound(c, 1, { cycleSettings: { rebook_payment_mode: 'upfront' } });
    await materialize(c);
    expect(await outboxOf(c, seeded.round), 'no transport row is created at all').toHaveLength(0);
    const run = await runWorker(c, { token: 'upfront-worker' });
    expect(run.summary.claimed).toBe(0);
    expect(run.sends).toHaveLength(0);
  });

  it('THE MACHINE AUTHORITY DIRECTLY: resolve says proceed, the payment lands, begin refuses', async () => {
    // The same race without the worker in the picture, so the refusal is attributed to
    // `begin_dispatch` and to nothing in the TypeScript around it.
    const c = await freshDb();
    const { round, recipients, outboxId } = await queuedRound(c);
    await c.query('SET ROLE service_role');
    try {
      const claimed = (await c.query(
        `SELECT * FROM public.rebook_member_open_claim_batch($1,$2)`, ['direct-worker', 8])).rows;
      expect(claimed, 'exactly one row is claimable').toHaveLength(1);
      const row = claimed[0];
      const resolved = (await c.query(
        `SELECT * FROM public.rebook_member_open_pre_dispatch_resolve($1,$2,$3)`,
        [outboxId, 'direct-worker', row.lease_generation])).rows[0];
      expect(resolved.disposition, 'the resolver sees a live, eligible row').toBe('proceed');

      // …and NOW the captain pays, in a separate committed transaction.
      await c.query('RESET ROLE');
      await holdSlot(c, recipients[0].slot);
      await c.query('SET ROLE service_role');

      // THE WHOLE ROW, IMMEDIATELY BEFORE THE CALL. Here — and only here — the claim has already
      // happened and the resolve has already answered, so the ONLY thing between this snapshot and
      // the next is `begin_dispatch` itself. `to_jsonb(o)` is every column there is, so this is the
      // complete "wrote nothing" claim rather than the selected-columns version.
      const rowBefore = (await c.query(
        `SELECT to_jsonb(o) AS row FROM public.notification_outbox o WHERE o.id = $1`, [outboxId])
      ).rows[0].row;

      const begun = (await c.query(`
        SELECT * FROM public.rebook_member_open_begin_dispatch($1,$2,$3,$4,$5,$6,$7)`,
      [outboxId, 'direct-worker', row.lease_generation, row.request_hash,
        row.canonical_request_bytes, row.provider_idempotency_key, row.leased_from_state])).rows[0];
      expect(begun.outcome, 'the durable authorization refuses').toBe('refused');
      expect(begun.refusal_reason).toBe('ineligible');
      expect(begun.canonical_request_bytes, 'and hands back nothing sendable').toBeNull();
      expect(begun.provider_idempotency_key).toBeNull();
      expect((await c.query(
        `SELECT to_jsonb(o) AS row FROM public.notification_outbox o WHERE o.id = $1`, [outboxId])
      ).rows[0].row, 'and not one column of the outbox row moved').toEqual(rowBefore);
    } finally {
      await c.query('RESET ROLE').catch(() => undefined);
    }
    expect((await artifactsOf(c, outboxId, round)).dispatch_operations, 'no dispatch operation was opened')
      .toBe(0);
  });

  it('TWO SESSIONS: a payment committed AFTER the begin transaction starts is still seen', async () => {
    // THE PROPERTY THE WHOLE RELEASE RESTS ON, PROVED RATHER THAN REASONED. Every other arm commits
    // the payment BETWEEN two RPCs — which proves transaction-START visibility and nothing more. It
    // does not prove the thing the linearization actually depends on: that `begin_dispatch` is
    // VOLATILE, so under READ COMMITTED its INTERNAL statements take FRESH snapshots and therefore
    // see a commit that landed after this transaction was already open.
    //
    // The ordering is forced, not raced. Session 1 opens a transaction and takes a real transaction
    // id, so the transaction demonstrably exists first. Session 2 then commits the payment in its
    // own connection. Only then does session 1 call `begin_dispatch`. If its statements reused the
    // transaction's first snapshot, the payment would be invisible and the row would be authorized.
    const c = await freshDb();
    const dbName = (await c.query(`SELECT current_database() AS d`)).rows[0].d as string;
    const { recipients, outboxId } = await queuedRound(c);

    await c.query('SET ROLE service_role');
    const claimed = (await c.query(
      `SELECT * FROM public.rebook_member_open_claim_batch($1,$2)`, ['two-session', 8])).rows;
    expect(claimed).toHaveLength(1);
    const row = claimed[0];
    expect((await c.query(
      `SELECT * FROM public.rebook_member_open_pre_dispatch_resolve($1,$2,$3)`,
      [outboxId, 'two-session', row.lease_generation])).rows[0].disposition,
    'the resolver sees a live, eligible row').toBe('proceed');
    await c.query('RESET ROLE');

    // ── SESSION 1: open the transaction FIRST ────────────────────────────────────────────────
    await c.query('BEGIN');
    const txid = (await c.query(`SELECT pg_current_xact_id()::text AS x`)).rows[0].x;
    expect(txid, 'session 1 must hold a real transaction before the payment commits').toBeTruthy();
    expect((await c.query(`SHOW transaction_isolation`)).rows[0].transaction_isolation)
      .toBe('read committed');

    // ── SESSION 2: a genuinely separate connection commits the payment ───────────────────────
    const other = chain.connect(dbName);
    await other.connect();
    try {
      await other.query(`SELECT pg_current_xact_id()`);
      const captain = (await other.query(`SELECT id FROM public.profiles LIMIT 1`)).rows[0].id;
      await other.query(`
        INSERT INTO public.bookings (slot_id, player_id, status, payment_status, paid_at,
                                     paid_by_player_id, created_at, updated_at)
        VALUES ($1, $2, 'confirmed', 'paid', now(), $2, now(), now())`,
      [recipients[0].slot, captain]);
      // …and it is COMMITTED, not merely written — an uncommitted row would be invisible for an
      // entirely different and uninteresting reason.
      expect((await other.query(
        `SELECT count(*)::int n FROM public.bookings WHERE slot_id=$1 AND payment_status='paid'`,
        [recipients[0].slot])).rows[0].n).toBe(1);
    } finally {
      await other.end().catch(() => undefined);
    }

    // ── SESSION 1: the call, inside the transaction that opened BEFORE the payment ───────────
    try {
      await c.query('SET ROLE service_role');
      const begun = (await c.query(`
        SELECT * FROM public.rebook_member_open_begin_dispatch($1,$2,$3,$4,$5,$6,$7)`,
      [outboxId, 'two-session', row.lease_generation, row.request_hash,
        row.canonical_request_bytes, row.provider_idempotency_key, row.leased_from_state])).rows[0];
      expect(begun.outcome,
        'the re-read took a FRESH snapshot and saw a payment committed after this transaction opened')
        .toBe('refused');
      expect(begun.refusal_reason).toBe('ineligible');
    } finally {
      await c.query('RESET ROLE').catch(() => undefined);
      await c.query('ROLLBACK').catch(() => undefined);
    }
  });

  it('REFUSES OUTRIGHT under REPEATABLE READ, because the fresh snapshot it needs is gone', async () => {
    // THE CONTRACT IS "THE OBSERVATION IS FRESH", AND THAT IS A PROPERTY OF THE ISOLATION LEVEL.
    // Under READ COMMITTED each statement inside this VOLATILE function takes its own snapshot, so
    // the re-read sees a payment committed after the transaction began. Under REPEATABLE READ every
    // statement reuses the transaction's first snapshot and the re-read would faithfully report
    // eligibility as it stood BEFORE the payment — a stale answer that looks exactly like a fresh
    // one. The isolation level is AMBIENT (`ALTER ROLE … SET default_transaction_isolation`), so it
    // can be changed without touching this function, and it is therefore checked here.
    const c = await freshDb();
    const { recipients, outboxId } = await queuedRound(c);
    await c.query('SET ROLE service_role');
    const claimed = (await c.query(
      `SELECT * FROM public.rebook_member_open_claim_batch($1,$2)`, ['iso-worker', 8])).rows;
    expect(claimed).toHaveLength(1);
    const row = claimed[0];
    const resolved = (await c.query(
      `SELECT * FROM public.rebook_member_open_pre_dispatch_resolve($1,$2,$3)`,
      [outboxId, 'iso-worker', row.lease_generation])).rows[0];
    expect(resolved.disposition).toBe('proceed');
    await c.query('RESET ROLE');

    const begin = async (): Promise<Record<string, unknown>> => (await c.query(`
      SELECT * FROM public.rebook_member_open_begin_dispatch($1,$2,$3,$4,$5,$6,$7)`,
    [outboxId, 'iso-worker', row.lease_generation, row.request_hash,
      row.canonical_request_bytes, row.provider_idempotency_key, row.leased_from_state])).rows[0];

    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      const begun = await begin();
      expect(begun.outcome, 'a snapshot it cannot trust is refused, not served').toBe('refused');
      expect(begun.refusal_reason).toBe('unreadable_policy_state');
      expect(begun.canonical_request_bytes, 'and nothing sendable comes back').toBeNull();
    } finally {
      await c.query('ROLLBACK');
    }

    // CONTROL — the identical call in READ COMMITTED succeeds, so the refusal above is the
    // isolation level and not a broken fixture.
    const ok = await begin();
    expect(ok.outcome, 'READ COMMITTED authorizes normally').toBe('begun');
    expect(ok.canonical_request_bytes).not.toBeNull();
    void recipients;
  });

  it('the UNREADABLE input exists at the authority — but NOT reachable through begin_dispatch', async () => {
    // `abc27_a_live_eligible` is `SELECT eligible FROM rebook_round_eligible_recipients(round,
    // ARRAY[member])`, so an id the authority cannot speak for yields NULL rather than `false`.
    // `begin_dispatch` refuses that as `unreadable_policy_state` instead of coercing it — the same
    // fail-closed reading `pre_dispatch_resolve` takes.
    //
    // WHAT THIS TEST DOES AND DOES NOT SHOW. It shows the AUTHORITY can answer NULL. It does NOT
    // show that answer reaching `begin_dispatch`, and it must not be read as behavioural coverage
    // of that branch: the outbox insert validator refuses a row naming an unknown member and the
    // recipient snapshot refuses DELETE, so the arm is fail-closed defence in depth for a state the
    // product cannot currently produce. `d7ForwardChain.realpg.test.ts` measures both of those
    // refusals and pins the branch structurally; that is the whole of its coverage, stated.
    const c = await freshDb();
    const { round } = await queuedRound(c);
    const { rows } = await c.query(
      `SELECT public.abc27_a_live_eligible($1, gen_random_uuid()) AS answer`, [round]);
    expect(rows[0].answer, 'an unknown member is UNREADABLE, not ineligible').toBeNull();
  });
});

// ── E-15 · THE SELECTION AUTHORITY ───────────────────────────────────────────────────────────
//
// The typed preview authority refuses an empty `p_source_slot_ids` and pairs it POSITIONALLY with
// `p_child_cycle_ids`, so something has to decide which slots a selection means and which of them
// form one weekly group. That decision used to live in `bulk-rebook-cycle`, once per wizard;
// `20261203180000` moves it into ONE clusterer in the database, and `20261203190000` puts one
// actor-authorized surface in front of it.
//
// PARITY IS MEASURED AGAINST A PORT OF THE SHIPPED ALGORITHM, AND THE PORT IS PINNED. A test that
// compared the SQL against a hand-written idea of the legacy rule would prove only that the two
// agree with each other, so the reference below is transcribed from
// `supabase/functions/bulk-rebook-cycle/index.ts` and the exact lines it came from are asserted to
// still be there.
//
// PARITY IS MEASURED ON THE BRIDGE, NOT THROUGH THE WRAPPER. The wrapper deliberately never
// returns a slot array — that is the whole `CLIENT=NO_FINAL_SOURCE_SLOT_ARRAY` rule — so the
// derivation is compared by calling the Domain-P clusterer directly, which the suite can do as the
// database owner and no client role can do at all. The wrapper's own non-disclosure is a separate
// claim with its own tests below.

/** The shipped `seriesKey`, transcribed — the UTC identity the legacy function clustered on. */
function legacySeriesKey(s: { location_id: string | null; trainer_id: string | null; start_time: Date }): string {
  const d = new Date(s.start_time);
  const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return `${s.location_id ?? '_'}|${s.trainer_id ?? '_'}|${d.getUTCDay()}|${hhmm}`;
}

/** The shipped clustering: series → its slot ids, each series sorted by start. */
function legacySelection(
  slots: { id: string; location_id: string | null; trainer_id: string | null; start_time: Date }[],
  key: (s: { location_id: string | null; trainer_id: string | null; start_time: Date }) => string = legacySeriesKey,
): Map<string, string[]> {
  const bySeries = new Map<string, typeof slots>();
  for (const s of slots) {
    const arr = bySeries.get(key(s)) ?? [];
    arr.push(s);
    bySeries.set(key(s), arr);
  }
  const out = new Map<string, string[]>();
  for (const [k, arr] of bySeries) {
    out.set(k, [...arr]
      .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
      .map((s) => s.id));
  }
  return out;
}

describe('E-15 — one selection authority, two candidate modes', () => {
  const OTHER_ACADEMY = '22222222-2222-4222-8222-222222222222';

  // NO ACTOR AND NO ROUND UUID IN THIS DESCRIBE, deliberately. E-15 is about the DERIVATION, which
  // it measures by calling the Domain-P clusterer directly as the database owner — a call no client
  // role can make. The surface in front of it, and everything an actor changes about the answer, is
  // E-16's subject.
  interface SlotSpec { lane: number; week: number; loc?: string | null; trainer?: string; days?: number }

  /** A cyclus holding exactly the given slots, anchored to `academy`. */
  async function sourceCyclus(c: pg.Client, specs: SlotSpec[], academy = ACADEMY) {
    const cyc = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','E15 source','open',current_date) RETURNING id`,
      [academy])).rows[0].id;
    const made: string[] = [];
    for (const sp of specs) {
      made.push((await c.query(`INSERT INTO public.availability_slots
        (id,trainer_id,location_id,academy_profile_id,source_cycle_id,cyclus_id,start_time,end_time,
         max_participants,price_per_session,member_window_ends_at)
        VALUES (gen_random_uuid(),$1,$2,$3,$4,$4,
                date_trunc('hour', now()) + make_interval(hours => $5::int, days => $6::int),
                date_trunc('hour', now()) + make_interval(hours => $5::int + 1, days => $6::int),
                4, 20, now()+interval '120 days') RETURNING id`,
      [sp.trainer ?? TRAINER, sp.loc ?? null, academy, cyc, sp.lane, sp.days ?? sp.week * 7])).rows[0].id);
    }
    return { cyc, made };
  }

  const slotsOf = async (c: pg.Client, cyc: string) => (await c.query(`
    SELECT id::text AS id, location_id::text AS location_id, trainer_id::text AS trainer_id, start_time
      FROM public.availability_slots WHERE cyclus_id = $1`, [cyc])).rows;

  /**
   * The Domain-P clusterer, called directly. `qualifies AND NOT suppressed` is the qualifying set;
   * the caller decides what to do with `excluded`.
   */
  const cluster = async (
    c: pg.Client, cands: string[], mode: 'source_cycle' | 'cohort',
    opts: { termEnd?: string; round?: string; label?: string; excluded?: string[] } = {},
  ) => (await c.query(`
    SELECT * FROM public.d7_p_series_cluster($1,$2::uuid[],$3,$4::date,$5::uuid,$6,$7::text[])
     ORDER BY series_first, series_key, slot_start, slot_id`,
  [ACADEMY, cands, mode, opts.termEnd ?? null, opts.round ?? null, opts.label ?? null,
    opts.excluded ?? null])).rows;

  const candidatesOfCyclus = async (c: pg.Client, cyc: string | null): Promise<string[]> =>
    (await c.query(`SELECT public.d7_p_cyclus_candidates($1,$2) AS ids`, [ACADEMY, cyc])).rows[0].ids;

  /** The clusterer's grouping, as series → its ordered slot ids. */
  function grouping(rows: Record<string, unknown>[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const k = r.series_key as string;
      out.set(k, [...(out.get(k) ?? []), r.slot_id as string]);
    }
    return out;
  }
  const asMemberSets = (m: Map<string, string[]>) =>
    [...m.values()].map((v) => [...v].sort().join(',')).sort();

  it('THE PORT IS FAITHFUL: the shipped Edge function still carries the transcribed selection', () => {
    const src = readFileSync(
      join(process.cwd(), 'supabase', 'functions', 'bulk-rebook-cycle', 'index.ts'), 'utf8');
    for (const line of [
      // The key, and the comment that concedes exactly the DST split this release supersedes.
      'return `${s.location_id ?? "_"}|${s.trainer_id ?? "_"}|${d.getUTCDay()}|${hhmm}`;',
      'is stable within a term (a DST change mid-term could split a series; minor).',
      // Source-cycle mode: the whole cyclus, no term window and no status filter.
      '.eq("cyclus_id", sourceCyclusId);',
      // Cohort mode: academy + locations + a 200-day lookback to the term end.
      'const windowStart = new Date(termEnd.getTime() - 200 * DAY_MS); // generous term lookback',
      '.in("location_id", locationIds)',
      // Sorted by start…
      'const sorted = arr.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());',
      // …every series qualifies in cyclus mode, and the term-end week decides in cohort mode.
      'if (sourceCyclusId) {\n        qualifyingSeries.push(sorted);',
      'if (lastMs >= termEndWeekStart && lastMs <= termEndMs) qualifyingSeries.push(sorted);',
      // Extend suppression, by source cyclus and then by the name chain.
      'if (tmpl.cyclus_id) return !sentSourceIds.has(tmpl.cyclus_id);',
      'return ![...sentNames].some((n) => n === baseName || n.startsWith(`${baseName} ·`) || n.startsWith(`${baseName} #`));',
      'const nonDraft = rounds.filter((r) => r.status !== "draft");',
      'const allQualifyingSlotIds = qualifyingSeries.flat().map((s) => s.id);',
    ]) {
      expect(src, `a transcribed selection line is gone: ${line.slice(0, 56)}`).toContain(line);
    }
  });

  it('SOURCE-CYCLE MODE derives exactly the legacy set, grouped exactly the legacy way', async () => {
    const c = await freshDb();
    const loc = (await c.query(
      `INSERT INTO public.locations(name,city,slug) VALUES ('E15','Amsterdam','e15-'||gen_random_uuid())
       RETURNING id`)).rows[0].id;
    const trainer2 = (await c.query(
      `INSERT INTO public.trainer_profiles(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;

    // EVERY SHAPE THE KEY CAN DISCRIMINATE ON, IN ONE CYCLUS — parity that holds only on a
    // single-series fixture proves nothing about clustering. The location- and trainer-
    // discriminated pairs sit in DIFFERENT weeks: same trainer at the same instant would be
    // refused by `check_trainer_slot_overlap`, and a whole week leaves the identity untouched.
    const { cyc } = await sourceCyclus(c, [
      { lane: 1, week: 0 }, { lane: 1, week: 1 }, { lane: 1, week: 2 },
      { lane: 5, week: 0 },
      { lane: 9, week: 0, loc }, { lane: 9, week: 1, loc },
      { lane: 9, week: 2, loc: null },
      { lane: 13, week: 0 }, { lane: 13, week: 1, trainer: trainer2 },
    ]);

    const rows = await cluster(c, await candidatesOfCyclus(c, cyc), 'source_cycle');
    expect(rows.every((r) => r.qualifies), 'source-cycle mode qualifies every series').toBe(true);
    const legacy = legacySelection(await slotsOf(c, cyc));
    const derived = grouping(rows);

    // (1) THE SAME SLOTS, and (2) the same GROUPING — the half a set comparison cannot see.
    expect([...derived.values()].flat().sort()).toEqual([...legacy.values()].flat().sort());
    expect(asMemberSets(derived), 'the derived grouping must be the legacy series grouping')
      .toEqual(asMemberSets(legacy));
    // (3) …and the fixture really did discriminate, so (2) is not vacuous.
    expect(legacy.size, 'the fixture must produce six legacy series').toBe(6);
    expect(derived.size).toBe(6);
  });

  it('DST: one local recurring series stays ONE series, where the legacy key split it in two', async () => {
    // THE DEFECT THIS RELEASE FIXES, MEASURED RATHER THAN ARGUED. A weekly class at a fixed LOCAL
    // time is two different UTC times either side of a DST change, so the legacy key made it two
    // series — and ABC-27 derives each child's stored identity from the academy-LOCAL weekday and
    // time, so those two children would have carried the SAME `series_key` and the SAME
    // `target_name`, which the typed core refuses. One ordinary autumn cyclus, one unusable round.
    const c = await freshDb();
    await c.query(`UPDATE public.academy_profiles SET timezone='Europe/Amsterdam' WHERE id=$1`, [ACADEMY]);
    // Two sessions at 19:00 Amsterdam time, one in CEST and one in CET.
    const cyc = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','E15 dst','open',current_date) RETURNING id`,
      [ACADEMY])).rows[0].id;
    const mk = async (localDate: string) => (await c.query(`INSERT INTO public.availability_slots
      (id,trainer_id,academy_profile_id,cyclus_id,start_time,end_time,max_participants,price_per_session,member_window_ends_at)
      VALUES (gen_random_uuid(),$1,$2,$3,
              ($4::timestamp AT TIME ZONE 'Europe/Amsterdam'),
              ($4::timestamp AT TIME ZONE 'Europe/Amsterdam') + interval '1 hour',
              4, 20, now()+interval '400 days') RETURNING id`,
    [TRAINER, ACADEMY, cyc, `${localDate} 19:00:00`])).rows[0].id;
    const summer = await mk('2026-10-20');   // CEST — 17:00Z
    const winter = await mk('2026-10-27');   // CET  — 18:00Z

    const raw = await c.query(
      `SELECT id::text AS id, location_id::text AS location_id, trainer_id::text AS trainer_id, start_time
         FROM public.availability_slots WHERE cyclus_id=$1`, [cyc]);
    // The control: the LEGACY key really does split them, so the assertion below is about a real
    // difference and not about a fixture that never crossed anything.
    expect(legacySelection(raw.rows).size, 'the legacy UTC key splits this series in two').toBe(2);

    const derived = grouping(await cluster(c, await candidatesOfCyclus(c, cyc), 'source_cycle'));
    expect(derived.size, 'the academy-local identity keeps it as ONE series').toBe(1);
    expect([...derived.values()][0].sort()).toEqual([summer, winter].sort());
  });

  it('COHORT MODE keeps only series whose LAST session lands in the term-end week', async () => {
    const c = await freshDb();
    const loc = (await c.query(
      `INSERT INTO public.locations(name,city,slug) VALUES ('E15c','Utrecht','e15c-'||gen_random_uuid())
       RETURNING id`)).rows[0].id;
    const other = (await c.query(
      `INSERT INTO public.locations(name,city,slug) VALUES ('E15o','Breda','e15o-'||gen_random_uuid())
       RETURNING id`)).rows[0].id;
    const termEnd = (await c.query(`SELECT (current_date + 30)::text AS d`)).rows[0].d;

    const mk = async (location: string, lane: number, offsets: number[]) => {
      const ids: string[] = [];
      for (const off of offsets) {
        ids.push((await c.query(`INSERT INTO public.availability_slots
          (id,trainer_id,location_id,academy_profile_id,start_time,end_time,max_participants,price_per_session,member_window_ends_at)
          VALUES (gen_random_uuid(),$1,$2,$3,
                  ($4::date + $5::int) + make_interval(hours => $6::int),
                  ($4::date + $5::int) + make_interval(hours => $6::int + 1),
                  4, 20, now()+interval '200 days') RETURNING id`,
        [TRAINER, location, ACADEMY, termEnd, off, lane])).rows[0].id);
      }
      return ids;
    };
    // Ends ON the term end → in. Ends 3 days before → still inside the 6-day week → in.
    // Ends 10 days before → out. At another location → out.
    const inA = await mk(loc, 2, [-14, -7, 0]);
    const inB = await mk(loc, 6, [-10, -3]);
    const outC = await mk(loc, 10, [-24, -17, -10]);
    const outLoc = await mk(other, 14, [0]);

    const cands = (await c.query(`SELECT public.d7_p_cohort_candidates($1,$2::uuid[],$3::date) AS ids`,
      [ACADEMY, [loc], termEnd])).rows[0].ids as string[];
    expect(cands, 'another location is not even a candidate').not.toContain(outLoc[0]);

    const rows = await cluster(c, cands, 'cohort', { termEnd });
    const qualifying = grouping(rows.filter((r) => r.qualifies));
    expect(asMemberSets(qualifying)).toEqual(asMemberSets(new Map([
      ['a', inA], ['b', inB],
    ])));
    // …and the disqualified series is present-but-flagged, not absent: the clusterer reports, the
    // caller filters.
    expect(grouping(rows).size, 'every candidate series is reported').toBe(3);
    expect(rows.filter((r) => !r.qualifies).map((r) => r.slot_id).sort()).toEqual([...outC].sort());
  });

  it('COHORT MODE honours the 200-day lookback exactly', async () => {
    const c = await freshDb();
    const loc = (await c.query(
      `INSERT INTO public.locations(name,city,slug) VALUES ('E15w','Breda','e15w-'||gen_random_uuid())
       RETURNING id`)).rows[0].id;
    const termEnd = (await c.query(`SELECT (current_date + 30)::text AS d`)).rows[0].d;
    const at = async (offset: number) => (await c.query(`INSERT INTO public.availability_slots
      (id,trainer_id,location_id,academy_profile_id,start_time,end_time,max_participants,price_per_session,member_window_ends_at)
      VALUES (gen_random_uuid(),$1,$2,$3,
              (($4::date + time '23:59:59.999') AT TIME ZONE 'UTC') - make_interval(days => $5::int),
              (($4::date + time '23:59:59.999') AT TIME ZONE 'UTC') - make_interval(days => $5::int) + interval '1 hour',
              4, 20, now()+interval '400 days') RETURNING id`,
    [TRAINER, loc, ACADEMY, termEnd, offset])).rows[0].id;
    const inside = await at(199);
    const outside = await at(201);

    const cands = (await c.query(`SELECT public.d7_p_cohort_candidates($1,$2::uuid[],$3::date) AS ids`,
      [ACADEMY, [loc], termEnd])).rows[0].ids as string[];
    expect(cands, 'a slot 199 days before the term end is a candidate').toContain(inside);
    expect(cands, 'a slot 201 days before it is not').not.toContain(outside);
  });

  it('EXCLUDES another academy\'s slots that carry the same cyclus id', async () => {
    // `cyclus_id` has no foreign key and no tenant column of its own, and the bridges are SECURITY
    // DEFINER — RLS, which is what constrained the legacy fetch, does not apply to them. The
    // academy predicate is the only thing between a shared id and a cross-tenant slot.
    const c = await freshDb();
    const { cyc, made } = await sourceCyclus(c, [{ lane: 3, week: 0 }, { lane: 3, week: 1 }]);
    await c.query(`INSERT INTO public.academy_profiles(id,name) VALUES ($1,'other academy')
                   ON CONFLICT DO NOTHING`, [OTHER_ACADEMY]);
    const foreignTrainer = (await c.query(
      `INSERT INTO public.trainer_profiles(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
    const foreign = (await c.query(`INSERT INTO public.availability_slots
      (id,trainer_id,academy_profile_id,cyclus_id,start_time,end_time,max_participants,member_window_ends_at)
      VALUES (gen_random_uuid(),$1,$2,$3,date_trunc('hour',now())+interval '40 hours',
              date_trunc('hour',now())+interval '41 hours',4,now()+interval '120 days')
      RETURNING id`, [foreignTrainer, OTHER_ACADEMY, cyc])).rows[0].id;

    const cands = await candidatesOfCyclus(c, cyc);
    expect(cands, 'the foreign slot is not a candidate').not.toContain(foreign);
    expect([...cands].sort(), 'and every own slot is').toEqual([...made].sort());
  });
});

// ── E-16 · THE ONE ACTOR SURFACE ─────────────────────────────────────────────────────────────
//
// E-15 proves the derivation is the legacy one. This proves the surface in front of it: what an
// authorized manager gets, what an unauthorized caller cannot tell, what the browser is never
// handed, and that the review's numbers and its fingerprint came from ONE observation.

describe('E-16 — rebook_round_selection_preview_as_actor', () => {
  const E16_ROUND = '77777777-7777-4777-8777-777777777777';
  const OTHER_ACADEMY = '22222222-2222-4222-8222-222222222222';

  async function managerActor(c: pg.Client): Promise<string> {
    const user = (await c.query(`INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
    await c.query(`INSERT INTO public.academy_managers(academy_profile_id,user_id) VALUES ($1,$2)`,
      [ACADEMY, user]);
    return user;
  }

  /** A cyclus of `n` weekly sessions in one lane, each with `players` booked. */
  async function seedSeries(
    c: pg.Client, cyc: string | null, lane: number, weeks: number,
    opts: { players?: number; guests?: number; noEmail?: number; trainer?: string; academy?: string } = {},
  ) {
    const academy = opts.academy ?? ACADEMY;
    const cycle = cyc ?? (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','E16 source','open',current_date) RETURNING id`,
      [academy])).rows[0].id;
    const slots: string[] = [];
    for (let w = 0; w < weeks; w += 1) {
      slots.push((await c.query(`INSERT INTO public.availability_slots
        (id,trainer_id,academy_profile_id,source_cycle_id,cyclus_id,start_time,end_time,
         max_participants,price_per_session,prices_include_vat,split_payment,member_window_ends_at)
        VALUES (gen_random_uuid(),$1,$2,$3,$3,
                date_trunc('hour',now()) + make_interval(hours => $4::int, days => $5::int),
                date_trunc('hour',now()) + make_interval(hours => $4::int + 1, days => $5::int),
                4, 25, true, false, now()+interval '120 days') RETURNING id`,
      [opts.trainer ?? TRAINER, academy, cycle, lane, w * 7])).rows[0].id);
    }
    const people: { name: string; hasEmail: boolean }[] = [];
    for (let i = 0; i < (opts.players ?? 0); i += 1) {
      const withEmail = i >= (opts.noEmail ?? 0);
      const user = (await c.query(`INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
      const name = `Speler ${lane}-${i}`;
      const profile = (await c.query(
        `UPDATE public.profiles SET full_name=$2, email=$3 WHERE user_id=$1 RETURNING id`,
        [user, name, withEmail ? `p${lane}${i}@example.test` : null])).rows[0].id;
      for (const s of slots) {
        await c.query(`INSERT INTO public.bookings(slot_id,player_id,status) VALUES ($1,$2,'confirmed')`,
          [s, profile]);
      }
      people.push({ name, hasEmail: withEmail });
    }
    for (let i = 0; i < (opts.guests ?? 0); i += 1) {
      const name = `Gast ${lane}-${i}`;
      const guest = (await c.query(
        `INSERT INTO public.guest_players(trainer_id,full_name,email,phone)
         VALUES ($1,$2,$3,'0600') RETURNING id`, [opts.trainer ?? TRAINER, name, `g${lane}${i}@example.test`])).rows[0].id;
      const anchor = (await c.query(`SELECT id FROM public.profiles LIMIT 1`)).rows[0].id;
      for (const s of slots) {
        await c.query(`INSERT INTO public.bookings(slot_id,player_id,guest_player_id,status)
                       VALUES ($1,$2,$3,'confirmed')`, [s, anchor, guest]);
      }
      people.push({ name, hasEmail: true });
    }
    return { cycle, slots, people };
  }

  /** Call the surface as `authenticated`, in NAMED notation — how PostgREST invokes it. */
  const call = async (
    c: pg.Client, actor: string | null,
    o: {
      academy?: string; mode?: 'source_cycle' | 'cohort'; projection?: 'counts' | 'review';
      cycle?: string | null; locations?: string[] | null; termEnd?: string | null;
      excluded?: string[] | null; digest?: Buffer | null; round?: string | null;
      kind?: 'create' | 'extend'; expectedVersion?: number | null; label?: string;
      weeks?: number | null; end?: string | null; price?: number | null;
      targets?: string[] | null; contract?: string;
    } = {},
  ): Promise<Record<string, unknown>[]> => asActor(c, actor, async () => (await c.query(`
    SELECT * FROM public.rebook_round_selection_preview_as_actor(
      p_academy_profile_id   => $1,
      p_contract_version     => $2,
      p_command_kind         => $3,
      p_selection_mode       => $4,
      p_projection           => $5,
      p_source_cycle_id      => $6,
      p_location_ids         => $7::uuid[],
      p_term_end             => $8::date,
      p_excluded_series_keys => $9::text[],
      p_selection_digest     => $10::bytea,
      p_round_id             => $11,
      p_expected_version     => $12,
      p_label                => $13,
      p_target_start         => current_date + 30,
      p_target_end           => $14::date,
      p_term_weeks           => $15,
      p_priority_days        => 7,
      p_member_days          => 7,
      p_payment_mode         => 'deferred_split',
      p_strict_mollie        => false,
      p_public_open_mode     => 'inherit',
      p_public_open_split    => false,
      p_require_admin_review => false,
      p_session_price        => $16,
      p_auto_reminder        => false,
      p_reminder_lead_hours  => NULL,
      p_invitation_subject   => NULL,
      p_invitation_body      => NULL,
      p_reminder_subject     => NULL,
      p_reminder_body        => NULL,
      p_rebook_rules         => NULL,
      p_claim_info           => NULL,
      p_holiday_from         => ARRAY[]::date[],
      p_holiday_to           => ARRAY[]::date[],
      p_holiday_label        => ARRAY[]::text[],
      p_target_slot_ids      => coalesce($17::uuid[], ARRAY[]::uuid[]))`,
  [o.academy ?? ACADEMY, o.contract ?? 'abc27.wire.v1', o.kind ?? 'create',
    o.mode ?? 'source_cycle', o.projection ?? 'counts', o.cycle ?? null,
    o.locations ?? null, o.termEnd ?? null, o.excluded ?? null, o.digest ?? null,
    o.round === undefined ? E16_ROUND : o.round, o.expectedVersion ?? null,
    o.label ?? 'Volgende ronde 2026', o.end ?? null, o.weeks ?? 4, o.price ?? null,
    o.targets ?? null])).rows);

  const resultOf = (rows: Record<string, unknown>[]) => rows.find((r) => r.row_kind === 'result')!;
  const seriesOf = (rows: Record<string, unknown>[]) => rows.filter((r) => r.row_kind === 'series');
  const rosterOf = (rows: Record<string, unknown>[]) => rows.filter((r) => r.row_kind === 'roster');

  it('COUNTS answers the shape the typed core cannot: no length, no fingerprint, no roster', async () => {
    const c = await freshDb();
    const actor = await managerActor(c);
    const { cycle } = await seedSeries(c, null, 2, 3, { players: 2 });
    await seedSeries(c, cycle, 6, 2, { players: 3 });

    const rows = await call(c, actor, { cycle, projection: 'counts', weeks: null });
    const r = resultOf(rows);
    expect(r.status, 'a count is a count, never an approval').toBe('counted');
    expect(r.review_fingerprint, 'and it carries nothing that could arm a send').toBeNull();
    expect(r.apply_eligibility).toBeNull();
    expect(r.child_count).toBe(2);
    expect(r.cohort_total, 'five distinct people across two series').toBe(5);
    expect(Buffer.isBuffer(r.selection_digest), 'it does carry the selection digest').toBe(true);
    expect(seriesOf(rows), 'one row per series').toHaveLength(2);
    expect(rosterOf(rows), 'counts never returns a roster').toHaveLength(0);
    expect(seriesOf(rows).every((s) => s.sessions === null), 'and no session count, because no length was chosen').toBe(true);
  });

  it('REVIEW returns the verdict, the fingerprint and the projection from ONE observation', async () => {
    const c = await freshDb();
    const actor = await managerActor(c);
    const { cycle } = await seedSeries(c, null, 3, 2, { players: 2, noEmail: 1 });

    // The probe → mint → review dance the driver already performs: the core reports the occurrence
    // count against an empty identity pool, then the caller mints exactly that many.
    const probe = resultOf(await call(c, actor, { cycle, projection: 'review' }));
    expect(probe.status, 'an empty target pool is refused, and says how many are needed').toBe('invalid_request');
    const n = probe.occurrence_count as number;
    expect(n, 'four term weeks over one series').toBe(4);
    const targets = (await c.query(
      `SELECT array_agg(gen_random_uuid()) AS ids FROM generate_series(1,$1::int)`, [n])).rows[0].ids;

    // REVIEW ROUND 4 (P1): AN ARMABLE REVIEW MUST ECHO THE PROBE'S DIGEST. Minted targets are what
    // turn a review into send authority, and this call could previously be made with no digest at
    // all — leaving nothing to fence a court repriced between the projection read and the core's.
    expect(resultOf(await call(c, actor, { cycle, projection: 'review', targets })).status,
      'targets without a digest arm nothing').toBe('refused');

    const rows = await call(c, actor, {
      cycle, projection: 'review', targets, digest: probe.selection_digest as Buffer });
    const r = resultOf(rows);
    expect(r.status).toBe('previewed');
    expect(Buffer.isBuffer(r.review_fingerprint), 'the review is fingerprinted').toBe(true);
    const s = seriesOf(rows);
    expect(s).toHaveLength(1);
    expect(s[0].sessions, 'the session count is the generator\'s, not an estimate').toBe(4);
    expect(Number(s[0].invoice_total), 'P × S at the source court price').toBe(100);
    expect(Number(r.grand_invoice_total)).toBe(100);
    expect(s[0].no_email_count, 'one of the two players has no address').toBe(1);
    expect(r.no_email_total).toBe(1);
    expect(r.total_sessions, 'sessions × people, as the legacy total is').toBe(8);
    // The roster is names and a boolean — never an address.
    const roster = rosterOf(rows);
    expect(roster).toHaveLength(2);
    expect([...roster].map((x) => x.display_name).sort()).toEqual(['Speler 3-0', 'Speler 3-1']);
    expect(roster.filter((x) => x.has_email === false)).toHaveLength(1);
  });

  it('NEVER RETURNS A SOURCE SLOT ID, in any projection', async () => {
    // `CLIENT=NO_FINAL_SOURCE_SLOT_ARRAY`. The surface has no column that could carry one, and
    // this asserts the stronger property: no VALUE it returns is a source slot id either.
    const c = await freshDb();
    const actor = await managerActor(c);
    const { cycle, slots } = await seedSeries(c, null, 4, 2, { players: 1 });
    for (const projection of ['counts', 'review'] as const) {
      const rows = await call(c, actor, { cycle, projection });
      const flat = JSON.stringify(rows);
      for (const id of slots) {
        expect(flat, `${projection} must not disclose slot ${id}`).not.toContain(id);
      }
    }
  });

  it('REFUSES BEFORE IT RESOLVES ANYTHING: every failure is the SAME closed row', async () => {
    const c = await freshDb();
    const actor = await managerActor(c);
    const stranger = (await c.query(
      `INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
    const { cycle } = await seedSeries(c, null, 5, 1, { players: 1 });
    await c.query(`INSERT INTO public.academy_profiles(id,name) VALUES ($1,'other academy')
                   ON CONFLICT DO NOTHING`, [OTHER_ACADEMY]);

    const shape = (rows: Record<string, unknown>[]) => {
      expect(rows, 'a refusal is exactly one row').toHaveLength(1);
      const r = rows[0];
      return {
        kind: r.row_kind, status: r.status, fp: r.review_fingerprint,
        digest: r.selection_digest, children: r.child_count, series: r.series_key,
      };
    };
    const refusals = {
      'no actor at all': shape(await call(c, null, { cycle })),
      'authenticated, not a manager': shape(await call(c, stranger, { cycle })),
      'a manager of some other academy': shape(await call(c, actor, { academy: OTHER_ACADEMY, cycle })),
      'an unknown contract version': shape(await call(c, actor, { cycle, contract: 'abc27.wire.v2' })),
      'a selection mode outside the vocabulary':
        shape(await call(c, actor, { cycle, mode: 'anything' as 'cohort' })),
      'a projection outside the vocabulary':
        shape(await call(c, actor, { cycle, projection: 'everything' as 'counts' })),
    };
    const closed = {
      kind: 'result', status: 'refused', fp: null, digest: null, children: null, series: null,
    };
    for (const [why, row] of Object.entries(refusals)) {
      expect(row, `every refusal is the SAME closed row — ${why}`).toEqual(closed);
    }
    // …and an authorized call is genuinely different, so the comparison is not vacuous.
    expect(resultOf(await call(c, actor, { cycle })).status).toBe('counted');
  });

  it('A CYCLE THAT DOES NOT EXIST, ONE OWNED ELSEWHERE AND AN EMPTY ONE ARE INDISTINGUISHABLE', async () => {
    // These are NOT refusals — they are empty selections, and that is the stronger property: the
    // surface never resolves the cycle before authorizing, so there is no branch that could tell
    // an authorized manager whether somebody else's cycle exists.
    const c = await freshDb();
    const actor = await managerActor(c);
    await c.query(`INSERT INTO public.academy_profiles(id,name) VALUES ($1,'other academy')
                   ON CONFLICT DO NOTHING`, [OTHER_ACADEMY]);
    const foreign = (await seedSeries(c, null, 7, 2, { players: 2, academy: OTHER_ACADEMY })).cycle;
    const empty = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','E16 empty','open',current_date) RETURNING id`,
      [ACADEMY])).rows[0].id;

    const shape = (rows: Record<string, unknown>[]) => {
      const r = resultOf(rows);
      return { status: r.status, children: r.child_count, sources: r.source_count,
        digest: (r.selection_digest as Buffer).toString('hex'), series: seriesOf(rows).length };
    };
    const a = shape(await call(c, actor, { cycle: '00000000-0000-4000-8000-000000000000' }));
    const b = shape(await call(c, actor, { cycle: foreign }));
    const d = shape(await call(c, actor, { cycle: empty }));
    expect(b, 'a foreign cycle is the same empty answer as an unknown one').toEqual(a);
    expect(d, 'and so is an empty one of the manager\'s own').toEqual(a);
    expect(a.children).toBe(0);
  });

  it('THE SELECTION DIGEST FENCES A STALE EXCLUSION INTENT', async () => {
    const c = await freshDb();
    const actor = await managerActor(c);
    const { cycle } = await seedSeries(c, null, 8, 2, { players: 1 });
    const first = resultOf(await call(c, actor, { cycle }));
    const digest = first.selection_digest as Buffer;

    // Echoing the digest it was issued is accepted.
    expect(resultOf(await call(c, actor, { cycle, digest })).status).toBe('counted');

    // The source moves — a new session joins the cyclus — and the same digest is now stale.
    await c.query(`INSERT INTO public.availability_slots
      (id,trainer_id,academy_profile_id,source_cycle_id,cyclus_id,start_time,end_time,
       max_participants,price_per_session,member_window_ends_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$3,
              date_trunc('hour',now()) + interval '8 hours' + interval '14 days',
              date_trunc('hour',now()) + interval '9 hours' + interval '14 days',
              4, 25, now()+interval '120 days')`, [TRAINER, ACADEMY, cycle]);
    const stale = resultOf(await call(c, actor, { cycle, digest }));
    expect(stale.status, 'a selection the operator has not seen is refused, not silently used')
      .toBe('selection_moved');
    expect(stale.selection_digest, 'and the refusal discloses nothing about what moved').toBeNull();
    // Without the echo, the new selection is simply answered.
    expect(resultOf(await call(c, actor, { cycle })).status).toBe('counted');
  });

  it('EXCLUSION removes a series from the round and leaves it on the checklist', async () => {
    const c = await freshDb();
    const actor = await managerActor(c);
    const { cycle } = await seedSeries(c, null, 9, 2, { players: 2 });
    await seedSeries(c, cycle, 13, 2, { players: 3 });

    const before = await call(c, actor, { cycle });
    expect(resultOf(before).child_count).toBe(2);
    expect(resultOf(before).cohort_total).toBe(5);
    const drop = seriesOf(before).find((s) => (s.subject_count as number) === 3)!.series_key as string;

    const after = await call(c, actor, { cycle, excluded: [drop] });
    expect(resultOf(after).cohort_total, 'the excluded series\' people are no longer counted').toBe(2);
    // The series is still REPORTED — the operator has to be able to put it back.
    const rows = seriesOf(after);
    expect(rows, 'every qualifying series stays on the checklist').toHaveLength(2);
    expect(rows.find((s) => s.series_key === drop)!.series_excluded).toBe(true);
    expect(rows.filter((s) => s.series_excluded === false)).toHaveLength(1);
    // …and the digest is unchanged, because exclusion is the caller's intent and not a move of
    // the selection it was issued from.
    expect((resultOf(after).selection_digest as Buffer).toString('hex'))
      .toBe((resultOf(before).selection_digest as Buffer).toString('hex'));
  });

  it('IS REACHABLE BY authenticated AND BY NOBODY ELSE', async () => {
    const c = await freshDb();
    const sql = `SELECT * FROM public.rebook_round_selection_preview_as_actor(
      $1,'abc27.wire.v1','create','source_cycle','counts',$1,NULL,NULL,NULL,NULL,$1,NULL,'x',
      current_date,NULL,1,7,7,'deferred_split',false,'inherit',false,false,NULL,false,NULL,
      NULL,NULL,NULL,NULL,NULL,NULL,ARRAY[]::date[],ARRAY[]::date[],ARRAY[]::text[],ARRAY[]::uuid[])`;
    for (const role of ['anon', 'service_role']) {
      await c.query(`SET ROLE ${role}`);
      await expect(c.query(sql, [ACADEMY]), `${role} must be denied`)
        .rejects.toMatchObject({ code: '42501' });
      await c.query('RESET ROLE');
    }
    // The control: the SAME statement is permitted for `authenticated`, so the denials are about
    // privilege and not about the statement being malformed.
    await c.query('SET ROLE authenticated');
    await expect(c.query(sql, [ACADEMY])).resolves.toBeTruthy();
    await c.query('RESET ROLE');

    // …and every Domain-P bridge behind it is reachable by NO client role at all.
    for (const fn of [
      'd7_p_series_cluster', 'd7_p_cyclus_candidates', 'd7_p_cohort_candidates',
      'd7_p_subject_display', 'd7_p_display_names', 'd7_p_round_taken_names',
      'd7_p_round_label', 'd7_p_academy_timezone',
    ]) {
      const { rows } = await c.query(`
        SELECT bool_or(pg_catalog.has_function_privilege(r.role, p.oid, 'EXECUTE')) AS reachable
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) AS r(role)
         WHERE n.nspname = 'public' AND p.proname = $1`, [fn]);
      expect(rows[0].reachable, `${fn} must be unreachable by every client role`).toBe(false);
    }
  });
});

// ── E-17 · THE CHILD NAMES ───────────────────────────────────────────────────────────────────
//
// `CYCLE_NAMES=SERVER_DERIVE_HUMAN_READABLE_LEGACY_COMPATIBLE_DISAMBIGUATED_CHILD_NAMES` and
// `CLIENT_NAMES=NO_BROWSER_SUPPLIED_OR_UUID_VISIBLE_CHILD_CYCLE_NAMES`.
//
// ABC-27's own child name is `label · HH24:MI:SS.US · weekday · <location uuid> · <trainer uuid>`,
// unique by construction and unreadable by a human. It stays the STORED series identity — it is
// bound into the reviewed fingerprint and this release does not touch it — while the name a
// product cycle carries is rendered by the legacy chain instead.

describe('E-17 — the legacy naming chain, in the database', () => {
  const names = async (
    c: pg.Client, label: string,
    series: { w: number; t: string; trainer?: string | null; loc?: string | null }[],
    taken: string[] = [],
  ): Promise<string[]> => (await c.query(
    `SELECT public.d7_child_target_names($1,$2::text[],$3::int[],$4::time[],$5::text[],$6::text[],$7::text[]) AS n`,
    [label, series.map((_, i) => `k${i}`), series.map((s) => s.w), series.map((s) => s.t),
      series.map((s) => s.trainer ?? null), series.map((s) => s.loc ?? null), taken],
  )).rows[0].n;

  it('THE PORT IS FAITHFUL: the shipped naming chain still carries the transcribed tiers', () => {
    const src = readFileSync(
      join(process.cwd(), 'supabase', 'functions', '_shared', 'rebook-target-naming.ts'), 'utf8');
    for (const line of [
      'if (series.length === 1 && taken.size === 0) {',
      'const base = series.map((s) => ({ s, name: `${roundName} — ${seriesLabel(s.startIso, tz)}` }));',
      'const colliding = (dup: Map<string, number>, name: string) => (dup.get(name) ?? 0) > 1 || taken.has(name);',
      '? { s: e.s, name: `${e.name} · ${e.s.trainerName}` }',
      '? { s: e.s, name: `${e.name} · ${e.s.locationName}` }',
      'let candidate = n === 1 ? e.name : `${e.name} #${n}`;',
      'while (taken.has(candidate)) {',
    ]) {
      expect(src, `a transcribed naming line is gone: ${line.slice(0, 56)}`).toContain(line);
    }
  });

  it('TIER 0 — a single series with nothing taken keeps the round name VERBATIM', async () => {
    const c = await freshDb();
    expect(await names(c, 'Volgende ronde 2026', [{ w: 3, t: '09:00' }]))
      .toEqual(['Volgende ronde 2026']);
    // …and the moment the round already holds a name, even one series is labelled — the verbatim
    // shortcut would reuse a bare name the original multi-series run never used.
    expect(await names(c, 'Ronde 3', [{ w: 3, t: '09:00' }], ['Ronde 3']))
      .toEqual(['Ronde 3 — Wo 09:00']);
  });

  it('TIER 1 — two series are told apart by their own day and time, in Dutch', async () => {
    const c = await freshDb();
    expect(await names(c, 'Ronde', [{ w: 2, t: '19:00' }, { w: 4, t: '10:30' }]))
      .toEqual(['Ronde — Di 19:00', 'Ronde — Do 10:30']);
    // Every weekday, so the mapping is asserted rather than sampled — this is a CASE, not a
    // locale lookup, because the cluster runs with LC_TIME=C and `to_char(…,'TMDy')` would render
    // English here and something else elsewhere.
    const all = await names(c, 'R', [0, 1, 2, 3, 4, 5, 6].map((w) => ({ w, t: '08:00' })));
    expect(all).toEqual(['R — Zo 08:00', 'R — Ma 08:00', 'R — Di 08:00', 'R — Wo 08:00',
      'R — Do 08:00', 'R — Vr 08:00', 'R — Za 08:00']);
  });

  it('TIERS 2, 3 AND 4 — trainer, then location, then a number', async () => {
    const c = await freshDb();
    // Same day and time, two trainers → the trainer's FIRST name.
    expect(await names(c, 'Ronde', [
      { w: 2, t: '19:00', trainer: 'Sanne' }, { w: 2, t: '19:00', trainer: 'Bram' }]))
      .toEqual(['Ronde — Di 19:00 · Sanne', 'Ronde — Di 19:00 · Bram']);
    // Same trainer too → the location.
    expect(await names(c, 'Ronde', [
      { w: 2, t: '19:00', trainer: 'Sanne', loc: 'Noord' },
      { w: 2, t: '19:00', trainer: 'Sanne', loc: 'Zuid' }]))
      .toEqual(['Ronde — Di 19:00 · Sanne · Noord', 'Ronde — Di 19:00 · Sanne · Zuid']);
    // Nothing left to tell them apart → the first keeps the base, the second is numbered.
    expect(await names(c, 'Ronde', [{ w: 2, t: '19:00' }, { w: 2, t: '19:00' }]))
      .toEqual(['Ronde — Di 19:00', 'Ronde — Di 19:00 #2']);
  });

  it('TIER 4 skips suffixes the round already occupies', async () => {
    const c = await freshDb();
    expect(await names(c, 'Ronde',
      [{ w: 2, t: '19:00' }, { w: 2, t: '19:00' }],
      ['Ronde — Di 19:00', 'Ronde — Di 19:00 #2', 'Ronde — Di 19:00 #3']))
      .toEqual(['Ronde — Di 19:00 #4', 'Ronde — Di 19:00 #5']);
  });

  it('TIER 4 does not collide with a FUTURE tier-3 name — the A,A,B case', async () => {
    // THE RECOVERED ROUND-2 FINDING, reproduced exactly rather than approximated:
    //
    //   "For ordered tier-3 names A,A,B, where B = left(A,297) || ' #2', the output is A,B,B: the
    //    second A cannot see future B, and B has count one so is never rewritten."
    //
    // `v_dup` is fixed before the loop and `v_emit` holds only earlier decisions, so both sets look
    // BACKWARDS. B is ahead of the second A, in neither set, and unique — so it is never moved out
    // of the way either. The frozen distinct-name verdict then refuses a perfectly legal cohort as
    // `invalid_request` while `#3` was free the whole time.
    //
    // The arithmetic that makes it legal, from the finding: a 200-character label, Wednesday 09:00
    // and trainer `T` give a 218-character prefix (`label` + ` — ` + `Wo 09:00` + ` · ` + `T` + ` · `),
    // so an 82-character location makes each tier-3 name exactly 300 — the persisted cap. Two
    // identical 82-character locations collide; the third, `A`×79 + ` #2`, is exactly what tier 4
    // would generate for them.
    //
    // The existing `A,A,B,B` test cannot catch this: there B collides too, so it is rewritten and
    // moves out of the way by accident.
    const c = await freshDb();
    const label = 'L'.repeat(200);
    const out = await names(c, label, [
      { w: 3, t: '09:00', trainer: 'T', loc: 'A'.repeat(82) },
      { w: 3, t: '09:00', trainer: 'T', loc: 'A'.repeat(82) },
      { w: 3, t: '09:00', trainer: 'T', loc: `${'A'.repeat(79)} #2` },
    ]);

    // THE PROPERTY, FIRST. This is what the frozen core actually checks, and it is the assertion
    // that would have failed before the fix.
    expect(new Set(out).size, `tier 4 produced a duplicate: ${JSON.stringify(out)}`).toBe(3);

    // AND THE SHAPE, so a future change cannot satisfy distinctness some other way. The second
    // occurrence must skip ` #2` — which the third name already owns — and land on ` #3`.
    const [first, second, third] = out;
    expect(first).toBe(`${label} — Wo 09:00 · T · ${'A'.repeat(82)}`);
    expect(third).toBe(`${label} — Wo 09:00 · T · ${'A'.repeat(79)} #2`);
    expect(second).toBe(`${label} — Wo 09:00 · T · ${'A'.repeat(79)} #3`);
    // Still within the persisted cap, which is the whole reason the base is cut before the suffix.
    for (const n of out) expect(n.length).toBeLessThanOrEqual(300);
  });

  it('NO UUID REACHES A NAME, on any tier', async () => {
    // The property `CLIENT_NAMES` is really about: whatever the chain does, the operator never
    // sees an identifier. Every tier is exercised in one call and the whole result is checked.
    const c = await freshDb();
    const out = await names(c, 'Ronde', [
      { w: 1, t: '09:00' },
      { w: 2, t: '19:00', trainer: 'Sanne' }, { w: 2, t: '19:00', trainer: 'Bram' },
      { w: 3, t: '20:00', trainer: 'Kim', loc: 'Noord' },
      { w: 3, t: '20:00', trainer: 'Kim', loc: 'Zuid' },
      { w: 4, t: '21:00' }, { w: 4, t: '21:00' },
    ]);
    expect(new Set(out).size, 'every name is distinct').toBe(out.length);
    for (const n of out) {
      expect(n, `a uuid reached a name: ${n}`)
        .not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    }
  });

  it('THE SURFACE RENDERS THE SAME NAMES the operator will get', async () => {
    const c = await freshDb();
    const user = (await c.query(`INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
    await c.query(`INSERT INTO public.academy_managers(academy_profile_id,user_id) VALUES ($1,$2)`, [ACADEMY, user]);
    await c.query(`UPDATE public.profiles SET full_name='Sanne de Vries' WHERE user_id=$1`, [user]);
    const trainer2 = (await c.query(
      `INSERT INTO public.trainer_profiles(id,user_id) VALUES (gen_random_uuid(),$1) RETURNING id`, [user])).rows[0].id;

    const cyc = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','E17','open',current_date) RETURNING id`, [ACADEMY])).rows[0].id;
    for (const [trainer, lane] of [[TRAINER, 2], [trainer2, 6]] as const) {
      await c.query(`INSERT INTO public.availability_slots
        (id,trainer_id,academy_profile_id,source_cycle_id,cyclus_id,start_time,end_time,
         max_participants,price_per_session,member_window_ends_at)
        VALUES (gen_random_uuid(),$1,$2,$3,$3,
                date_trunc('hour',now()) + make_interval(hours => $4::int),
                date_trunc('hour',now()) + make_interval(hours => $4::int + 1),
                4, 25, now()+interval '120 days')`, [trainer, ACADEMY, cyc, lane]);
    }
    const rows = await asActor(c, user, async () => (await c.query(`
      SELECT row_kind, series_key, target_name
        FROM public.rebook_round_selection_preview_as_actor(
          $1,'abc27.wire.v1','create','source_cycle','counts',$2,NULL,NULL,NULL,NULL,
          '77777777-7777-4777-8777-777777777777',NULL,'Volgende ronde 2026',
          current_date + 30,NULL,4,7,7,'deferred_split',false,'inherit',false,false,NULL,false,
          NULL,NULL,NULL,NULL,NULL,NULL,NULL,ARRAY[]::date[],ARRAY[]::date[],ARRAY[]::text[],
          ARRAY[]::uuid[])`, [ACADEMY, cyc])).rows);
    const series = rows.filter((r) => r.row_kind === 'series');
    expect(series).toHaveLength(2);
    for (const s of series) {
      expect(String(s.target_name), 'a human name, never an identifier')
        .toMatch(/^Volgende ronde 2026 — [A-Z][a-z] \d{2}:\d{2}$/);
    }
  });
});

// ── E-18 · END TO END, WITHOUT THE BROWSER EVER HOLDING A SOURCE SLOT ────────────────────────
//
// The whole point of the cutover, proved as one run: an operator selects, reviews, applies, and
// the round that appears carries human names, real slots and real claims — while the only things
// the browser ever sent were a cycle id, an exclusion intent, a digest and the identities the
// protocol asks it to mint.

describe('E-18 — selection → review → apply', () => {
  const ROUND = '66666666-6666-4666-8666-666666666666';

  async function manager(c: pg.Client): Promise<string> {
    const user = (await c.query(`INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
    await c.query(`INSERT INTO public.academy_managers(academy_profile_id,user_id) VALUES ($1,$2)`,
      [ACADEMY, user]);
    return user;
  }

  async function twoSeriesCyclus(c: pg.Client) {
    const cyc = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','E18 source','open',current_date) RETURNING id`,
      [ACADEMY])).rows[0].id;
    for (const lane of [2, 6]) {
      for (let w = 0; w < 2; w += 1) {
        const slot = (await c.query(`INSERT INTO public.availability_slots
          (id,trainer_id,academy_profile_id,source_cycle_id,cyclus_id,start_time,end_time,
           max_participants,price_per_session,member_window_ends_at)
          VALUES (gen_random_uuid(),$1,$2,$3,$3,
                  date_trunc('hour',now()) + make_interval(hours => $4::int, days => $5::int),
                  date_trunc('hour',now()) + make_interval(hours => $4::int + 1, days => $5::int),
                  4, 30, now()+interval '120 days') RETURNING id`,
        [TRAINER, ACADEMY, cyc, lane, w * 7])).rows[0].id;
        const user = (await c.query(`INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
        const profile = (await c.query(
          `UPDATE public.profiles SET full_name=$2, email=$3 WHERE user_id=$1 RETURNING id`,
          [user, `Speler ${lane}-${w}`, `s${lane}${w}@example.test`])).rows[0].id;
        await c.query(`INSERT INTO public.bookings(slot_id,player_id,status) VALUES ($1,$2,'confirmed')`,
          [slot, profile]);
      }
    }
    return cyc;
  }

  const preview = (c: pg.Client, actor: string, cyc: string, projection: string,
    targets: string[] | null, digest: Buffer | null) => asActor(c, actor, async () => (await c.query(`
      SELECT * FROM public.rebook_round_selection_preview_as_actor(
        $1,'abc27.wire.v1','create','source_cycle',$2,$3,NULL,NULL,NULL,$4::bytea,$5,NULL,
        'Volgende ronde 2026', current_date + 30, NULL, 4, 7, 7, 'deferred_split', false,
        'inherit', false, false, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ARRAY[]::date[], ARRAY[]::date[], ARRAY[]::text[], coalesce($6::uuid[], ARRAY[]::uuid[]))`,
  [ACADEMY, projection, cyc, digest, ROUND, targets])).rows);

  it('APPLIES a round the browser could not have described, and names it in Dutch', async () => {
    const c = await freshDb();
    const actor = await manager(c);
    const cyc = await twoSeriesCyclus(c);

    // 1. COUNT — the cheap answer, with no fingerprint and nothing to apply with.
    const counted = (await preview(c, actor, cyc, 'counts', null, null))
      .find((r) => r.row_kind === 'result')!;
    expect(counted.status).toBe('counted');
    const digest = counted.selection_digest as Buffer;

    // 2. PROBE — the core reports how many identities the caller must mint.
    const probe = (await preview(c, actor, cyc, 'review', null, digest))
      .find((r) => r.row_kind === 'result')!;
    expect(probe.status).toBe('invalid_request');
    const targets = (await c.query(
      `SELECT array_agg(gen_random_uuid()) AS ids FROM generate_series(1,$1::int)`,
      [probe.occurrence_count])).rows[0].ids as string[];

    // 3. REVIEW — the verdict, the fingerprint and the projection, from one observation.
    const rows = await preview(c, actor, cyc, 'review', targets, digest);
    const reviewed = rows.find((r) => r.row_kind === 'result')!;
    expect(reviewed.status).toBe('previewed');
    const fingerprint = reviewed.review_fingerprint as Buffer;
    const expectedNames = rows.filter((r) => r.row_kind === 'series')
      .map((r) => r.target_name as string).sort();

    // 4. APPLY — through the mirror surface, which re-derives rather than being handed an array.
    const commandId = (await c.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
    const applied = await asActor(c, actor, async () => (await c.query(`
      SELECT * FROM public.rebook_round_selection_apply_as_actor(
        $1,$2,'abc27.wire.v1','create','source_cycle',$3,NULL,NULL,NULL,$4::bytea,$5,NULL,
        'Volgende ronde 2026', current_date + 30, NULL, 4, 7, 7, 'deferred_split', false,
        'inherit', false, false, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ARRAY[]::date[], ARRAY[]::date[], ARRAY[]::text[], $6::uuid[], $7::bytea)`,
    [ACADEMY, commandId, cyc, digest, ROUND, targets, fingerprint])).rows[0]);
    expect(applied.status, 'the round is created').toBe('applied');
    expect(applied.child_count).toBe(2);
    expect(applied.occurrence_count).toBe(8);

    // 5. THE PRODUCT — the names an operator and a player will actually read.
    const { rows: made } = await c.query(
      `SELECT name FROM public.cycles WHERE rebook_round_id=$1 ORDER BY name`, [applied.round_id]);
    expect(made.map((r) => r.name).sort(), 'the review showed exactly these names')
      .toEqual(expectedNames);
    for (const r of made) {
      expect(String(r.name), 'a human name, never an identifier')
        .toMatch(/^Volgende ronde 2026 — [A-Z][a-z] \d{2}:\d{2}$/);
      expect(String(r.name))
        .not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    }

    // 6. REPLAY — the same command id and fingerprint is idempotent, not a second round.
    const replay = await asActor(c, actor, async () => (await c.query(`
      SELECT * FROM public.rebook_round_selection_apply_as_actor(
        $1,$2,'abc27.wire.v1','create','source_cycle',$3,NULL,NULL,NULL,$4::bytea,$5,NULL,
        'Volgende ronde 2026', current_date + 30, NULL, 4, 7, 7, 'deferred_split', false,
        'inherit', false, false, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ARRAY[]::date[], ARRAY[]::date[], ARRAY[]::text[], $6::uuid[], $7::bytea)`,
    [ACADEMY, commandId, cyc, digest, ROUND, targets, fingerprint])).rows[0]);
    expect(replay.status, 'the command uuid is the idempotency key').toBe('replayed');
    expect((await c.query(`SELECT count(*)::int AS n FROM public.cycles WHERE rebook_round_id=$1`,
      [applied.round_id])).rows[0].n, 'and no second set of children').toBe(2);
  });

  it('REFUSES to apply a selection the operator has not seen', async () => {
    const c = await freshDb();
    const actor = await manager(c);
    const cyc = await twoSeriesCyclus(c);
    const commandId = (await c.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
    const wrong = Buffer.from('00'.repeat(32), 'hex');
    const r = await asActor(c, actor, async () => (await c.query(`
      SELECT * FROM public.rebook_round_selection_apply_as_actor(
        $1,$2,'abc27.wire.v1','create','source_cycle',$3,NULL,NULL,NULL,$4::bytea,$5,NULL,
        'Volgende ronde 2026', current_date + 30, NULL, 4, 7, 7, 'deferred_split', false,
        'inherit', false, false, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ARRAY[]::date[], ARRAY[]::date[], ARRAY[]::text[], ARRAY[]::uuid[], $6::bytea)`,
    [ACADEMY, commandId, cyc, wrong, ROUND, wrong])).rows[0]);
    expect(r.status).toBe('selection_moved');
    expect((await c.query(`SELECT count(*)::int AS n FROM public.rebook_rounds`)).rows[0].n,
      'and nothing was written').toBe(0);
    // …and an apply that names NO selection at all is refused before anything is resolved.
    const noDigest = await asActor(c, actor, async () => (await c.query(`
      SELECT * FROM public.rebook_round_selection_apply_as_actor(
        $1,$2,'abc27.wire.v1','create','source_cycle',$3,NULL,NULL,NULL,NULL,$4,NULL,
        'Volgende ronde 2026', current_date + 30, NULL, 4, 7, 7, 'deferred_split', false,
        'inherit', false, false, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ARRAY[]::date[], ARRAY[]::date[], ARRAY[]::text[], ARRAY[]::uuid[], $5::bytea)`,
    [ACADEMY, commandId, cyc, ROUND, wrong])).rows[0]);
    expect(noDigest.status).toBe('refused');
  });
});

// ── E-19 · WHAT REVIEW ROUND 1 FOUND ─────────────────────────────────────────────────────────
//
// One test per defect the first adversarial pass surfaced. Each of these FAILED before its fix,
// which is what makes it evidence rather than decoration.

describe('E-19 — the round-1 corrections', () => {
  const ROUND = '55555555-5555-4555-8555-555555555555';

  async function manager(c: pg.Client): Promise<string> {
    const user = (await c.query(`INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
    await c.query(`INSERT INTO public.academy_managers(academy_profile_id,user_id) VALUES ($1,$2)`,
      [ACADEMY, user]);
    return user;
  }

  async function cyclus(c: pg.Client, lanes: number[], opts: { type?: string; price?: number[] } = {}) {
    const cyc = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy',$2,'E19','open',current_date) RETURNING id`,
      [ACADEMY, opts.type ?? 'cyclus'])).rows[0].id;
    const slots: string[] = [];
    lanes.forEach(() => undefined);
    for (let i = 0; i < lanes.length; i += 1) {
      slots.push((await c.query(`INSERT INTO public.availability_slots
        (id,trainer_id,academy_profile_id,source_cycle_id,cyclus_id,start_time,end_time,
         max_participants,price_per_session,member_window_ends_at)
        VALUES (gen_random_uuid(),$1,$2,$3,$3,
                date_trunc('hour',now()) + make_interval(hours => $4::int),
                date_trunc('hour',now()) + make_interval(hours => $4::int + 1),
                4, $5, now()+interval '120 days') RETURNING id`,
      [TRAINER, ACADEMY, cyc, lanes[i], opts.price?.[i] ?? 25])).rows[0].id);
    }
    return { cyc, slots };
  }

  const ask = (c: pg.Client, actor: string | null, o: Record<string, unknown>) =>
    asActor(c, actor, async () => (await c.query(`
      SELECT * FROM public.rebook_round_selection_preview_as_actor(
        $1,'abc27.wire.v1','create','source_cycle',$2,$3,NULL,NULL,$4::text[],$5::bytea,$6,NULL,
        'Ronde', current_date + 30, NULL, 4, 7, 7, 'deferred_split', false, 'inherit', false,
        false, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ARRAY[]::date[], ARRAY[]::date[], ARRAY[]::text[], ARRAY[]::uuid[])`,
    [ACADEMY, o.projection ?? 'counts', o.cycle ?? null, o.excluded ?? null, o.digest ?? null,
      o.round ?? ROUND])).rows);

  const result = (rows: Record<string, unknown>[]) => rows.find((r) => r.row_kind === 'result')!;
  const series = (rows: Record<string, unknown>[]) => rows.filter((r) => r.row_kind === 'series');

  it('P1 · EXCLUDING A SERIES RENAMES THE SURVIVOR, because the core names only what it gets', async () => {
    // The chain's tier 0 — "one series with nothing taken keeps the label VERBATIM" — fires for
    // the core, which sees the INCLUDED set. Naming the unreduced set made the review promise
    // `Ronde — …` for a child the core would call `Ronde`.
    const c = await freshDb();
    const actor = await manager(c);
    const { cyc } = await cyclus(c, [2, 6]);

    const both = series(await ask(c, actor, { cycle: cyc }));
    expect(both).toHaveLength(2);
    expect(both.every((s) => String(s.target_name).startsWith('Ronde — ')),
      'two children are told apart by day and time').toBe(true);

    const drop = both[0].series_key as string;
    const after = series(await ask(c, actor, { cycle: cyc, excluded: [drop] }));
    const kept = after.find((s) => s.series_excluded === false)!;
    expect(kept.target_name, 'ONE child left → the label, verbatim').toBe('Ronde');
    expect(after.find((s) => s.series_excluded === true)!.target_name,
      'and an excluded series has no name, because it has no child').toBeNull();
  });

  it('P1 · A REPRICED COURT MOVES THE DIGEST, so a stale projection cannot be applied', async () => {
    // The wrapper is VOLATILE under READ COMMITTED and reads in several statements, so the
    // projection and the core's derivation can see different product states. The digest cannot
    // make that atomic; it makes it FAIL CLOSED.
    const c = await freshDb();
    const actor = await manager(c);
    const { cyc, slots } = await cyclus(c, [3, 3 + 24 * 7]);
    const first = result(await ask(c, actor, { cycle: cyc })).selection_digest as Buffer;

    await c.query(`UPDATE public.availability_slots SET price_per_session = 99 WHERE id = $1`, [slots[0]]);
    const stale = result(await ask(c, actor, { cycle: cyc, digest: first }));
    expect(stale.status, 'the price the review projected is part of what was selected')
      .toBe('selection_moved');
  });

  it('P1 · A NEW SAME-DATE ROUND MOVES THE DIGEST, because it changes what the child will be called', async () => {
    const c = await freshDb();
    const actor = await manager(c);
    const { cyc } = await cyclus(c, [4]);
    const first = result(await ask(c, actor, { cycle: cyc })).selection_digest as Buffer;

    // Another round takes the very name this one would have used.
    await c.query(`
      INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date,settings)
      VALUES (gen_random_uuid(),$1,'academy','cyclus','Ronde','open',current_date + 30,
              jsonb_build_object('rebook_payment_mode','deferred_split'))`, [ACADEMY]);
    expect(result(await ask(c, actor, { cycle: cyc, digest: first })).status,
      'the naming inputs are part of the selection state').toBe('selection_moved');
  });

  it('P2 · A SOURCE THAT IS NOT A CYCLUS DERIVES NOTHING', async () => {
    // The retired producer resolved the source through `cycles` with `type = 'cyclus'`. Matching
    // `cyclus_id` alone let a manager rebook an event or registration cycle as a weekly course.
    const c = await freshDb();
    const actor = await manager(c);
    const { cyc } = await cyclus(c, [5, 9], { type: 'event' });
    const r = result(await ask(c, actor, { cycle: cyc }));
    expect(r.child_count, 'an event cycle is not a rebookable source').toBe(0);
    expect(series(await ask(c, actor, { cycle: cyc }))).toHaveLength(0);
  });

  it('P2 · A NULL IN THE EXCLUSION ARRAY EXCLUDES NOTHING', async () => {
    // `x = ANY(array containing NULL)` is NULL for a non-match, so `NOT excluded` dropped every
    // series from the FINAL arrays while the checklist coalesced the same NULL to `false`: the
    // screen showed everything included and an empty source set was submitted.
    const c = await freshDb();
    const actor = await manager(c);
    const { cyc } = await cyclus(c, [7, 11]);
    const rows = await ask(c, actor, { cycle: cyc, excluded: [null] });
    expect(series(rows).every((s) => s.series_excluded === false)).toBe(true);
    expect(result(rows).child_count, 'and the round still has both children').toBe(2);
    expect(result(rows).source_count).toBe(2);
  });

  it('P2 · COUNTS REPORTS THE INCLUDED CHILD COUNT, not every qualifying series', async () => {
    const c = await freshDb();
    const actor = await manager(c);
    const { cyc } = await cyclus(c, [8, 12]);
    const all = await ask(c, actor, { cycle: cyc });
    expect(result(all).child_count).toBe(2);
    const drop = series(all)[0].series_key as string;
    const after = result(await ask(c, actor, { cycle: cyc, excluded: [drop] }));
    expect(after.child_count, 'one excluded → one child').toBe(1);
    expect(after.source_count, 'and the counts agree with each other').toBe(1);
  });

  it('P2 · THE SUGGESTED PRICE IS THE MODE OVER SLOTS, as the legacy suggestion was', async () => {
    // Legacy takes the mode of every qualifying SLOT's price. Taking one template price per series
    // made a ten-session €30 group lose to two one-session €20 groups.
    const c = await freshDb();
    const actor = await manager(c);
    const cyc = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','E19 price','open',current_date) RETURNING id`,
      [ACADEMY])).rows[0].id;
    // One €30 series of three sessions, two single-session €20 series.
    const mk = async (lane: number, weeks: number, price: number) => {
      for (let w = 0; w < weeks; w += 1) {
        await c.query(`INSERT INTO public.availability_slots
          (id,trainer_id,academy_profile_id,source_cycle_id,cyclus_id,start_time,end_time,
           max_participants,price_per_session,member_window_ends_at)
          VALUES (gen_random_uuid(),$1,$2,$3,$3,
                  date_trunc('hour',now()) + make_interval(hours => $4::int, days => $5::int),
                  date_trunc('hour',now()) + make_interval(hours => $4::int + 1, days => $5::int),
                  4, $6, now()+interval '200 days')`, [TRAINER, ACADEMY, cyc, lane, w * 7, price]);
      }
    };
    await mk(2, 3, 30);
    await mk(6, 1, 20);
    await mk(10, 1, 20);
    expect(Number(result(await ask(c, actor, { cycle: cyc })).source_modal_price),
      'three €30 slots outnumber two €20 slots').toBe(30);
  });
});

// ── E-20 · WHAT REVIEW ROUND 2 FOUND ─────────────────────────────────────────────────────────

describe('E-20 — the round-2 corrections', () => {
  it('P1 · EVERY DERIVED CHILD ID IS A WELL-FORMED v4 UUID, not merely a legal uuid value', async () => {
    // `md5(…)::uuid` is a legal uuid VALUE whose version and variant nibbles are whatever the
    // digest produced. The browser validates both — as a strict decoder should — so 186 of 200
    // derived ids were rejected and a SUCCESSFUL apply decoded as `unknown`: the round existed and
    // its invitations were never drained. Two hundred keys, because the failure was probabilistic
    // and a handful of samples would have looked fine.
    const c = await freshDb();
    const { rows } = await c.query(`
      SELECT count(*)::int AS n,
             count(*) FILTER (
               WHERE public.d7_child_cycle_id('99999999-9999-4999-8999-999999999999', 'k' || g)::text
                     ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             )::int AS ok,
             count(DISTINCT public.d7_child_cycle_id('99999999-9999-4999-8999-999999999999', 'k' || g))::int AS distinct_ids
        FROM generate_series(1, 200) g`);
    expect(rows[0].ok, 'every one of them').toBe(rows[0].n);
    expect(rows[0].distinct_ids, 'and they are still distinct per series').toBe(200);

    // …and still keyed on the ROUND, so two rounds over the same series never collide.
    const { rows: cross } = await c.query(`
      SELECT public.d7_child_cycle_id($1,'k') = public.d7_child_cycle_id($2,'k') AS same`,
    ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);
    expect(cross[0].same).toBe(false);
    // …and stable, which is what lets a preview and an apply agree.
    const { rows: stable } = await c.query(
      `SELECT public.d7_child_cycle_id($1,'k') = public.d7_child_cycle_id($1,'k') AS same`,
      ['11111111-1111-4111-8111-111111111111']);
    expect(stable[0].same).toBe(true);
  });

  it('P1 · THE LABEL IS NOT IN THE DIGEST, so a count and a review of one selection agree', async () => {
    // The cohort auto-count carries no label at all. Digesting the label made the first review
    // after every count a guaranteed `selection_moved` — the server comparing the count's empty
    // label against the review's real one, and being right about a difference that means nothing.
    const c = await freshDb();
    const cyc = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','E20','open',current_date) RETURNING id`,
      [ACADEMY])).rows[0].id;
    await c.query(`INSERT INTO public.availability_slots
      (id,trainer_id,academy_profile_id,source_cycle_id,cyclus_id,start_time,end_time,
       max_participants,price_per_session,member_window_ends_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$3,date_trunc('hour',now())+interval '5 hours',
              date_trunc('hour',now())+interval '6 hours',4,25,now()+interval '120 days')`,
    [TRAINER, ACADEMY, cyc]);
    const cands = (await c.query(`SELECT public.d7_p_cyclus_candidates($1,$2) AS ids`, [ACADEMY, cyc])).rows[0].ids;
    const digest = async (label: string | null) => (await c.query(
      `SELECT public.d7_p_selection_digest($1,$2::uuid[],'source_cycle',NULL,NULL,$3,NULL,current_date+30,NULL) AS d`,
      [ACADEMY, cands, label])).rows[0].d as Buffer;
    expect((await digest(null)).toString('hex'), 'no label and a label are the same selection')
      .toBe((await digest('Volgende ronde 2026')).toString('hex'));
    // …and the taken names, which the SERVER owns, still move it.
    const before = (await digest(null)).toString('hex');
    await c.query(`
      INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date,settings)
      VALUES (gen_random_uuid(),$1,'academy','cyclus','Anything','open',current_date + 30,
              jsonb_build_object('rebook_payment_mode','deferred_split'))`, [ACADEMY]);
    expect((await digest(null)).toString('hex'), 'a same-date round changes what a child can be called')
      .not.toBe(before);
  });
});

// ── E-21 · WHAT REVIEW ROUND 3 FOUND ─────────────────────────────────────────────────────────

describe('E-21 — the round-3 corrections', () => {
  const ROUND = '44444444-4444-4444-8444-444444444444';

  async function manager(c: pg.Client): Promise<string> {
    const user = (await c.query(`INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
    await c.query(`INSERT INTO public.academy_managers(academy_profile_id,user_id) VALUES ($1,$2)`, [ACADEMY, user]);
    return user;
  }
  const ask = (c: pg.Client, actor: string, cyc: string, label: string) =>
    asActor(c, actor, async () => (await c.query(`
      SELECT * FROM public.rebook_round_selection_preview_as_actor(
        $1,'abc27.wire.v1','create','source_cycle','counts',$2,NULL,NULL,NULL,NULL,$3,NULL,
        $4, current_date + 30, NULL, 4, 7, 7, 'deferred_split', false, 'inherit', false,
        false, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ARRAY[]::date[], ARRAY[]::date[], ARRAY[]::text[], ARRAY[]::uuid[])`,
    [ACADEMY, cyc, ROUND, label])).rows);

  /** The same call, with the projection, the minted pool and the digest opened up. */
  const askLabelled = (c: pg.Client, actor: string, cyc: string, label: string,
    projection: string, targets: string[] | null, digest: Buffer | null) =>
    asActor(c, actor, async () => (await c.query(`
      SELECT * FROM public.rebook_round_selection_preview_as_actor(
        $1,'abc27.wire.v1','create','source_cycle',$5,$2,NULL,NULL,NULL,$7::bytea,$3,NULL,
        $4, current_date + 30, NULL, 4, 7, 7, 'deferred_split', false, 'inherit', false,
        false, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ARRAY[]::date[], ARRAY[]::date[], ARRAY[]::text[], coalesce($6::uuid[], ARRAY[]::uuid[]))`,
    [ACADEMY, cyc, ROUND, label, projection, targets, digest])).rows);

  const result = (rows: Record<string, unknown>[]) => rows.find((r) => r.row_kind === 'result')!;
  const series = (rows: Record<string, unknown>[]) => rows.filter((r) => r.row_kind === 'series');

  async function oneSeries(c: pg.Client, trainer = TRAINER, minutes = 60) {
    const cyc = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','E21','open',current_date) RETURNING id`,
      [ACADEMY])).rows[0].id;
    await c.query(`INSERT INTO public.availability_slots
      (id,trainer_id,academy_profile_id,source_cycle_id,cyclus_id,start_time,end_time,
       max_participants,price_per_session,member_window_ends_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$3,date_trunc('hour',now())+interval '6 hours',
              date_trunc('hour',now())+interval '6 hours'+make_interval(mins => $4::int),
              4,25,now()+interval '120 days')`, [trainer, ACADEMY, cyc, minutes]);
    return cyc;
  }

  it('P1 · A TRAINER RENAME MOVES THE DIGEST, because the name the operator saw came from it', async () => {
    // The wrapper reads display names in one statement and the patched core reads them again in a
    // later one. A rename in between returned the OLD name beside a fingerprint for the NEW one —
    // and the apply then succeeded, writing a name nobody approved.
    // NO ACTOR: this measures the DIGEST bridge directly, as the database owner. The surface's
    // authorization is E-16's subject, and creating a manager here would suggest this test proves
    // something about it.
    const c = await freshDb();
    const user = (await c.query(`INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
    await c.query(`UPDATE public.profiles SET full_name='Sanne de Vries' WHERE user_id=$1`, [user]);
    const trainer = (await c.query(
      `INSERT INTO public.trainer_profiles(id,user_id) VALUES (gen_random_uuid(),$1) RETURNING id`, [user])).rows[0].id;
    const cyc = await oneSeries(c, trainer);
    const cands = (await c.query(`SELECT public.d7_p_cyclus_candidates($1,$2) AS ids`, [ACADEMY, cyc])).rows[0].ids;
    const digest = async () => ((await c.query(
      `SELECT public.d7_p_selection_digest($1,$2::uuid[],'source_cycle',NULL,NULL,'Ronde',NULL,current_date+30,NULL) AS d`,
      [ACADEMY, cands])).rows[0].d as Buffer).toString('hex');

    const before = await digest();
    await c.query(`UPDATE public.profiles SET full_name='Sanne Jansen' WHERE user_id=$1`, [user]);
    expect(await digest(), 'a naming input moved, so the selection moved').not.toBe(before);
  });

  it('P1 · AN OVERLONG LABEL IS REFUSED AT THE BOUNDARY, not rendered into a shorter name', async () => {
    // THIS CASE CHANGED WITH THE TERMINAL CLOSURE, and the change is the point.
    //
    // It used to hand the surface a 320-character label and check only that the projected name
    // came back at most 300 characters. That proved a BOUND, not a parity: the frozen core refuses
    // any label over 200, so the name being measured was one the core would never fingerprint or
    // store. `20261203230000` normalizes the label once at the command boundary and refuses an
    // over-long one there, so the projection is never asked to render it at all.
    //
    // Real projection/apply parity is proved at the longest label the core DOES accept, two cases
    // below.
    const c = await freshDb();
    const actor = await manager(c);
    const cyc = await oneSeries(c);
    const rows = await ask(c, actor, cyc, 'R'.repeat(320));
    const r = rows.find((x) => x.row_kind === 'result')!;
    expect(r.status, 'the boundary refuses it in the typed vocabulary').toBe('invalid_request');
    expect(rows.filter((x) => x.row_kind === 'series'),
      'and nothing is projected for a request that was refused').toHaveLength(0);
  });

  /**
   * REVIEW ROUND 5 (P3): THE TEST ABOVE PROVES A BOUND, NOT A PARITY. It hands the surface a
   * 320-character label, and the frozen core refuses anything over 200 — so the name it checks is
   * one the core would never fingerprint or store, and "exactly as the core stores them" was never
   * put to the question. These two cases ask it properly: the 320 is REFUSED (so the projection's
   * rendering of it is not a storable name at all), and at 200 — the longest label the core does
   * accept — the projected name is compared against the row the apply actually wrote.
   */
  it('P3 · A LABEL THE CORE REFUSES is refused, not quietly rendered into a storable name', async () => {
    const c = await freshDb();
    const actor = await manager(c);
    const cyc = await oneSeries(c);
    const over = result(await askLabelled(c, actor, cyc, 'R'.repeat(201), 'review', null, null));
    expect(over.status, 'a 201-character label is over the core\'s own limit').toBe('invalid_request');
    const at = result(await askLabelled(c, actor, cyc, 'R'.repeat(200), 'counts', null, null));
    expect(at.status, 'and 200 is not — so the boundary is real, not an artefact of this fixture')
      .toBe('counted');
  });

  it('P3 · AT THE LONGEST ACCEPTED LABEL the projected name is the name the apply writes', async () => {
    const c = await freshDb();
    const actor = await manager(c);
    const cyc = await oneSeries(c);
    const label = 'R'.repeat(200);

    const digest = result(await askLabelled(c, actor, cyc, label, 'counts', null, null))
      .selection_digest as Buffer;
    const probe = result(await askLabelled(c, actor, cyc, label, 'review', null, digest));
    expect(probe.status).toBe('invalid_request');
    const targets = (await c.query(
      `SELECT array_agg(gen_random_uuid()) AS ids FROM generate_series(1,$1::int)`,
      [probe.occurrence_count])).rows[0].ids as string[];

    const reviewRows = await askLabelled(c, actor, cyc, label, 'review', targets, digest);
    const reviewed = result(reviewRows);
    expect(reviewed.status, 'the review is a real one, not a refusal this case would pass on')
      .toBe('previewed');
    const projected = series(reviewRows).map((r) => r.target_name as string).sort();
    expect(projected.length).toBeGreaterThan(0);

    const commandId = (await c.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
    const applied = await asActor(c, actor, async () => (await c.query(`
      SELECT * FROM public.rebook_round_selection_apply_as_actor(
        $1,$2,'abc27.wire.v1','create','source_cycle',$3,NULL,NULL,NULL,$4::bytea,$5,NULL,
        $8, current_date + 30, NULL, 4, 7, 7, 'deferred_split', false,
        'inherit', false, false, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ARRAY[]::date[], ARRAY[]::date[], ARRAY[]::text[], $6::uuid[], $7::bytea)`,
    [ACADEMY, commandId, cyc, digest, ROUND, targets,
      reviewed.review_fingerprint as Buffer, label])).rows[0]);
    expect(applied.status, 'the round is created under that label').toBe('applied');

    const { rows: made } = await c.query(
      `SELECT name FROM public.cycles WHERE rebook_round_id=$1 ORDER BY name`, [applied.round_id]);
    expect(made.map((r) => r.name).sort(),
      'the operator was shown exactly the names that were written').toEqual(projected);
  });

  it('P2 · A FRACTIONAL-MINUTE SLOT IS NOT ROUNDED into a duration the core would refuse', async () => {
    // NO ACTOR: the clusterer is called directly, which no client role can do.
    const c = await freshDb();
    const cyc = await oneSeries(c, TRAINER, 60);
    await c.query(`UPDATE public.availability_slots
                      SET end_time = start_time + interval '90 minutes 30 seconds'
                    WHERE cyclus_id = $1`, [cyc]);
    const cands = (await c.query(`SELECT public.d7_p_cyclus_candidates($1,$2) AS ids`, [ACADEMY, cyc])).rows[0].ids;
    const { rows } = await c.query(
      `SELECT tmpl_minutes FROM public.d7_p_series_cluster($1,$2::uuid[],'source_cycle',NULL,NULL,NULL,NULL)`,
      [ACADEMY, cands]);
    expect(rows[0].tmpl_minutes, 'NULL, not 91 — the core refuses it and this must not disagree')
      .toBeNull();
  });

  it('P2 · A LEFTOVER DRAFT OCCUPIES ITS NAME, because the unique index says it does', async () => {
    // `uniq_rebook_cycle_key` covers draft AND open. Excluding drafts from the taken-name read made
    // a colliding draft invisible at every review while failing every apply at the index.
    const c = await freshDb();
    const { rows } = await c.query(`
      INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date,settings)
      VALUES (gen_random_uuid(),$1,'academy','cyclus','Ronde','draft',current_date + 30,
              jsonb_build_object('rebook_payment_mode','deferred_split'))
      RETURNING id`, [ACADEMY]);
    expect(rows).toHaveLength(1);
    const taken = (await c.query(
      `SELECT public.d7_p_taken_names($1,NULL,(current_date + 30)::date) AS names`, [ACADEMY])).rows[0].names;
    expect(taken, 'the draft is holding this name').toContain('Ronde');
  });
});

// ── E-22 · THE D7 TERMINAL SEMANTICS CLOSURE ─────────────────────────────────────────────────

describe('E-22 — label normalization, zero occurrences, the round version and the contact snapshot', () => {
  const ROUND = '55555555-5555-4555-8555-555555555555';

  async function manager(c: pg.Client): Promise<string> {
    const user = (await c.query(`INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
    await c.query(`INSERT INTO public.academy_managers(academy_profile_id,user_id) VALUES ($1,$2)`, [ACADEMY, user]);
    return user;
  }

  // ── THIS BLOCK CLOSES ITS OWN CONNECTIONS ────────────────────────────────────────────────
  //
  // Every case here takes a fresh clone, and by the time the block had grown to a dozen the server
  // answered `sorry, too many clients already` — for whichever test happened to run last, which is
  // a fixture fault wearing the costume of a real failure. The clients are tracked and ended.
  const opened: pg.Client[] = [];
  const db = async (): Promise<pg.Client> => { const c = await freshDb(); opened.push(c); return c; };
  afterEach(async () => {
    while (opened.length) await opened.pop()!.end().catch(() => undefined);
  });

  /** One weekly series. `hours` gives each cyclus its own lane — a shared one trips
   *  `trainer_slot_overlap`, which is a fixture fault rather than anything under test. */
  async function oneSeries(c: pg.Client, hours = 6) {
    const cyc = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','E22','open',current_date) RETURNING id`,
      [ACADEMY])).rows[0].id;
    await c.query(`INSERT INTO public.availability_slots
      (id,trainer_id,academy_profile_id,source_cycle_id,cyclus_id,start_time,end_time,
       max_participants,price_per_session,member_window_ends_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$3,
              date_trunc('hour',now()) + make_interval(hours => $4::int),
              date_trunc('hour',now()) + make_interval(hours => $4::int + 1),
              4,25,now()+interval '120 days')`,
    [TRAINER, ACADEMY, cyc, hours]);
    return cyc;
  }

  /**
   * TWO series, at different times on different weekdays.
   *
   * The label test NEEDS two. With one series the naming chain takes tier 0 and returns the label
   * verbatim through `rebook_round_sanitize_copy`, whose `btrim` removes a trailing space by
   * itself — so a single-series fixture proves the NAMING migration, not the boundary
   * normalization, and stayed green with the normalization deleted. Two series compose
   * `label || ' — ' || <series>` at tier 1, which puts the space in the INTERIOR where no trim
   * can reach it.
   */
  async function twoSeries(c: pg.Client) {
    const cyc = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','E22 two','open',current_date) RETURNING id`,
      [ACADEMY])).rows[0].id;
    for (const lane of [2, 6]) {
      await c.query(`INSERT INTO public.availability_slots
        (id,trainer_id,academy_profile_id,source_cycle_id,cyclus_id,start_time,end_time,
         max_participants,price_per_session,member_window_ends_at)
        VALUES (gen_random_uuid(),$1,$2,$3,$3,
                date_trunc('hour',now()) + make_interval(hours => $4::int, days => $4::int),
                date_trunc('hour',now()) + make_interval(hours => $4::int + 1, days => $4::int),
                4, 25, now()+interval '120 days')`, [TRAINER, ACADEMY, cyc, lane]);
    }
    return cyc;
  }

  /** The preview surface, with the label, the projection and the holiday windows all open. */
  const ask = (c: pg.Client, actor: string, cyc: string, o: {
    label?: string; projection?: string; targets?: string[] | null; digest?: Buffer | null;
    hFrom?: string[]; hTo?: string[]; hLabel?: string[];
  } = {}) =>
    asActor(c, actor, async () => (await c.query(`
      SELECT * FROM public.rebook_round_selection_preview_as_actor(
        $1,'abc27.wire.v1','create','source_cycle',$5,$2,NULL,NULL,NULL,$7::bytea,$3,NULL,
        $4, current_date + 30, NULL, 4, 7, 7, 'deferred_split', false, 'inherit', false,
        false, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        coalesce($8::date[], ARRAY[]::date[]), coalesce($9::date[], ARRAY[]::date[]),
        coalesce($10::text[], ARRAY[]::text[]), coalesce($6::uuid[], ARRAY[]::uuid[]))`,
    [ACADEMY, cyc, ROUND, o.label ?? 'Ronde', o.projection ?? 'review', o.targets ?? null,
      o.digest ?? null, o.hFrom ?? null, o.hTo ?? null, o.hLabel ?? null])).rows);

  const result = (rows: Record<string, unknown>[]) => rows.find((r) => r.row_kind === 'result')!;
  const series = (rows: Record<string, unknown>[]) => rows.filter((r) => r.row_kind === 'series');

  it('P2 · A TRAILING-SPACE LABEL is normalized once, so review and apply name the same cycle', async () => {
    // The projection used the RAW label while both cores use `sanitize_copy(p_label, 201)`, and the
    // digest deliberately excludes the label — so `'Ronde '` projected `Ronde  — Wo 09:00` and the
    // apply wrote `Ronde — Wo 09:00`, successfully. The shipped wizards trim at their own boundary,
    // which is why this only ever reached a direct RPC caller.
    const c = await db();
    const actor = await manager(c);
    const cyc = await twoSeries(c);
    const padded = series(await ask(c, actor, cyc, { label: 'Ronde ', projection: 'counts' }));
    const plain = series(await ask(c, actor, cyc, { label: 'Ronde', projection: 'counts' }));
    expect(padded, 'two series, so the chain composes rather than returning the label verbatim')
      .toHaveLength(2);
    expect(padded.map((r) => r.target_name),
      'the surface names them exactly as the trimmed label would')
      .toEqual(plain.map((r) => r.target_name));
    for (const r of padded) {
      expect(String(r.target_name), 'the interior separator is single — no trim could have done this')
        .not.toContain('  ');
      expect(String(r.target_name), 'and the composition really happened').toContain(' — ');
    }
  });

  it('P2 · A 201-CHARACTER LABEL is a typed refusal, never a silent 200-character truncation', async () => {
    const c = await db();
    const actor = await manager(c);
    const cyc = await oneSeries(c);
    const over = result(await ask(c, actor, cyc, { label: 'R'.repeat(201), projection: 'counts' }));
    expect(over.status).toBe('invalid_request');
    // Sanitizing to max+1 is what makes this refuse rather than fit: a 200-character label is
    // still perfectly legal, so the boundary is real and not an artefact of the fixture.
    const at = result(await ask(c, actor, cyc, { label: 'R'.repeat(200), projection: 'counts' }));
    expect(at.status).toBe('counted');
  });

  it('P2 · A SELECTION WITH NO OCCURRENCES refuses, and issues NOTHING that could arm a send', async () => {
    // The frozen preview verdict has no `n_occ > 0` arm, so this used to come back `previewed` WITH
    // a fingerprint — and the apply writer then raised a bare `22023`, outside the typed vocabulary
    // altogether. A reviewed fingerprint that can never produce a typed apply result is worse than
    // a refusal, because the caller has no way to know it is holding one.
    const c = await db();
    const actor = await manager(c);
    const cyc = await oneSeries(c);
    const wiped = result(await ask(c, actor, cyc, {
      hFrom: ['1900-01-01'], hTo: ['2999-12-31'], hLabel: ['everything'],
    }));
    expect(wiped.status, 'typed, and in the vocabulary the client already decodes').toBe('invalid_request');
    expect(wiped.occurrence_count).toBe(0);
    expect(wiped.review_fingerprint, 'nothing to apply with').toBeNull();
    expect(wiped.selection_digest, 'and nothing to echo either').toBeNull();
    expect(wiped.diagnostic_field).toBe('occurrences');
  });

  /** The closed vocabulary the client decodes. Anything outside it reaches the browser as an error. */
  const TYPED_STATUSES = [
    'applied', 'replayed', 'invalid_request', 'command_tenant_mismatch', 'command_kind_mismatch',
    'command_payload_mismatch', 'round_not_found', 'round_closed', 'round_legacy_review_required',
    'round_command_in_progress', 'child_not_found', 'child_not_draft', 'child_already_in_round',
    'duplicate_sibling_series', 'expected_version_mismatch', 'session_price_refused',
    'incoherent_source', 'review_fingerprint_mismatch', 'source_drift', 'refused', 'selection_moved',
  ];

  /** The apply surface, with the source cycle, digest and holiday windows open. */
  const applyWith = (c: pg.Client, actor: string, o: {
    cycle: string; digest: Buffer; command: string;
    hFrom?: string[]; hTo?: string[]; hLabel?: string[];
    /** The minted pool and the reviewed fingerprint. Omitted for the refusal cases, which never
     *  get far enough to need them; a case that expects `applied` must supply BOTH. */
    targets?: string[]; fingerprint?: Buffer;
  }) => asActor(c, actor, async () => (await c.query(`
      SELECT * FROM public.rebook_round_selection_apply_as_actor(
        $1,$2,'abc27.wire.v1','create','source_cycle',$3,NULL,NULL,NULL,$4::bytea,$5,NULL,
        'Ronde', current_date + 30, NULL, 4, 7, 7, 'deferred_split', false,
        'inherit', false, false, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        coalesce($6::date[], ARRAY[]::date[]), coalesce($7::date[], ARRAY[]::date[]),
        coalesce($8::text[], ARRAY[]::text[]), coalesce($10::uuid[], ARRAY[]::uuid[]), $9::bytea)`,
  [ACADEMY, o.command, o.cycle, o.digest, ROUND,
    o.hFrom ?? null, o.hTo ?? null, o.hLabel ?? null,
    o.fingerprint ?? Buffer.alloc(32), o.targets ?? null])).rows[0]);

  const newId = async (c: pg.Client) =>
    (await c.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;

  it('P2 · A HOLIDAY-WIPED INTENT applied anyway stays inside the typed vocabulary', async () => {
    // IT MUST GET PAST THE FENCE TO PROVE ANYTHING ABOUT WHAT LIES BEHIND IT.
    //
    // REVIEW ROUND 1 (P3) OF THE CLOSURE: the first version handed the apply a zero-filled digest
    // and accepted `selection_moved` OR `refused`. The digest fence (`20261203230000…:957`) answers
    // long before occurrences are considered, so deleting the wrapper's occurrence guard left this
    // green — it was testing the fence. The digest is holiday-independent (that function takes no
    // holiday parameters), so a `counts` call yields the digest the apply recomputes.
    //
    // AND WHAT GETTING PAST IT SHOWED IS WORTH RECORDING. This path does NOT reach the wrapper's
    // occurrence guard: `v_slots` is the SOURCE cluster, which holidays do not touch — they remove
    // generated TARGET occurrences, which only the core derives. The core answers `source_drift`,
    // because a minted pool cannot match a derivation that produced nothing. That is a typed
    // answer, so the property worth pinning is the real one: whatever word arrives, it is one the
    // client already decodes, never a bare SQLSTATE.
    const c = await db();
    const actor = await manager(c);
    const cyc = await oneSeries(c);
    const digest = result(await ask(c, actor, cyc, { projection: 'counts' })).selection_digest as Buffer;
    expect(digest, 'a real digest, or the fence answers before anything else can').toBeInstanceOf(Buffer);

    const row = await applyWith(c, actor, {
      cycle: cyc, digest, command: await newId(c),
      hFrom: ['1900-01-01'], hTo: ['2999-12-31'], hLabel: ['everything'],
    });
    expect(TYPED_STATUSES, 'a word the client decodes, never a raw SQLSTATE').toContain(row.status);
    expect(row.round_id, 'and nothing was created').toBeNull();
  });

  it('P2 · A SELECTION DERIVING NO SLOTS is refused by the wrapper, before the writer can raise', async () => {
    // THIS is what the wrapper's occurrence guard is actually for, and the case that would
    // otherwise reach `abc27_p_normalized_apply_create`'s bare `22023` (frozen ABC-27 `:14164`):
    // an empty source cyclus derives no source slots and no children at all.
    const c = await db();
    const actor = await manager(c);
    const empty = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','E22 empty','open',current_date) RETURNING id`,
      [ACADEMY])).rows[0].id;
    const digest = result(await ask(c, actor, empty, { projection: 'counts' })).selection_digest as Buffer;

    const row = await applyWith(c, actor, { cycle: empty, digest, command: await newId(c) });
    expect(row.status, 'typed, and in the vocabulary the client already decodes').toBe('invalid_request');
    expect((row.detail as { field?: string } | null)?.field).toBe('occurrences');
    expect(row.round_id).toBeNull();
  });

  it('P1 · THE REVIEW DISCLOSES WHEN ITS CONTACT SNAPSHOT WAS TAKEN', async () => {
    // OD1: contact data is a mutable attribute, so the receipt does not freeze it — which makes
    // saying WHEN it was read the operator's only defence against assuming otherwise.
    const c = await db();
    const actor = await manager(c);
    const cyc = await oneSeries(c);
    const before = Date.now();
    const r = result(await ask(c, actor, cyc, { projection: 'review' }));
    const after = Date.now();
    expect(r.roster_as_of, 'a real instant, not a placeholder').toBeInstanceOf(Date);
    // REVIEW ROUND 1 (P3): "is a Date" is satisfied by a stale constant, and a timestamp that does
    // not move is worse than none — it tells the operator a snapshot was taken when it was not.
    // The value must sit inside the window of the call that produced it. A generous margin, because
    // this asserts freshness, not clock agreement between the test host and the server.
    const at = (r.roster_as_of as Date).getTime();
    expect(at, 'taken during this call').toBeGreaterThan(before - 60_000);
    expect(at).toBeLessThan(after + 60_000);
    const second = result(await ask(c, actor, cyc, { projection: 'review' }));
    expect((second.roster_as_of as Date).getTime(),
      'and it MOVES between calls — a constant would pass every assertion above')
      .toBeGreaterThanOrEqual(at);
  });

  it('P2 · TWO DIFFERENT BASES whose truncations converge still get distinct names', async () => {
    // REVIEW ROUND 1 (P2) OF THE CLOSURE. `v_seen` guarantees uniqueness only WITHIN one base and
    // the skip loop consulted only what the ROUND already holds — so four series ending tier 3 as
    // `A, A, B, B`, with `A` and `B` differing ONLY past the character the suffix displaces,
    // produced `A`, `left(A,297) #2`, `B`, `left(B,297) #2` — and those two suffixed names are the
    // same string. Cutting the base to make room for the suffix is what creates the convergence,
    // so the fix and this case belong beside it.
    //
    // THE ARITHMETIC IS THE FIXTURE, and a first attempt at this test failed to reproduce anything
    // because it got it wrong: it put the two pairs at DIFFERENT times, and the time sits around
    // character 204 — comfortably inside the 297 that survives, so the bases never converged and
    // the test stayed green with the guard removed.
    //
    //   label(200) + ' — '(3) + 'Wo 09:00'(8) + ' · '(3) + first name(86) = exactly 300
    //
    // So all four must share ONE time (tier 1 collides for all of them), and the two first names
    // must share their first 83 characters and differ in 84..86 — the three that `left(·, 297)`
    // throws away.
    const c = await db();
    const actor = await manager(c);
    const stem = 'B'.repeat(83);
    // Four DISTINCT trainer ids: the clusterer keys on trainer_id, so a pair sharing a NAME is
    // still two series. Within a pair the names are identical, so only tier 4 can separate them.
    const trainers = [
      await trainerNamed(c, `${stem}QQQ`), await trainerNamed(c, `${stem}QQQ`),
      await trainerNamed(c, `${stem}ZZZ`), await trainerNamed(c, `${stem}ZZZ`),
    ];
    const cyc = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','E22 converge','open',current_date) RETURNING id`,
      [ACADEMY])).rows[0].id;
    for (const trainer of trainers) {
      await c.query(`INSERT INTO public.availability_slots
        (id,trainer_id,academy_profile_id,source_cycle_id,cyclus_id,start_time,end_time,
         max_participants,price_per_session,member_window_ends_at)
        VALUES (gen_random_uuid(),$1,$2,$3,$3,date_trunc('hour',now())+interval '6 hours',
                date_trunc('hour',now())+interval '7 hours',4,25,now()+interval '120 days')`,
      [trainer, ACADEMY, cyc]);
    }

    const names = series(await ask(c, actor, cyc, { label: 'R'.repeat(200), projection: 'counts' }))
      .map((r) => String(r.target_name));
    expect(names.length, 'four series are projected').toBe(4);
    // NON-VACUITY, AND IT IS THE PART THAT WENT WRONG BEFORE. Unless at least two names reach the
    // ceiling and agree on their first 297 characters, convergence was never possible and this
    // case proves nothing about the guard.
    const atCeiling = names.filter((n) => n.length === 300);
    expect(atCeiling.length, 'names reach the ceiling').toBeGreaterThanOrEqual(2);
    expect(new Set(names.map((n) => n.slice(0, 297))).size,
      'and at least two of them share the 297 characters a suffix would leave')
      .toBeLessThan(names.length);
    expect(new Set(names).size,
      'yet all four are distinct — uniqueness is not merely per-base').toBe(4);
  });

  it('P1 · THE APPLY DISCLOSES WHO WAS REACHABLE when it wrote the round', async () => {
    // OD1/OD2. Contact data is a mutable attribute of a person, not identity of a command, so the
    // apply PROCEEDS when it has moved — and the operator is told. The server states two facts and
    // does not compare: the caller already holds the projection the operator approved, so the
    // arithmetic between two SERVER-ISSUED numbers is the caller's. A baseline the browser passed
    // in would be the browser deciding what it had been told.
    const c = await db();
    const actor = await manager(c);
    const cyc = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','E22 contacts','open',current_date) RETURNING id`,
      [ACADEMY])).rows[0].id;
    const slot = (await c.query(`INSERT INTO public.availability_slots
      (id,trainer_id,academy_profile_id,source_cycle_id,cyclus_id,start_time,end_time,
       max_participants,price_per_session,member_window_ends_at)
      VALUES (gen_random_uuid(),$1,$2,$3,$3,date_trunc('hour',now())+interval '6 hours',
              date_trunc('hour',now())+interval '7 hours',4,25,now()+interval '120 days')
      RETURNING id`, [TRAINER, ACADEMY, cyc])).rows[0].id;
    // Two players: one reachable, one not.
    for (const [name, email] of [['Met adres', 'has@example.test'], ['Zonder adres', null]]) {
      const user = (await c.query(`INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
      const profile = (await c.query(
        `UPDATE public.profiles SET full_name=$2, email=$3 WHERE user_id=$1 RETURNING id`,
        [user, name, email])).rows[0].id;
      await c.query(`INSERT INTO public.bookings(slot_id,player_id,status) VALUES ($1,$2,'confirmed')`,
        [slot, profile]);
    }

    const digest = result(await ask(c, actor, cyc, { projection: 'counts' })).selection_digest as Buffer;
    const probe = result(await ask(c, actor, cyc, { projection: 'review', digest }));
    const targets = (await c.query(
      `SELECT array_agg(gen_random_uuid()) AS ids FROM generate_series(1,$1::int)`,
      [probe.occurrence_count])).rows[0].ids as string[];
    const reviewed = result(await ask(c, actor, cyc, { projection: 'review', targets, digest }));
    expect(reviewed.status, 'a real review, not a refusal this case would pass on').toBe('previewed');
    expect(reviewed.no_email_total, 'the review saw exactly one unreachable player').toBe(1);

    // ── AND NOW THE CONTACT SET MOVES, WHICH IS THE WHOLE POINT ─────────────────────────────
    //
    // REVIEW ROUND 1 (P3): this case claimed to prove "the apply proceeds when contact data moved"
    // and never moved any. The player who had no address gets one BETWEEN the review and the
    // apply — exactly the race OD1 decided to allow and disclose rather than refuse.
    await c.query(`UPDATE public.profiles SET email='late@example.test' WHERE full_name='Zonder adres'`);

    const commandId = (await c.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
    const applied = await asActor(c, actor, async () => (await c.query(`
      SELECT * FROM public.rebook_round_selection_apply_as_actor(
        $1,$2,'abc27.wire.v1','create','source_cycle',$3,NULL,NULL,NULL,$4::bytea,$5,NULL,
        'Ronde', current_date + 30, NULL, 4, 7, 7, 'deferred_split', false,
        'inherit', false, false, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ARRAY[]::date[], ARRAY[]::date[], ARRAY[]::text[], $6::uuid[], $7::bytea)`,
    [ACADEMY, commandId, cyc, digest, ROUND, targets,
      reviewed.review_fingerprint as Buffer])).rows[0]);
    // THE ROUND IS STILL WRITTEN. Contact data is a mutable attribute, not command identity, so a
    // third party's profile edit does not invalidate a reviewed receipt (OD1/OD2).
    expect(applied.status, 'the apply PROCEEDS through the change').toBe('applied');
    // …and it states what it saw, which is what makes the movement visible instead of silent. The
    // review counted one reachable and one not; by apply time both are reachable.
    expect(applied.contactable_count, 'both are reachable by the time the round is written').toBe(2);
    expect(applied.uncontactable_count).toBe(0);
  });

  /** A trainer whose FIRST name (the chain uses `split_part(name,' ',1)`) is exactly `n` chars. */
  async function trainerNamed(c: pg.Client, first: string) {
    const user = (await c.query(`INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
    await c.query(`UPDATE public.profiles SET full_name=$2 WHERE user_id=$1`, [user, `${first} Jansen`]);
    return (await c.query(
      `INSERT INTO public.trainer_profiles(id,user_id) VALUES (gen_random_uuid(),$1) RETURNING id`,
      [user])).rows[0].id;
  }

  it('P1 · NAMES THAT ONLY COLLIDE AFTER TRUNCATION are disambiguated, not refused', async () => {
    // THE DEFECT ROUND 5 FOUND. The chain decided collisions on UNTRUNCATED candidates while both
    // callers truncated to 300 afterwards, so it was answering a question about strings nobody
    // stores. Two same-time series whose trainers' first names share a long prefix are distinct at
    // tier 2 and identical once cut to 300 — and the core's distinct-name verdict then refused a
    // cohort that had a perfectly good pair of names available.
    const c = await db();
    const actor = await manager(c);
    const shared = 'A'.repeat(120);
    const t1 = await trainerNamed(c, `${shared}Xaviera`);
    const t2 = await trainerNamed(c, `${shared}Yolanda`);
    const cyc = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','E22 collide','open',current_date) RETURNING id`,
      [ACADEMY])).rows[0].id;
    // SAME weekday and time, different trainers: tier 1 collides, so tier 2 appends the first name.
    for (const trainer of [t1, t2]) {
      await c.query(`INSERT INTO public.availability_slots
        (id,trainer_id,academy_profile_id,source_cycle_id,cyclus_id,start_time,end_time,
         max_participants,price_per_session,member_window_ends_at)
        VALUES (gen_random_uuid(),$1,$2,$3,$3,date_trunc('hour',now())+interval '6 hours',
                date_trunc('hour',now())+interval '7 hours',4,25,now()+interval '120 days')`,
      [trainer, ACADEMY, cyc]);
    }

    const rows = series(await ask(c, actor, cyc, { label: 'R'.repeat(200), projection: 'counts' }));
    expect(rows, 'both series are projected').toHaveLength(2);
    const names = rows.map((r) => String(r.target_name));
    // NON-VACUITY FIRST: the truncation must actually be biting, or this proves nothing.
    for (const n of names) {
      expect(n.length, 'each name is at the storable ceiling').toBe(300);
    }
    expect(new Set(names).size,
      'and they are DISTINCT — decided on the form that is actually stored').toBe(2);
  });

  it('P1 · A NUMERIC SUFFIX FITS INSIDE the ceiling instead of being truncated away', async () => {
    // Tier 4's whole job is breaking ties. Appending ` #2` to a base already at 300 characters and
    // truncating afterwards gives back the base — so the tier could hand back the very name it was
    // disambiguating from. The base is cut to `300 - length(' #k')` BEFORE the suffix goes on.
    const c = await db();
    const actor = await manager(c);
    const shared = 'A'.repeat(200);
    const t1 = await trainerNamed(c, shared);
    const t2 = await trainerNamed(c, shared);   // IDENTICAL first names: tier 2 and 3 cannot separate them
    const cyc = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','E22 suffix','open',current_date) RETURNING id`,
      [ACADEMY])).rows[0].id;
    for (const trainer of [t1, t2]) {
      await c.query(`INSERT INTO public.availability_slots
        (id,trainer_id,academy_profile_id,source_cycle_id,cyclus_id,start_time,end_time,
         max_participants,price_per_session,member_window_ends_at)
        VALUES (gen_random_uuid(),$1,$2,$3,$3,date_trunc('hour',now())+interval '6 hours',
                date_trunc('hour',now())+interval '7 hours',4,25,now()+interval '120 days')`,
      [trainer, ACADEMY, cyc]);
    }

    const names = series(await ask(c, actor, cyc, { label: 'R'.repeat(200), projection: 'counts' }))
      .map((r) => String(r.target_name));
    expect(names).toHaveLength(2);
    expect(new Set(names).size, 'the numeric tier separated them').toBe(2);
    expect(names.some((n) => n.endsWith(' #2')),
      'and the suffix SURVIVED — it was not truncated off the end it was added to').toBe(true);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(300);
  });

  it('OD3 · AN EXTEND PROBE IS REFUSED FOR THE VERSION, and the refusal still carries it', async () => {
    // CLOSURE REVIEW ROUND 2 (P1). This is the shape the unit fixture got WRONG, and getting it
    // wrong meant OD3 shipped not working at all.
    //
    // The core refuses `extend` with a null `p_expected_version` outright (frozen ABC-27 `:15728`)
    // — the fence is mandatory and checked long before any occurrence is derived — so the probe
    // comes back `invalid_request` with ZERO occurrences. A client that exits on zero occurrences
    // never reads the version, and no extend ever reaches a review. The unit test scripted
    // `occurrence_count: 8` beside that refusal, which no server can produce.
    //
    // What makes the repair possible is that the wrapper resolves the version BEFORE calling the
    // core, so the refusal still carries it.
    const c = await db();
    const actor = await manager(c);
    const cyc = await oneSeries(c);
    // A round to extend. `rebook_rounds` is Domain-A owned and revoked from every client role, so
    // it is seeded directly here — the point of this case is the WRAPPER's disclosure, not how the
    // round came to exist.
    await c.query(`INSERT INTO public.rebook_rounds(id, academy_profile_id, label,
                     priority_window_ends_at)
                   VALUES ($1,$2,'Ronde', now() + interval '30 days')
                   ON CONFLICT (id) DO NOTHING`, [ROUND, ACADEMY]);
    // A REALISTIC EXTEND TARGET, and the first fixture here was not one. An extend resolves its
    // label from the round's OWN cycles (`d7_p_round_label`), and a round with none refuses at the
    // label gate — which sits before the version read, so the disclosure never happened and this
    // case failed for a reason that had nothing to do with what it was testing. A round being
    // extended always has children; this makes the fixture say so.
    await c.query(`INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date,settings)
                   VALUES (gen_random_uuid(),$1,'academy','cyclus','Ronde — Wo 09:00','open',current_date,
                     jsonb_build_object('rebook_round_id',$2::text,'rebook_round_label','Ronde',
                                        'rebook_payment_mode','deferred_split'))`,
    [ACADEMY, ROUND]);
    const version = (await c.query(
      `SELECT version FROM public.rebook_rounds WHERE id=$1`, [ROUND])).rows[0]?.version;
    expect(version, 'the round has a version to disclose').not.toBeUndefined();

    const rows = await asActor(c, actor, async () => (await c.query(`
      SELECT * FROM public.rebook_round_selection_preview_as_actor(
        $1,'abc27.wire.v1','extend','source_cycle','review',$2,NULL,NULL,NULL,NULL,$3,NULL,
        NULL, current_date + 30, NULL, 4, 7, 7, 'deferred_split', false, 'inherit', false,
        false, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ARRAY[]::date[], ARRAY[]::date[], ARRAY[]::text[], ARRAY[]::uuid[])`,
    [ACADEMY, cyc, ROUND])).rows);
    const r = result(rows);
    // BOTH halves matter. The refusal is real…
    expect(r.status, 'the core refuses a null version outright').toBe('invalid_request');
    expect(r.occurrence_count, 'it derives nothing, so a zero-occurrence exit fires first').toBe(0);
    // …and the version is there anyway, which is the only reason an extend can be repaired.
    expect(r.round_version, 'the wrapper resolved it before calling the core').toBe(version);
  });

  it('CLOSURE · THE PROTECTED VOCABULARY IS A CLOSED SET, and every generic claim path honours it', async () => {
    // `APPLY_ORDER_HARDENING`. The vocabulary and the exclusions land in ONE transaction, because a
    // window in which the event type exists and the generic claimer does not yet exclude it is a
    // window in which the shipped email worker would claim an invite row, send it, and on a crash
    // RE-CLAIM it — an automatic re-send of a row whose provider outcome is unknown.
    const c = await db();
    const vocab = (await c.query(`SELECT public.rebook_round_protected_event_types() AS v`)).rows[0].v;
    expect(vocab, 'a closed set, named not matched')
      .toEqual(['rebook_member_open_player', 'rebook_priority_claim_invite']);

    // EVERY generic claim path names the vocabulary rather than a single literal. Asserted from the
    // CATALOG, not from the migration text: what matters is what is installed.
    for (const fn of ['public.claim_notification_outbox_batch(text,text,int,int)',
      'public.release_notification_claims_on_kill(text,text)',
      'public.guard_notification_event_type_authority()']) {
      const def = (await c.query(`SELECT pg_get_functiondef(to_regprocedure($1)) AS d`, [fn])).rows[0].d;
      expect(def, `${fn} consults the vocabulary`).toContain('rebook_round_protected_event_types');
      expect(def, `${fn} keeps no bare member-open literal`)
        .not.toContain("'rebook_member_open_player'");
    }

    // …and the event type itself exists, with the shape that says it is NOT a member-open row.
    const et = (await c.query(
      `SELECT requires_rebook_round, requires_rebook_round_recipient, trusted_payload_builder
         FROM public.notification_event_types WHERE key = 'rebook_priority_claim_invite'`)).rows[0];
    expect(et.requires_rebook_round, 'an invite belongs to a round').toBe(true);
    expect(et.requires_rebook_round_recipient,
      'but its subject is a priority CLAIM, not a round recipient').toBe(false);
    // NULL, DELIBERATELY. Setting this column means the SERVER builds the payload and a caller may
    // not — `enqueue_notification` refuses a caller payload outright for such an event. Member-open
    // needs that; an invite is rendered by the sender that owns its template, so NULL is both
    // correct and what lets the sender pass the body it froze.
    expect(et.trusted_payload_builder, 'the sender renders an invite, so the server must not').toBeNull();
  });

  it('CLOSURE · SIX ROUTINES CONSULT THE VOCABULARY, and the two that must not, do not', async () => {
    // The transport half of the generalization, proved from the CATALOG rather than from the
    // migration text — what matters is what is installed, not what a file says it installed.
    //
    // SIX, NOT SEVEN. An earlier version of this release widened seven routines it called
    // "event-blind", and this test asserted all seven. The premise was measured and is false: every
    // one of them reads `related_rebook_round_recipient_id`, and the split below is by what each
    // one DOES with it, which is the only split that survives contact with the schema.
    const c = await db();
    const widened = [
      'public.rebook_member_open_claim_batch(text,int)',
      'public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)',
      'public.rebook_member_open_record_dispatch_outcome(uuid,text,int,bytea,int,text,text,text,boolean)',
      'public.rebook_member_open_recover_expired_leases(int,int)',
      'public.rebook_member_open_dispatch_status(uuid)',
      'public.rebook_member_open_dispatch_status_by_capability(uuid,int,bytea,text)',
    ];
    for (const sig of widened) {
      const def = (await c.query(`SELECT pg_get_functiondef(to_regprocedure($1)) AS d`, [sig])).rows[0].d;
      expect(def, `${sig} consults the protected vocabulary`).toContain('rebook_round_protected_event_types');
      expect(def, `${sig} keeps no bare member-open equality`)
        .not.toContain("event_type = 'rebook_member_open_player'");
    }

    // THE EVENT-SPECIFIC ONES ARE DELIBERATELY UNTOUCHED, and saying so here is what stops a later
    // "tidy-up" from widening them.
    //
    //   `pre_dispatch_resolve` resolves through a member SNAPSHOT; an invitation has none, and a
    //     widened literal would send it looking for one.
    //   `close_unresolved` writes a `rebook_round_recipient_decisions` row on BOTH arms, and that
    //     table's composite FK to `rebook_round_recipients` makes the write impossible for an
    //     invitation. Widening it would not merely fail for that row — the failure aborts the whole
    //     batch, taking the member-open rows in it down too. An unresolved invitation instead waits
    //     for an operator, which is what `ODB_UNKNOWN_IS_CLEARED_ONLY_BY_AN_OPERATOR` requires.
    // ── A THIRD CATEGORY: WIDENED AT THE GATE, MEMBER-OPEN IN THE BODY ────────────────────
    //
    // `pre_dispatch_resolve` is neither of the two above, and review round 1 is why it moved. The
    // worker calls it unconditionally, so leaving it member-open meant an invitation was refused
    // `capability_mismatch` and never dispatched at all — the enqueue worked and nothing downstream
    // did.
    //
    // So its ROW LOOKUP admits the protected set, and an invitation returns from an early branch
    // before one line of member-open policy runs. The three member-open literals that remain — the
    // preference lookup, the event-type row and the academy restriction — are that policy, and they
    // are asserted to SURVIVE: widening them would send an invitation looking for a member snapshot,
    // a preference row and a decision it cannot have.
    const resolver = (await c.query(
      `SELECT pg_get_functiondef(to_regprocedure('public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)')) AS d`)).rows[0].d as string;
    expect(resolver, 'the row lookup admits the protected set')
      .toContain('o.event_type = ANY (public.rebook_round_protected_event_types())');
    expect(resolver, 'an invitation is answered by its own early branch')
      .toContain("IF r.event_type = 'rebook_priority_claim_invite' THEN");
    // ...and that branch decides NOTHING for itself. It asks the one verdict authority and acts on
    // the answer. The two absence assertions are the load-bearing half: an inline pending re-read or
    // an inline suppression check here is a SECOND opinion, and the send would then be made under a
    // verdict this function never saw.
    expect(resolver, 'and that branch asks the one verdict authority')
      .toContain('rebook_priority_claim_invite_verdict(r.id)');
    //
    // SCOPED TO THE BRANCH, and that scoping is the assertion. The member-open contact loop below
    // it legitimately skips suppressed addresses and legitimately checks the channel kill — a
    // whole-body absence check would be false, and a whole-body presence check would pass on the
    // member-open occurrence while the branch quietly kept a duplicate. Both halves are asserted.
    const bStart = resolver.indexOf("IF r.event_type = 'rebook_priority_claim_invite' THEN");
    const bEnd = resolver.indexOf('    RETURN;\n  END IF;\n', bStart);
    expect(bStart, 'the invitation branch is locatable').toBeGreaterThan(-1);
    expect(bEnd, 'and bounded').toBeGreaterThan(bStart);
    const branch = resolver.slice(bStart, bEnd);
    const after = resolver.slice(bEnd);
    expect(branch, 'the branch keeps no pending re-read of its own')
      .not.toContain('d7_p_invite_contact');
    expect(branch, 'no suppression check of its own')
      .not.toContain('is_email_suppressed');
    expect(branch, 'and no channel-kill check of its own')
      .not.toContain('is_notification_channel_killed');
    expect(after, "while member-open's own address policy survives below it")
      .toContain('is_email_suppressed');
    expect(after, 'as does its own channel-kill check')
      .toContain('is_notification_channel_killed');
    expect(resolver, 'the member-open policy below it is untouched')
      .toContain('abc27_a_member_snapshot');
    // COUNTED, not merely present. TWO `event_type =` literals remain — the recipient's preference
    // row and the academy's channel restriction — plus one `key =` lookup of the event-type row
    // itself. All three are member-open policy; a fourth appearing, or one vanishing, means the
    // branch boundary moved.
    expect((resolver.match(/event_type = 'rebook_member_open_player'/g) ?? []).length,
      'exactly the two member-open policy predicates survive').toBe(2);
    expect(resolver, 'and the event-type row it reads is still member-open\'s')
      .toContain("WHERE key = 'rebook_member_open_player'");

    for (const memberOnly of [
      'public.rebook_member_open_close_unresolved(int)',
    ]) {
      const def = (await c.query(
        `SELECT pg_get_functiondef(to_regprocedure($1)) AS d`, [memberOnly])).rows[0].d;
      expect(def, `${memberOnly} still knows exactly which event it serves`)
        .toContain("'rebook_member_open_player'");
      expect(def, `${memberOnly} must NOT have been widened`)
        .not.toContain('rebook_round_protected_event_types');
      // AND IT STILL PASSES A SUBJECT DOMAIN. It was re-issued — the issuing authority changed shape —
      // so this proves the re-issue happened and that it stamped the member-open literal, rather than
      // the routine having been left behind on a signature that no longer exists.
      expect(def, `${memberOnly} stamps the member-open subject domain`)
        .toContain("'snapshot_member'");
    }

    // AND THE SHAPE CONSTRAINT STAYS MEMBER-OPEN. It requires a round RECIPIENT, which an invite has
    // no business carrying — it is written as `event_type <> '…' OR (…)`, so a second event type
    // passes it untouched.
    const shape = (await c.query(`
      SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
       WHERE conname = 'chk_notification_outbox_rebook_member_open_shape'`)).rows[0].d;
    expect(shape, 'the member-open shape is still scoped to member-open')
      .toContain('rebook_member_open_player');
    expect(shape, 'and was NOT widened to the vocabulary')
      .not.toContain('rebook_round_protected_event_types');
  });

  it('CLOSURE · THE INVITE BRIDGES ARE P-OWNED, N-REACHABLE, AND REACHABLE BY NOBODY ELSE', async () => {
    // `CROSS_OWNER`. An invite's subject is a `slot_priority_claims` row — Domain P — and a
    // Domain-N body may not read a P relation directly, for the reason `20261203170000` measured in
    // the other direction: a body whose owner holds nothing on the target dies on that table's own
    // RLS policy, because a policy expression runs as the querying role.
    const c = await db();
    const nOwner = (await c.query(
      `SELECT relowner::regrole::name AS o FROM pg_class WHERE oid = 'public.notification_outbox'::regclass`)).rows[0].o;
    const pOwner = (await c.query(
      `SELECT relowner::regrole::name AS o FROM pg_class WHERE oid = 'public.cycles'::regclass`)).rows[0].o;
    // N AND P ARE THE SAME ROLE, and this test says so rather than pretending otherwise. The
    // preflight assumed they were distinct; they are not — only Domain A is separate. The bridge is
    // therefore an encapsulation and tenancy boundary, not a privilege one, and what must hold is
    // the NEGATIVE SPACE below: no runtime role can reach a claim's contact facts.
    expect(nOwner, 'the transport and product owners are the same role today').toBe(pOwner);
    const aOwner = (await c.query(
      `SELECT proowner::regrole::name AS o FROM pg_proc
        WHERE oid = to_regprocedure('public.rebook_round_preview_normalized_core(uuid,uuid,text,text,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[],uuid[],uuid[])')`)).rows[0].o;
    expect(aOwner, 'Domain A is the one that IS separate').not.toBe(pOwner);

    for (const sig of ['public.d7_p_invite_recipient_snapshot(uuid,uuid)',
      'public.d7_p_invite_round_claims(uuid,uuid,int)']) {
      const { rows } = await c.query(`
        SELECT p.proowner::regrole::name AS owner,
               has_function_privilege($2, p.oid, 'EXECUTE') AS n_can,
               has_function_privilege('anon',           p.oid, 'EXECUTE') AS anon_can,
               has_function_privilege('authenticated',  p.oid, 'EXECUTE') AS auth_can,
               has_function_privilege('service_role',   p.oid, 'EXECUTE') AS svc_can
          FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [sig, nOwner]);
      expect(rows[0].owner, `${sig} is Domain-P owned`).toBe(pOwner);
      expect(rows[0].n_can, `${sig} is reachable by the N owner`).toBe(true);
      // NEGATIVE SPACE, and it is the half that matters: every runtime role is refused, so there is
      // no second path to a claim's contact facts.
      expect(rows[0].anon_can, `${sig} is closed to anon`).toBe(false);
      expect(rows[0].auth_can, `${sig} is closed to authenticated`).toBe(false);
      expect(rows[0].svc_can, `${sig} is closed to service_role`).toBe(false);
    }

    // LOCK ORDER, ASSERTED FROM THE INSTALLED BODY. A `FOR UPDATE` here would put an N→P wait edge
    // inside the dispatch transaction while a product path holds P and wants N.
    for (const sig of ['public.d7_p_invite_recipient_snapshot(uuid,uuid)',
      'public.d7_p_invite_round_claims(uuid,uuid,int)']) {
      const def = (await c.query(`SELECT pg_get_functiondef(to_regprocedure($1)) AS d`, [sig])).rows[0].d;
      expect(def.toUpperCase(), `${sig} takes no row lock`).not.toContain('FOR UPDATE');
      expect(def.toUpperCase(), `${sig} takes no share lock either`).not.toContain('FOR SHARE');
    }

    // AND NO OUTBOX COLUMN REFERENCES THE CLAIM. The guest merge deletes claims; a send record that
    // referenced one by FK would be deleted with it, or would block the merge. That is the defect
    // this whole batch exists to remove, so it is asserted rather than assumed.
    const { rows: fks } = await c.query(`
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'public.notification_outbox'::regclass
         AND contype = 'f'
         AND confrelid = 'public.slot_priority_claims'::regclass`);
    expect(fks, 'the outbox never references a priority claim').toEqual([]);
  });

  it('OD3 · A REAL CREATE-THEN-EXTEND: the version repair is what makes the second one previewable', async () => {
    // THE ONLY FIXTURE THAT CAN ANSWER THIS. Two earlier attempts at it were not extends at all:
    // one seeded a bare `rebook_rounds` row (no label — refused at the label gate), the next added
    // a labelled cycle but still no STORED NORMALIZED POLICY, so the core found no facts and
    // answered `refused`. An extend reuses the policy a typed APPLY writes, so the round has to be
    // created by one. The extend then targets a DIFFERENT source cyclus, because the clusterer
    // suppresses series the round already holds.
    const c = await db();
    const actor = await manager(c);
    const first = await oneSeries(c, 6);
    const second = await oneSeries(c, 10);

    // ── 1. CREATE, through the whole typed protocol ─────────────────────────────────────────
    const d1 = result(await ask(c, actor, first, { projection: 'counts' })).selection_digest as Buffer;
    const p1 = result(await ask(c, actor, first, { projection: 'review', digest: d1 }));
    const t1 = (await c.query(`SELECT array_agg(gen_random_uuid()) AS ids FROM generate_series(1,$1::int)`,
      [p1.occurrence_count])).rows[0].ids as string[];
    const r1 = result(await ask(c, actor, first, { projection: 'review', targets: t1, digest: d1 }));
    expect(r1.status, 'the create is reviewable').toBe('previewed');
    const applied = await applyWith(c, actor, { cycle: first, digest: d1, command: await newId(c),
      targets: t1, fingerprint: r1.review_fingerprint as Buffer });
    expect(applied.status, 'and it applies').toBe('applied');

    // ── 2. NOW EXTEND IT, which is what OD3 exists for ──────────────────────────────────────
    const extendProbe = async (v: number | null, targets: string[] | null, digest: Buffer | null) =>
      result(await asActor(c, actor, async () => (await c.query(`
        SELECT * FROM public.rebook_round_selection_preview_as_actor(
          $1,'abc27.wire.v1','extend','source_cycle','review',$2,NULL,NULL,NULL,$6::bytea,$3,$4,
          NULL, current_date + 30, NULL, 4, 7, 7, 'deferred_split', false, 'inherit', false,
          false, NULL, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          ARRAY[]::date[], ARRAY[]::date[], ARRAY[]::text[],
          coalesce($5::uuid[], ARRAY[]::uuid[]))`,
      [ACADEMY, second, ROUND, v, targets, digest])).rows));

    // The FIRST probe is refused for the mandatory fence — and carries the version anyway. That
    // combination is the entire repair: a client that exits on zero occurrences never sees it.
    const refused = await extendProbe(null, null, null);
    expect(refused.status).toBe('invalid_request');
    expect(refused.occurrence_count, 'nothing is derived without the fence').toBe(0);
    const version = refused.round_version as number;
    expect(version, 'yet the wrapper resolved the round version before calling the core')
      .not.toBeNull();

    // The SECOND probe, carrying it, is the one an extend can be built on.
    const armed = await extendProbe(version, null, null);
    expect(armed.occurrence_count,
      'with the version the core derives the pool a caller must mint for').toBeGreaterThan(0);
    expect(armed.selection_digest, 'and a digest to echo').not.toBeNull();
  });

  it('P1 · A CREATE DISCLOSES NO ROUND VERSION, because it has no premise to fence', async () => {
    const c = await db();
    const actor = await manager(c);
    const cyc = await oneSeries(c);
    expect(result(await ask(c, actor, cyc, { projection: 'counts' })).round_version).toBeNull();
  });
});

describe('E-23 — the closed transport subject: containment, compatibility and privilege surface', () => {
  const opened: pg.Client[] = [];
  const db = async (): Promise<pg.Client> => { const c = await freshDb(); opened.push(c); return c; };
  afterEach(async () => {
    while (opened.length) await opened.pop()!.end().catch(() => undefined);
  });

  it('the subject vocabulary is CLOSED — the two domains, and nothing else is representable', async () => {
    const c = await db();
    const v = (await c.query(`SELECT public.rebook_round_transport_subject_domains() AS d`)).rows[0].d;
    expect(v, 'exactly the two transport subject domains').toEqual(['snapshot_member', 'priority_claim']);

    // THE MAP IS TOTAL OVER THE PROTECTED SET AND NULL EVERYWHERE ELSE. NULL is the refusal every
    // caller checks; a default would be an event type quietly acquiring a subject it never declared.
    const m = (await c.query(
      `SELECT public.rebook_round_transport_subject_domain_for_event('rebook_member_open_player')    AS member,
              public.rebook_round_transport_subject_domain_for_event('rebook_priority_claim_invite') AS invite,
              public.rebook_round_transport_subject_domain_for_event('invoice_due')                  AS other,
              public.rebook_round_transport_subject_domain_for_event(NULL)                           AS none`)).rows[0];
    expect([m.member, m.invite, m.other, m.none])
      .toEqual(['snapshot_member', 'priority_claim', null, null]);

    // AND THE CHECK CONSTRAINT IS SOURCED FROM THAT VOCABULARY, not from a literal list that could
    // drift away from it. This is the property ABC-27 asserts for its own action vocabulary.
    const def = (await c.query(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conrelid = 'public.rebook_round_transport_transitions'::regclass
          AND conname = 'chk_rrtt_subject_domain'`)).rows[0].d;
    expect(def, 'the domain CHECK consults the vocabulary function')
      .toContain('rebook_round_transport_subject_domains');
  });

  it('an UNKNOWN subject domain is refused by the issuing authority AND by the table', async () => {
    const c = await db();
    await c.query('SET ROLE padeltrainer_abc27_owner');
    // The authority refuses before it writes anything.
    await expect(c.query(
      `SELECT * FROM public.abc27_a_authorize_transition(
         'dispatch_outcome', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
         'court', gen_random_uuid(), 'begin_dispatch', 'leased', 'leased')`))
      .rejects.toThrow(/is not a transport subject domain/);
    // NULL is refused by the same door, and separately from the "no subject" refusal below.
    await expect(c.query(
      `SELECT * FROM public.abc27_a_authorize_transition(
         'dispatch_outcome', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
         NULL, gen_random_uuid(), 'begin_dispatch', 'leased', 'leased')`))
      .rejects.toThrow(/is not a transport subject domain/);
    // A KNOWN domain with no subject is refused too — `subject_uuid` is NOT NULL, and the authority
    // says so in its own words rather than letting the constraint speak for it.
    await expect(c.query(
      `SELECT * FROM public.abc27_a_authorize_transition(
         'dispatch_outcome', gen_random_uuid(), gen_random_uuid(), NULL,
         'priority_claim', gen_random_uuid(), 'begin_dispatch', 'leased', 'leased')`))
      .rejects.toThrow(/has no subject/);
  });

  it('CONTAINMENT — two subjects on one row are unrepresentable, in both directions', async () => {
    const c = await db();
    const def = (await c.query(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conrelid = 'public.notification_outbox'::regclass
          AND conname = 'chk_notification_outbox_transport_subject_exclusive'`)).rows[0].d;
    // `<= 1`, NOT `= 1`: every non-D7 notification carries neither, and this constraint is not the
    // place that decides a protected row must carry one — the per-event shape CHECKs are.
    expect(def).toContain('num_nonnulls');
    expect(def).toContain('<= 1');

    // The invitation shape requires a claim and FORBIDS a snapshot recipient. That second half is
    // what stops an invitation being anti-join-visible as a member of the round it names.
    const inv = (await c.query(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conrelid = 'public.notification_outbox'::regclass
          AND conname = 'chk_notification_outbox_priority_claim_invite_shape'`)).rows[0].d;
    expect(inv).toContain('related_slot_priority_claim_id IS NOT NULL');
    expect(inv).toContain('related_rebook_round_recipient_id IS NULL');

    // AND THE MEMBER-OPEN SHAPE IS UNTOUCHED. The owner's FROZEN_SUITE allowance covers the
    // `uq_rrtt` and `chk_rrot` pins only; this one had to be left exactly as ABC-27 wrote it, and
    // the exclusivity above is what achieves the same guarantee without editing it.
    const mem = (await c.query(
      `SELECT convalidated, pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conrelid = 'public.notification_outbox'::regclass
          AND conname = 'chk_notification_outbox_rebook_member_open_shape'`)).rows[0];
    expect(mem.convalidated, 'the member-open shape is still validated').toBe(true);
    expect(mem.d).toContain('num_nonnulls(recipient_guest_player_id, recipient_user_id) = 1');
  });

  it('NO FOREIGN KEY on any subject column — a guest merge cannot cascade or lock', async () => {
    const c = await db();
    // `PRIORITY_CLAIM=NO_FOREIGN_KEY_THAT_REINTRODUCES_THE_GUEST_MERGE_DELETE_OR_UNMANIFESTED_LOCK_EDGE`.
    // Read from the catalog, and read as "no FK whose constrained column set INCLUDES the subject" —
    // a composite FK with the subject as one leg is exactly the edge that made
    // `related_rebook_round_recipient_id` unusable for a claim, and a naive single-column check
    // would have said that column was FK-free too.
    const { rows } = await c.query(`
      SELECT c.conname, c.conrelid::regclass::text AS rel, a.attname
        FROM pg_constraint c
        JOIN unnest(c.conkey) AS k(attnum) ON true
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.contype = 'f'
         AND ((c.conrelid = 'public.notification_outbox'::regclass
               AND a.attname = 'related_slot_priority_claim_id')
           OR (c.conrelid = 'public.rebook_round_transport_transitions'::regclass
               AND a.attname IN ('subject_uuid', 'subject_domain'))
           OR (c.conrelid = 'public.rebook_round_operation_targets'::regclass
               AND a.attname IN ('target_uuid', 'target_domain')))`);
    expect(rows, 'no foreign key may constrain a transport subject').toEqual([]);
  });

  it('COMPATIBILITY — the reshaped key and the widened target arms kept every existing arm', async () => {
    const c = await db();
    const uq = (await c.query(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conrelid = 'public.rebook_round_transport_transitions'::regclass
          AND conname = 'uq_rrtt_live_transition'`)).rows[0].d;
    // STILL `NULLS NOT DISTINCT`, which is what makes a NULL from/to state collide rather than
    // silently permitting a second live grant. That is ABC-27's property and the reshape kept it.
    expect(uq).toContain('NULLS NOT DISTINCT');
    expect(uq).toContain('subject_domain');
    expect(uq).toContain('subject_uuid');

    const kind = (await c.query(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conrelid = 'public.rebook_round_operation_targets'::regclass
          AND conname = 'chk_rrot_kind'`)).rows[0].d;
    for (const arm of ['cycle', 'snapshot_member', 'subject', 'slot', 'priority_claim']) {
      expect(kind, `chk_rrot_kind retains the ${arm} arm`).toContain(`'${arm}'`);
    }
    const dom = (await c.query(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conrelid = 'public.rebook_round_operation_targets'::regclass
          AND conname = 'chk_rrot_domain_matches_kind'`)).rows[0].d;
    // The person vocabulary is still the source for the `subject` arm — the claim did NOT go in there.
    expect(dom).toContain('rebook_round_subject_types');
    expect(dom).toContain('priority_claim');
    const persons = (await c.query(`SELECT public.rebook_round_subject_types() AS d`)).rows[0].d;
    expect(persons, 'the PERSON vocabulary is unchanged').toEqual(['profile', 'auth_user', 'guest']);
  });

  it('PRIVILEGE SURFACE — the new vocabularies are owner-only, and the machine surface is unchanged', async () => {
    const c = await db();
    // `SECURITY=...NO_NEW_RUNTIME_ROLE_OR_PERMISSION_CLASS`. Each vocabulary is owned by the ONE
    // domain that uses it, which is ABC-27's own rule for avoiding a cross-owner EXECUTE grant.
    const { rows } = await c.query(`
      SELECT p.proname, p.proowner::regrole::name AS owner,
             (SELECT c2.relowner::regrole::name FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
               WHERE n2.nspname='public' AND c2.relname = CASE p.proname
                 WHEN 'rebook_round_transport_subject_domains' THEN 'rebook_round_transport_transitions'
                 ELSE 'notification_outbox' END) AS expected_owner
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public'
         AND p.proname IN ('rebook_round_transport_subject_domains',
                           'rebook_round_transport_subject_domain_for_event')
       ORDER BY p.proname`);
    expect(rows.length, 'both vocabulary functions exist').toBe(2);
    for (const r of rows) {
      expect(r.owner, `${r.proname} is owned by the domain that uses it`).toBe(r.expected_owner);
    }

    // AND NO RUNTIME ROLE CAN EXECUTE EITHER. `postgres` is deliberately absent: it is a superuser,
    // so it answers `true` for everything and a row of unconditional `true` carries no information.
    const grid = await c.query(`
      SELECT p.proname, r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') AS can
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) AS r(role)
       WHERE n.nspname='public'
         AND p.proname IN ('rebook_round_transport_subject_domains',
                           'rebook_round_transport_subject_domain_for_event')`);
    expect(grid.rows.filter((x) => x.can), 'no runtime role may execute a transport vocabulary')
      .toEqual([]);

    // THE MACHINE SURFACE, BY NAME RATHER THAN BY COUNT. The subject generalization re-issued
    // entrypoints and DROPPED one Domain-A routine outright, and a count alone would have been
    // satisfied by a swap — one surface lost and another gained nets to the same number.
    //
    // `abc27_a_authorize_transition` is the reason this matters: it was dropped and re-created, and
    // if the re-creation had left the default `PUBLIC=X` in place instead of replaying the captured
    // ACL, `service_role` would reach a SECURITY DEFINER that writes the grant tables.
    const surface = (await c.query(`
      SELECT p.proname
        FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname = 'public'
         AND has_function_privilege('service_role', p.oid, 'EXECUTE')
         AND (p.proname LIKE 'rebook_%' OR p.proname LIKE 'abc27_%'
              OR p.proname = 'enqueue_notification')
       ORDER BY p.proname`)).rows.map((r) => r.proname as string);
    //
    // TWELVE, and the extra three are the point. `rebook_claims_needing_auto_reminder`,
    // `rebook_group_apply` and `rebook_group_manage` are LEGACY rebook surfaces, outside the D7
    // manifest entirely. They are pinned here anyway: a list restricted to the nine would go on
    // passing while a grant appeared next door on a function that touches the same product tables.
    //
    // `rebook_member_open_dispatch_status(uuid)` is deliberately ABSENT — only the capability
    // variant is machine-reachable. This release widened both, and widening a function the machine
    // role cannot call does not make it callable; that is asserted here rather than assumed.
    expect(surface, 'the service-role machine surface is exactly these entrypoints').toEqual([
      'enqueue_notification',
      'rebook_claims_needing_auto_reminder',
      'rebook_group_apply',
      'rebook_group_manage',
      'rebook_member_open_begin_dispatch',
      'rebook_member_open_claim_batch',
      'rebook_member_open_close_unresolved',
      'rebook_member_open_dispatch_status_by_capability',
      'rebook_member_open_pre_dispatch_resolve',
      'rebook_member_open_record_dispatch_outcome',
      'rebook_member_open_recover_expired_leases',
      'rebook_round_materialize',
    ]);
    // AND NO `abc27_a_*` ROUTINE IS AMONG THEM. Domain A is private by construction; the drop and
    // re-create above is the one event in this release that could have changed that.
    expect(surface.filter((n) => n.startsWith('abc27_')),
      'no Domain-A routine may be reachable by the machine role').toEqual([]);

    // THE CROSS-TENANT CHECK IS SERIALIZED. `IF EXISTS` is not ordered against the later INSERT and
    // the real unique key is tenant-scoped, so two concurrent enqueues under two academies could
    // both pass and both commit. A transaction advisory lock on the CLAIM makes the pair one
    // decision. Asserted from the installed body because the property is concurrency-only.
    const core = (await c.query(
      `SELECT pg_get_functiondef(to_regprocedure(
         'public.rebook_priority_claim_invite_enqueue_core(uuid,uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid)')) AS d`)).rows[0].d as string;
    expect(core, 'the claim is locked before the cross-tenant check')
      .toContain('pg_advisory_xact_lock');
    expect(core.indexOf('pg_advisory_xact_lock'), 'and the lock precedes the check it protects')
      .toBeLessThan(core.indexOf('tenant_academy_profile_id IS DISTINCT FROM p_academy'));

    // AND service_role STILL HOLDS NO OUTBOX DML. This is the invariant the whole D7 authority rests
    // on: every write goes through a definer that consumes a grant.
    const dml = await c.query(`
      SELECT priv FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) AS p(priv)
       WHERE has_table_privilege('service_role', 'public.notification_outbox', p.priv)`);
    expect(dml.rows, 'service_role holds zero notification_outbox DML').toEqual([]);
  });

  it('EVERY grant consumption path matches the FULL domain+uuid triple', async () => {
    // `PIN_WIDENING_PROOF=...PROVE_THE_FULL_DOMAIN_UUID_TRIPLE_ON_EVERY_GRANT_CONSUMPTION_PATH`.
    // Read from the installed bodies, because "we changed it" and "it is installed that way" are
    // different claims and only the second one protects anything.
    const c = await db();
    const bodyOf = async (sig: string) =>
      (await c.query(`SELECT pg_get_functiondef(to_regprocedure($1)) AS d`, [sig])).rows[0].d as string;

    // The two DELETE-the-grant paths tie the operation TARGET's domain to the GRANT's own domain,
    // so the two facts must agree rather than each being checked against a literal. A literal is
    // what made these member-open-only in the first place.
    for (const sig of [
      'public.abc27_a_consume_transition_grant(uuid,text,uuid,uuid,uuid,uuid,text,text,text)',
      'public.abc27_a_consume_delete_grant(uuid,uuid,uuid,uuid,uuid,text)',
    ]) {
      const d = await bodyOf(sig);
      expect(d, `${sig} matches the target domain against the grant's own`)
        .toContain('t.target_domain = g.subject_domain');
      expect(d, `${sig} matches the subject`).toContain('g.subject_uuid IS NOT DISTINCT FROM p_member');
      expect(d, `${sig} keeps no hardcoded target domain`)
        .not.toContain("t.target_domain = 'snapshot_member'");
    }

    // AND THE TRANSITION PATH MATCHES THE ROW'S OWN DOMAIN, not merely the grant's agreement with
    // itself. Round 1 of review found that gap: `target.domain = grant.domain` proves the grant is
    // internally consistent and nothing more, so a grant minted as `snapshot_member` over an
    // invitation's outbox id and claim id was accepted. The guard knows the row's event type and
    // now passes the domain it implies.
    const consume = await bodyOf('public.abc27_a_consume_transition_grant(uuid,text,uuid,uuid,uuid,uuid,text,text,text)');
    expect(consume, 'the transition consume matches the ROW domain the caller derived')
      .toContain('g.subject_domain = p_row_domain');
    const guard = await bodyOf('public.notification_outbox_round_ref_guard()');
    expect(guard, 'and the guard derives it from the row it is guarding')
      .toContain('rebook_round_transport_subject_domain_for_event(OLD.event_type)');
    // The DELETE path pins the literal instead: it requires a recipient decision, which an
    // invitation can never have, so parameterising it would suggest a reachability that is absent.
    const del = await bodyOf('public.abc27_a_consume_delete_grant(uuid,uuid,uuid,uuid,uuid,text)');
    expect(del, 'the delete path is member-open in the body, not only in a comment')
      .toContain("g.subject_domain = 'snapshot_member'");

    // The arm-stamp validator pins its domain to a LITERAL, and that is correct rather than lazy:
    // G-8 arming is member-open only, and saying so in the body means an invitation reaching it is
    // refused by the match instead of by luck.
    const arm = await bodyOf('public.abc27_a_validate_arm_stamp(uuid,uuid,uuid,uuid,text)');
    expect(arm, 'the arm-stamp validator matches the subject domain')
      .toContain("delg.subject_domain = 'snapshot_member'");
    expect(arm, 'the arm-stamp validator matches the subject')
      .toContain('delg.subject_uuid IS NOT DISTINCT FROM p_member');

    // AND THE ISSUING AUTHORITY WRITES THE SAME DOMAIN TO BOTH TABLES from one parameter, which is
    // what makes "they must agree" a tautology for a legitimate grant and a refusal for any other.
    const auth = await bodyOf('public.abc27_a_authorize_transition(text,uuid,uuid,uuid,text,uuid,text,text,text)');
    expect(auth).toContain('VALUES (v_op, p_subject_domain, p_subject_domain, p_member)');
    expect(auth).toContain('rebook_round_transport_subject_domains()');
  });

  it('AN INVITATION ROW IS HELD TO ITS CLAIM — refused on identity, refused across tenants', async () => {
    // BEHAVIOURAL, not textual. The catalog assertions in this block prove the branch is INSTALLED;
    // only an insert proves it is REACHED. A mutation that changed the branch condition to `false`
    // left every `toContain` in this file green, because the unreachable code is still in the body.
    const c = await db();
    const r = await seedRound(c, 1);
    const { claim, user } = r.recipients[0];

    const insert = (cols: Record<string, unknown>, key: string) => {
      const base: Record<string, unknown> = {
        event_type: 'rebook_priority_claim_invite',
        channel: 'email',
        idempotency_key: key,
        tenant_academy_profile_id: ACADEMY,
        related_rebook_round_id: r.round,
        related_slot_priority_claim_id: claim,
        ...cols,
      };
      const names = Object.keys(base);
      return c.query(
        `INSERT INTO public.notification_outbox (${names.join(',')})
         VALUES (${names.map((_, i) => `$${i + 1}`).join(',')})`,
        names.map((n) => base[n]));
    };

    // THE CLAIM'S OWN ACCOUNT IS ACCEPTED. Asserted first and on its own, because every refusal
    // below is only meaningful if the shape they differ from actually gets through.
    await expect(insert({ recipient_user_id: user }, 'ok-1')).resolves.toBeTruthy();

    // A DIFFERENT ACCOUNT IS NOT. This is the whole point of the branch: the shape constraint would
    // have accepted any account at all, so an invitation could name claim X and email person Y.
    await expect(insert({ recipient_user_id: '99999999-9999-4999-8999-999999999999' }, 'bad-1'))
      .rejects.toThrow(/does not carry that profile's own account/);

    // A GUEST RECIPIENT ON A PROFILE CLAIM IS NOT — the two identity kinds may not be swapped.
    await expect(insert({ recipient_guest_player_id: '88888888-8888-4888-8888-888888888888' }, 'bad-2'))
      .rejects.toThrow(/carries a guest recipient/);

    // A PERSON ID IS NOT. Mirrors member-open: U2 has supplied no trusted canonical person rule for
    // this event, so carrying one would be an identity nobody validated.
    await expect(insert({ recipient_user_id: user, recipient_person_id: user }, 'bad-3'))
      .rejects.toThrow(/may not carry a person id/);

    // ANOTHER TENANT'S CLAIM IS NOT — refused before any identity check runs, because
    // `d7_p_invite_recipient_snapshot` is fenced by academy and simply returns nothing.
    await expect(insert(
      { recipient_user_id: user, related_slot_priority_claim_id: '77777777-7777-4777-8777-777777777777' },
      'bad-4')).rejects.toThrow(/is not a claim of academy/);

    // AND A CLAIM REFERENCE ON AN EVENT THAT IS NOT AN INVITATION IS NOT. ABC-27 refuses a snapshot
    // reference on a foreign event for the same reason; this is that refusal's mirror image.
    await expect(c.query(
      `INSERT INTO public.notification_outbox
         (event_type, channel, idempotency_key, tenant_academy_profile_id, related_slot_priority_claim_id)
       VALUES ('invoice_due','email','bad-5',$1,$2)`, [ACADEMY, claim]))
      .rejects.toThrow(/only rebook_priority_claim_invite may reference a priority claim/);
  });

  it('THE GUARD enforces transport for EVERY protected subject, and stays member-open where it must', async () => {
    const c = await db();
    const def = (await c.query(
      `SELECT pg_get_functiondef(to_regprocedure('public.notification_outbox_round_ref_guard()')) AS d`)).rows[0].d;

    // NO BARE MEMBER-OPEN GATE ON OLD. Every one of those skipped the whole transport block —
    // grant consumption included — for any other event type. This is the assertion that would fail
    // if a later change reintroduced one.
    expect(def, 'no UPDATE/DELETE arm is gated on a bare member-open literal')
      .not.toContain("IF OLD.event_type = 'rebook_member_open_player'");
    expect(def, 'the transport arms consult the protected vocabulary')
      .toContain('rebook_round_protected_event_types');

    // THE MEMBER-OPEN INSERT VALIDATION IS UNTOUCHED, and the invitation has its OWN branch beside
    // it — not a widened one. `d7_p_invite_recipient_snapshot` is tenant-fenced by academy, so a row
    // naming another academy's claim is refused before any identity check runs.
    expect(def, 'the member-open INSERT validation survives')
      .toContain('abc27_a_validate_member_open_insert');
    expect(def, 'the INSERT branch is still member-open scoped')
      .toContain("IF NEW.event_type = 'rebook_member_open_player' THEN");
    expect(def, 'an invitation resolves its claim through the tenant-fenced bridge')
      .toContain('d7_p_invite_recipient_snapshot');
    expect(def, 'an invitation may not carry a person id')
      .toContain('a priority claim invitation may not carry a person id');
    expect(def, "a guest invitation carries the claim's own guest and no account")
      .toContain('a guest invitation carries the guest UUID only');

    // AND BOTH GRANT CONSUMPTION PATHS NOW NAME THE SUBJECT, not the snapshot recipient.
    expect(def, 'the transition grant is consumed against the row subject')
      .toContain('coalesce(OLD.related_rebook_round_recipient_id, OLD.related_slot_priority_claim_id)');

    // THE SYMMETRIC REFUSAL. ABC-27 refuses a snapshot reference on a non-member-open row; a claim
    // reference on a non-invitation row is the same defect wearing the other subject.
    expect(def, 'only an invitation may reference a priority claim')
      .toContain('only rebook_priority_claim_invite may reference a priority claim');
  });
});

describe('E-24 — the protected invitation enqueue, through the one machine entrypoint', () => {
  /** What one seeded recipient's drift cases need to reach: the row, its slot, its cycle, its person. */
  type SeedCtx = {
    claim: string; user: string; slot: string; profile: string;
    cycle: string; round: string; group: string; recipient: string;
    seriesFirst?: string; seriesMiddle?: string; seriesLast?: string;
    /** set by a `before` that re-keys the claim onto a guest, so the enqueue is called as one */
    guestId?: string;
  };

  const opened: pg.Client[] = [];
  const db = async (): Promise<pg.Client> => { const c = await freshDb(); opened.push(c); return c; };
  afterEach(async () => {
    while (opened.length) await opened.pop()!.end().catch(() => undefined);
  });

  /**
   * `seedRound` builds profiles for the MEMBER-OPEN path, which routes through
   * `notification_contacts`. An invitation does not: it routes the way the shipped sender does, from
   * `profiles.email` or `guest_players.email`. That is not a shortcut around consent — a guest has
   * no `notification_contacts` row at all (no `user_id` to hang one on), so a contacts-only rule
   * would make every guest permanently unroutable, and inviting guests is the entire point.
   */
  const giveProfileEmails = async (c: pg.Client, r: { recipients: { profile: string }[] }) => {
    for (const x of r.recipients) {
      await c.query(`UPDATE public.profiles SET email = $2 WHERE id = $1`,
        [x.profile, `${x.profile}@example.test`]);
    }
  };

  /**
   * The facts a sender renders from, read the way the sender reads them.
   *
   * Every value comes back as canonical TEXT and goes back in as text — which is what the edge does
   * with an ISO timestamp. `::text` is fine HERE because the server casts it back to an instant
   * before comparing; it is forbidden only inside the DIGEST, where a session-timezone rendering
   * would change the value itself.
   */
  const renderedFacts = async (c: pg.Client, academy: string, claim: string) => (await c.query(
    `SELECT o.slot_id::text AS slot_id, o.player_id::text AS player_id,
            o.claim_token, o.rebook_group_id::text AS group_id,
            o.cyclus_id::text AS cyclus_id, o.cyclus_name,
            to_char(o.cycle_start_date, 'YYYY-MM-DD') AS cycle_start, o.payment_mode,
            o.group_sessions::text AS sessions, o.destination,
            to_char(o.price_per_session, 'FM999999999990.00') AS price,
            o.start_time::text AS start, o.end_time::text AS "end",
            o.priority_window_ends_at::text AS priority_ends,
            o.group_first_start::text AS first_start, o.group_last_start::text AS last_start
       FROM public.d7_p_invite_offer($1,$2) o`, [academy, claim])).rows[0] ?? null;

  /**
   * THE SAME FACTS, DERIVED INDEPENDENTLY — the sender's own reads, transcribed.
   *
   * `renderedFacts` above reads the server's contract, which makes it useless for one question: do
   * the two sides agree? A fixture that derives the caller's facts from the callee will agree by
   * construction no matter how far apart the real implementations drift — which is exactly how a
   * live `cyclus_name` mismatch survived five review rounds.
   *
   * So this reads what `send-priority-claim-invitation` reads, from the relations it reads them
   * from: the slot's own columns (INCLUDING its denormalized `cyclus_name`), the cycle's start date
   * and payment setting, the guest-first address, and the group aggregation over pending claims
   * keyed PAIR-EXACTLY — the scope `respond_to_priority_claim` books.
   */
  const senderFacts = async (c: pg.Client, claim: string) => (await c.query(
    `WITH sc AS (SELECT * FROM public.slot_priority_claims WHERE id = $1),
          s  AS (SELECT * FROM public.availability_slots WHERE id = (SELECT slot_id FROM sc)),
          cy AS (SELECT * FROM public.cycles WHERE id = (SELECT cyclus_id FROM s)),
          g  AS (SELECT count(*)::int AS sessions, min(s2.start_time) AS first_start,
                        max(s2.start_time) AS last_start
                   FROM public.slot_priority_claims gc
                   JOIN public.availability_slots s2 ON s2.id = gc.slot_id
                  WHERE gc.rebook_group_id = (SELECT rebook_group_id FROM sc)
                    AND gc.status = 'pending'
                    -- PAIR-EXACT, the scope respond_to_priority_claim books (owner decision).
                    AND gc.player_id       IS NOT DISTINCT FROM (SELECT player_id FROM sc)
                    AND gc.guest_player_id IS NOT DISTINCT FROM (SELECT guest_player_id FROM sc))
     SELECT (SELECT slot_id FROM sc)::text                                   AS slot_id,
            (SELECT player_id FROM sc)::text                                 AS player_id,
            (SELECT claim_token FROM sc)                                     AS claim_token,
            (SELECT rebook_group_id FROM sc)::text                           AS group_id,
            (SELECT cyclus_id FROM s)::text                                  AS cyclus_id,
            (SELECT cyclus_name FROM s)                                      AS cyclus_name,
            to_char((SELECT start_date FROM cy), 'YYYY-MM-DD')              AS cycle_start,
            CASE WHEN (SELECT settings ->> 'rebook_payment_mode' FROM cy) = 'upfront'
                 THEN 'upfront' ELSE '' END                                  AS payment_mode,
            CASE WHEN (SELECT rebook_group_id FROM sc) IS NULL THEN NULL
                 ELSE (SELECT sessions FROM g)::text END                     AS sessions,
            -- THE GUEST ARM GOES THROUGH THE REAL RPC, not a transcription of it: guestContactEmail
            -- reads own_email from resolve_guest_member_contacts, so calling anything else here
            -- would be re-deriving the very thing under test. The profile arm has no RPC -- the
            -- sender reads profiles.email and trims it, which is what this does.
            CASE WHEN (SELECT guest_player_id FROM sc) IS NOT NULL
                 THEN (SELECT nullif(public.d7_trim_ws(rc.own_email), '')
                         FROM public.resolve_guest_member_contacts(
                                ARRAY[(SELECT guest_player_id FROM sc)]) rc)
                 ELSE (SELECT nullif(public.d7_trim_ws(pr.email), '') FROM public.profiles pr
                        WHERE pr.id = (SELECT player_id FROM sc)) END        AS destination,
            -- Number(x).toFixed(2) transcribed: the sender echoes what it PRINTS.
            to_char((SELECT price_per_session FROM s), 'FM999999999990.00')  AS price,
            (SELECT start_time FROM s)::text                                 AS start,
            (SELECT end_time FROM s)::text                                   AS "end",
            (SELECT priority_window_ends_at FROM s)::text                    AS priority_ends,
            CASE WHEN (SELECT rebook_group_id FROM sc) IS NULL THEN NULL
                 ELSE (SELECT first_start FROM g)::text END                  AS first_start,
            CASE WHEN (SELECT rebook_group_id FROM sc) IS NULL THEN NULL
                 ELSE (SELECT last_start FROM g)::text END                   AS last_start`,
    [claim])).rows[0];

  /** Call the REAL entrypoint as the REAL machine role — the only path a sender has. */
  const enqueue = async (
    c: pg.Client,
    args: { academy?: string; claim: string; round?: string; user?: string | null;
            guest?: string | null; person?: string | null; payload?: Record<string, unknown>;
            rendered?: Record<string, unknown> | null },
  ) => {
    const academy = args.academy ?? ACADEMY;
    // The sender echoes what IT rendered from; a test may override one fact to model drift.
    const base = args.rendered === null ? undefined
      : { ...(await renderedFacts(c, academy, args.claim) ?? {}), ...(args.rendered ?? {}) };
    await c.query('SET ROLE service_role');
    try {
      return await c.query(
        `SELECT * FROM public.enqueue_notification(
           p_event_key => 'rebook_priority_claim_invite',
           p_recipient_person_id => $1, p_recipient_user_id => $2, p_recipient_guest_player_id => $3,
           p_tenant_academy_profile_id => $4, p_payload => $5::jsonb,
           p_related_rebook_round_id => $6, p_related_slot_priority_claim_id => $7)`,
        [args.person ?? null, args.user ?? null, args.guest ?? null, academy,
         JSON.stringify({
           subject: 'Jouw plek', html: '<p>hoi</p>',
           ...(base ? { d7_rendered: base } : {}),
           ...(args.payload ?? {}),
         }),
         args.round, args.claim]);
    } finally { await c.query('RESET ROLE'); }
  };

  it('ATOMIC — one statement produces the row AND its canonical transport state', async () => {
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];

    const out = await enqueue(c, { claim, round: r.round, user });
    expect(out.rows[0].status, 'a fresh invitation is queued, not skipped').toBe('pending');
    // THE KEY CARRIES CLAIM + ROUND + OFFER (owner decision A for the offer half). A changed offer
    // is genuinely a different message and may be sent; an unchanged one can never be sent twice.
    // The ROUND is there for a different reason: the guard consumes a transition grant against the
    // row's own `related_rebook_round_id`, so without it a claim re-captured by a later round
    // reached the older row and its restore could never be authorized.
    const offerDigest = (await c.query(
      `SELECT offer_digest FROM public.d7_p_invite_offer($1,$2)`, [ACADEMY, claim])).rows[0].offer_digest;
    expect(out.rows[0].idempotency_key).toBe(`priority-claim-invite:${claim}:${r.round}:${offerDigest}`);

    const row = (await c.query(
      `SELECT event_type, transport_state, lease_generation, request_hash, provider_idempotency_key,
              canonical_request_bytes, related_slot_priority_claim_id, related_rebook_round_recipient_id,
              recipient_user_id, recipient_guest_player_id, destination_normalized
         FROM public.notification_outbox WHERE id = $1`, [out.rows[0].outbox_id])).rows[0];

    // THE TRANSPORT STATE IS PRESENT ON THE ROW THAT WAS JUST CREATED. A row that existed for even
    // one statement without it would be invisible to the D7 claimer and excluded from the generic
    // ones — a permanently stranded invitation no janitor owns.
    expect(row.transport_state, 'queued at birth').toBe('queued');
    expect(row.lease_generation).toBe(0);
    expect(row.request_hash, 'the request identity is frozen at enqueue').not.toBeNull();
    expect(row.provider_idempotency_key)
      .toBe(`priority-claim-invite:${claim}:${r.round}:${offerDigest}`.slice(0, 256));

    // AND THE SUBJECT IS THE CLAIM, with the snapshot column explicitly empty — the two are mutually
    // exclusive by constraint, and this is the direction that proves an invitation is not a member.
    expect(row.related_slot_priority_claim_id).toBe(claim);
    expect(row.related_rebook_round_recipient_id).toBeNull();

    // THE FROZEN BYTES ARE THE MEMBER-OPEN CANONICALIZATION, field for field and in order. One
    // transport verifies one hash; two canonicalizations would be two contracts.
    expect(row.canonical_request_bytes).toBe(
      `{"from":"\\"PadelTrainer.ai\\" <noreply@app.padeltrainer.ai>","to":["${row.destination_normalized}"],`
      + `"subject":"Jouw plek","html":"<p>hoi</p>"}`);
    const digest = (await c.query(
      `SELECT sha256(convert_to($1,'UTF8')) = $2::bytea AS ok`,
      [row.canonical_request_bytes, row.request_hash])).rows[0].ok;
    expect(digest, 'the stored hash is the hash OF the stored bytes').toBe(true);
  });

  it('THE ENVELOPE IS THE PROVIDER REQUEST — branded display name, fixed address, validated reply-to', async () => {
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];

    const out = await enqueue(c, { claim, round: r.round, user, payload: {
      subject: 'Jouw plek', html: '<p>hoi</p>',
      from_name: 'RL Padel "Performance" <x>\u0007', reply_to: 'academy@example.test',
    } });
    const bytes = (await c.query(
      `SELECT canonical_request_bytes b, destination_normalized d FROM public.notification_outbox WHERE id=$1`,
      [out.rows[0].outbox_id])).rows[0];

    // THE DISPLAY NAME IS THE CALLER'S; THE ADDRESS IS NOT. Quotes, angle brackets, backslashes and
    // control characters are stripped, so a display name cannot close the phrase and forge an
    // address or inject a header — and no academy can send as another.
    expect(bytes.b).toBe(
      `{"from":"\\"RL Padel Performance x\\" <noreply@app.padeltrainer.ai>","to":["${bytes.d}"],`
      + `"subject":"Jouw plek","html":"<p>hoi</p>",`
      + `"reply_to":"academy@example.test",`
      + `"headers":{"List-Unsubscribe":"<mailto:academy@example.test?subject=Uitschrijven>"}}`);

    // AND A REPLY-TO THAT IS NOT AN ADDRESS IS REFUSED, rather than echoed into a header.
    const r2 = await seedRound(c, 1);
    await giveProfileEmails(c, r2);
    await expect(enqueue(c, { claim: r2.recipients[0].claim, round: r2.round, user: r2.recipients[0].user,
      payload: { subject: 's', html: '<p>h</p>', reply_to: 'not an address' } }))
      .rejects.toThrow(/reply_to .* is not an address/);
  });

  it('DURABLE IDEMPOTENCY — a second enqueue adds nothing, with no time bound', async () => {
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];

    const first = await enqueue(c, { claim, round: r.round, user });
    const again = await enqueue(c, { claim, round: r.round, user });

    // THE SAME ROW, REPORTED AS ALREADY ENQUEUED. This is the durable no-duplicate authority that
    // replaces reliance on the provider's 24-hour window: the row is the record and it never expires.
    expect(again.rows[0].status).toBe('skipped');
    expect(again.rows[0].skip_reason).toBe('already_enqueued');
    expect(again.rows[0].outbox_id).toBe(first.rows[0].outbox_id);
    expect((await c.query(
      `SELECT count(*)::int n FROM public.notification_outbox
        WHERE related_slot_priority_claim_id = $1`, [claim])).rows[0].n).toBe(1);
  });

  it('REFUSES before any write — foreign tenant, wrong identity, unrendered body', async () => {
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];
    const rows = async () => (await c.query(
      `SELECT count(*)::int n FROM public.notification_outbox
        WHERE event_type = 'rebook_priority_claim_invite'`)).rows[0].n;

    await expect(enqueue(c, { claim: '77777777-7777-4777-8777-777777777777', round: r.round, user }))
      .rejects.toThrow(/is not a claim of academy/);
    // AND THE TENANCY REFUSAL COMES FIRST, even when no round is supplied. Deriving the round before
    // proving the claim is this academy's would answer a foreign claim with "belongs to no rebook
    // round" — true, but the wrong refusal.
    await expect(enqueue(c, { claim: '77777777-7777-4777-8777-777777777777', round: undefined as unknown as string, user }))
      .rejects.toThrow(/is not a claim of academy/);
    await expect(enqueue(c, { claim, round: r.round, academy: '66666666-6666-4666-8666-666666666666', user }))
      .rejects.toThrow(/is not a claim of academy/);
    await expect(enqueue(c, { claim, round: r.round, user: '55555555-5555-4555-8555-555555555555' }))
      .rejects.toThrow(/does not carry that profile's own account/);
    await expect(enqueue(c, { claim, round: r.round, user, guest: '44444444-4444-4444-8444-444444444444' }))
      .rejects.toThrow(/does not carry that profile's own account/);
    await expect(enqueue(c, { claim, round: r.round, user, person: user }))
      .rejects.toThrow(/may not carry a person id/);
    await expect(enqueue(c, { claim, round: r.round, user, payload: { subject: 'x', html: '' } }))
      .rejects.toThrow(/without a rendered subject and html/);
    // AND THE BINDING IS MANDATORY: omitting the rendered facts is a refusal, not an exemption.
    // The previous version checked them only when they were supplied, and the helper omitted them.
    await expect(enqueue(c, { claim, round: r.round, user, rendered: null }))
      .rejects.toThrow(/without the facts it was rendered from/);

    // NOT ONE ROW, NOT ONE TRANSPORT STATE. `REFUSE_BEFORE_ANY_OUTBOX_OR_TRANSPORT_WRITE` is only
    // worth asserting as an absence, because a refusal that had already written would still throw.
    expect(await rows(), 'every refusal left the table untouched').toBe(0);
  });

  it('A GUEST ROUTES TO ITS OWN ADDRESS ONLY — never to the profile it is linked to', async () => {
    // THE RULE, TRACED THROUGH THE SHIPPED SENDER: it resolves a guest with `guestContactEmail`,
    // which reads `own_email` from `resolve_guest_member_contacts`, which ABC-16/17 reduced to the
    // guest's own trimmed address. There is no account fallback, deliberately — the sender's own
    // history records that a profile-first rule "mailed a child at the parent's inbox".
    //
    // A draft of the enqueue bridge used `guest ?? profile`, copied from `personContactEmail`, which
    // a DIFFERENT caller uses. Nothing failed: every other test here uses profile claims, so the
    // fallback was invisible. This is the case that sees it.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, profile } = r.recipients[0];

    const guest = (await c.query(
      `INSERT INTO public.guest_players(trainer_id, full_name, email, phone)
       VALUES ($1,'Kind zonder eigen adres','','')  RETURNING id`, [TRAINER])).rows[0].id;
    // The claim is now a GUEST claim that still names the linked profile — the exact shape a
    // fallback would route through.
    await c.query(
      `UPDATE public.slot_priority_claims SET guest_player_id = $2 WHERE id = $1`, [claim, guest]);

    // REFUSED, not delivered to the parent. The profile beside it has a perfectly good address.
    await expect(enqueue(c, { claim, round: r.round, guest }))
      .rejects.toThrow(/has no email address to route to/);
    expect((await c.query(
      `SELECT count(*)::int n FROM public.notification_outbox
        WHERE related_slot_priority_claim_id = $1`, [claim])).rows[0].n,
      'and nothing was written').toBe(0);
    // The profile's own address is still there, which is what makes this a fallback test rather
    // than an "everyone is unroutable" test.
    expect((await c.query(`SELECT email FROM public.profiles WHERE id=$1`, [profile])).rows[0].email)
      .toBeTruthy();

    // AND WITH ITS OWN ADDRESS IT ROUTES — to the guest, never to the profile.
    await c.query(`UPDATE public.guest_players SET email='kind@example.test' WHERE id=$1`, [guest]);
    const ok = await enqueue(c, { claim, round: r.round, guest });
    expect(ok.rows[0].status).toBe('pending');
    const row = (await c.query(
      `SELECT destination_normalized d, recipient_guest_player_id g, recipient_user_id u
         FROM public.notification_outbox WHERE id=$1`, [ok.rows[0].outbox_id])).rows[0];
    expect(row.d).toBe('kind@example.test');
    expect(row.g).toBe(guest);
    expect(row.u, 'a guest invitation carries no account').toBeNull();
  });

  it('A DECIDED CLAIM IS REFUSED — an invitation cannot contradict a decision', async () => {
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];
    await c.query(`UPDATE public.slot_priority_claims SET status='claimed' WHERE id=$1`, [claim]);
    await expect(enqueue(c, { claim, round: r.round, user })).rejects.toThrow(/no longer pending/);
  });

  it('THE ROUND IS DERIVED when the caller has none — and refused when the claim has none', async () => {
    // Three live callers send no round: the per-claim re-invite and the invite-everyone-on-this-slot
    // button in `PriorityClaimsSection`, and `notifyPriorityClaimsForSlots` from the bulk-copy
    // wizard. Demanding a round from them would have 400'd all three; reading the claim's round in
    // the EDGE would have crossed into a Domain-A relation that is not in the generated types. So
    // the database derives it, and this is the test that the derivation is actually wired.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];

    // NO `roundId` PASSED. `seedRound` writes the claim's capture record, which is what
    // `abc27_a_claim_round` reads.
    const facts = await renderedFacts(c, ACADEMY, claim);
    await c.query('SET ROLE service_role');
    const out = await c.query(
      `SELECT * FROM public.enqueue_notification(
         p_event_key => 'rebook_priority_claim_invite',
         p_recipient_user_id => $1, p_tenant_academy_profile_id => $2,
         p_payload => $3::jsonb, p_related_slot_priority_claim_id => $4)`,
      [user, ACADEMY, JSON.stringify({ subject: 's', html: '<p>h</p>', d7_rendered: facts }), claim]);
    await c.query('RESET ROLE');
    expect(out.rows[0].status).toBe('pending');
    expect((await c.query(
      `SELECT related_rebook_round_id FROM public.notification_outbox WHERE id=$1`,
      [out.rows[0].outbox_id])).rows[0].related_rebook_round_id,
      'the derived round is the one the claim was captured for').toBe(r.round);

    // AND A CLAIM THAT BELONGS TO NO ROUND IS REFUSED — never sent some other way.
    // A DIFFERENT slot: `uq_slot_priority_claims_slot_player` allows one claim per (slot, player),
    // so the orphan needs its own — which is also more honest, since a second claim on the same slot
    // is not what "a claim outside any round" looks like.
    const orphanSlot = await addSlot(c, r.cycle);
    const orphan = (await c.query(
      `INSERT INTO public.slot_priority_claims(slot_id, player_id, status)
       VALUES ($1,$2,'pending') RETURNING id`,
      [orphanSlot, r.recipients[0].profile])).rows[0].id;
    const orphanFacts = await renderedFacts(c, ACADEMY, orphan);
    await c.query('SET ROLE service_role');
    await expect(c.query(
      `SELECT * FROM public.enqueue_notification(
         p_event_key => 'rebook_priority_claim_invite',
         p_recipient_user_id => $1, p_tenant_academy_profile_id => $2,
         p_payload => $3::jsonb, p_related_slot_priority_claim_id => $4)`,
      [user, ACADEMY, JSON.stringify({ subject: 's', html: '<p>h</p>', d7_rendered: orphanFacts }), orphan]))
      .rejects.toThrow(/has no round this academy may invite it for/);
    await c.query('RESET ROLE');

    // ── A SUPPLIED ROUND IS RESOLVED, NOT TRUSTED ─────────────────────────────────────────
    //
    // Review round 1's P1: `coalesce(p_round, derived)` accepted any non-null UUID — not that it
    // belonged to the tenant, not that it was the round that captured this claim, not that it was
    // related to the claim at all. A manager could attribute an invitation to another academy's
    // round. The derivation test above cannot see this, because it never SUPPLIES a wrong one.
    const other = await seedRound(c, 1);
    await giveProfileEmails(c, other);
    // A real round, in the SAME academy, that simply did not capture this claim.
    await expect(enqueue(c, { claim, round: other.round, user }))
      .rejects.toThrow(/has no round this academy may invite it for/);
    // And a round-shaped UUID that is no round at all.
    await expect(enqueue(c, { claim, round: '33333333-3333-4333-8333-333333333333', user }))
      .rejects.toThrow(/has no round this academy may invite it for/);
    // The claim's OWN round is still accepted, so the refusals above are discrimination rather than
    // a blanket rejection of every supplied round.
    expect((await enqueue(c, { claim, round: r.round, user })).rows[0].skip_reason)
      .toBe('already_enqueued');

    // ── A CAPTURE THAT BELONGS TO ANOTHER ACADEMY IS A REFUSAL, NOT AN ABSENCE ────────────
    //
    // Review round 2's P1. Provenance was read for (claim, academy), so a claim captured by academy
    // B's round looked UNCAPTURED to academy A — and A's fallback then accepted any round of A's
    // own. The source table deliberately has no live claim FK, so that provenance survives a claim
    // moving between academies.
    // The capture table is APPEND-ONLY, so this is built the way it happens in life: a SECOND
    // academy captures the same claim, later. Its capture is then the most recent one.
    const B = '12121212-1212-4121-8121-121212121212';
    await c.query(
      `INSERT INTO public.academy_profiles(id,name) VALUES ($1,'other academy') ON CONFLICT DO NOTHING`, [B]);
    const bRound = (await c.query(
      `INSERT INTO public.rebook_rounds (academy_profile_id,label,priority_window_ends_at,member_window_ends_at)
       VALUES ($1,'other round',now()-interval '1 hour',now()+interval '7 days') RETURNING id`, [B])).rows[0].id;
    const bRecipient = (await c.query(
      `INSERT INTO public.rebook_round_recipients
         (rebook_round_id,academy_profile_id,recipient_player_profile_id,captured_at)
       VALUES ($1,$2,$3,clock_timestamp()) RETURNING id`,
      [bRound, B, r.recipients[0].profile])).rows[0].id;
    await c.query(
      `INSERT INTO public.rebook_round_recipient_claim_sources
         (rebook_round_recipient_id,rebook_round_id,academy_profile_id,source_claim_id,
          source_slot_id,source_cycle_id,claimed_player_profile_id,claim_status,captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',clock_timestamp() + interval '1 second')`,
      [bRecipient, bRound, B, claim, r.recipients[0].slot, r.cycle, r.recipients[0].profile]);

    // The claim's most recent capture now belongs to somebody else. Neither a supplied round nor the
    // derivation may hand it to this academy.
    await expect(enqueue(c, { claim, round: r.round, user }))
      .rejects.toThrow(/has no round this academy may invite it for/);
    await expect(enqueue(c, { claim, round: undefined as unknown as string, user }))
      .rejects.toThrow(/has no round this academy may invite it for/);

    // AND THE DERIVING READER IS NOT MACHINE-REACHABLE. It reads a Domain-A relation; only the
    // Domain-N writer that needs it may call it.
    expect((await c.query(
      `SELECT has_function_privilege('service_role', to_regprocedure('public.abc27_a_claim_round(uuid,uuid)'), 'EXECUTE') AS c`)).rows[0].c)
      .toBe(false);
  });

  it('NO FK — a guest merge deleting the claim leaves the invitation intact and resolvable', async () => {
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];
    const out = await enqueue(c, { claim, round: r.round, user });

    // The shipped merge path DELETES claims. If any subject column carried a foreign key, this would
    // either cascade into transport state or block on a lock the merge never manifested.
    await c.query(`DELETE FROM public.slot_priority_claims WHERE id = $1`, [claim]);

    const row = (await c.query(
      `SELECT transport_state, related_slot_priority_claim_id, request_hash IS NOT NULL AS has_hash
         FROM public.notification_outbox WHERE id = $1`, [out.rows[0].outbox_id])).rows[0];
    expect(row, 'the invitation survives its claim').toBeTruthy();
    expect(row.transport_state).toBe('queued');
    expect(row.related_slot_priority_claim_id).toBe(claim);
    expect(row.has_hash, 'and keeps the frozen request it was enqueued with').toBe(true);
  });

  it('END TO END — an invitation is claimed, resolved and AUTHORIZED to dispatch', async () => {
    // THE DEFECT THIS EXISTS FOR. Review round 1: the enqueue worked and nothing downstream did.
    // The worker calls `pre_dispatch_resolve` unconditionally and it was still member-open, so an
    // invitation got `refused` / `capability_mismatch`; past that, `begin_dispatch` handed a
    // priority-claim subject a NULL eligibility and refused again. Every test stopped at enqueue, so
    // nothing could notice.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];
    const out = await enqueue(c, { claim, round: r.round, user });

    const asMachine = async (sql: string, args: unknown[]) => {
      await c.query('SET ROLE service_role');
      try { return await c.query(sql, args); } finally { await c.query('RESET ROLE'); }
    };

    // ── CLAIMED, AND THE RETURNED SUBJECT IS NOT NULL ─────────────────────────────────────
    //
    // The worker decodes this column as a UUID and rejects the WHOLE batch if any row is malformed.
    // Before the correction the claimer still projected `related_rebook_round_recipient_id`, so ONE
    // invitation would have stranded every member-open row leased alongside it.
    const claimed = await asMachine(
      `SELECT * FROM public.rebook_member_open_claim_batch($1, $2)`, ['w-invite', 10]);
    const mine = claimed.rows.find((x) => x.outbox_id === out.rows[0].outbox_id);
    expect(mine, 'the invitation was leased').toBeTruthy();
    expect(mine.rebook_round_recipient_id, 'the claimer projects a NON-NULL subject')
      .toBe(claim);
    expect(mine.canonical_request_bytes, 'and hands over the frozen request').toBeTruthy();

    // ── RESOLVED: PROCEED ─────────────────────────────────────────────────────────────────
    const resolved = await asMachine(
      `SELECT * FROM public.rebook_member_open_pre_dispatch_resolve($1,$2,$3)`,
      [out.rows[0].outbox_id, 'w-invite', mine.lease_generation]);
    expect(resolved.rows[0].disposition, 'a pending claim proceeds').toBe('proceed');
    expect(resolved.rows[0].refusal_reason).toBeNull();

    // ── AUTHORIZED TO DISPATCH ────────────────────────────────────────────────────────────
    const begun = await asMachine(
      `SELECT * FROM public.rebook_member_open_begin_dispatch($1,$2,$3,$4,$5,$6,$7)`,
      [out.rows[0].outbox_id, 'w-invite', mine.lease_generation, mine.request_hash,
       mine.canonical_request_bytes, mine.provider_idempotency_key, mine.leased_from_state]);
    expect(begun.rows[0].outcome, 'the invitation is authorized to send').toBe('begun');
    expect(begun.rows[0].first_dispatch_at, 'and its uncertainty window is stamped').toBeTruthy();

    // AND THE GRANT WAS CONSUMED ON THE INVITATION'S OWN DOMAIN — the UPDATE went through the guard,
    // which passes the row's event-derived domain into the consume.
    expect((await c.query(
      `SELECT transport_state, dispatch_authorized_generation IS NOT NULL AS armed
         FROM public.notification_outbox WHERE id = $1`, [out.rows[0].outbox_id])).rows[0])
      .toMatchObject({ armed: true });
  });

  it('A CLOSED CYCLE IS NOT INVITED INTO — the seal is unchanged, but the round is over', async () => {
    // REVIEW ROUND 4 (P1). `cycles.status` was in neither the offer nor the gates. Closing a cycle
    // changes none of the eighteen sealed facts — it is not one of the offer's TERMS — so the
    // worker went on sending an actionable bearer invitation into a round the manager had closed,
    // and `respond_to_priority_claim`, which does not check the status either, booked the player in.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    await c.query(`UPDATE public.availability_slots SET cyclus_id = $2 WHERE id=$1`, [slot, r.cycle]);
    const out = await enqueue(c, { claim, round: r.round, user });
    const sealed = (await c.query(
      `SELECT o.offer_digest d FROM public.d7_p_invite_offer($1,$2) o`, [ACADEMY, claim])).rows[0].d;

    for (const status of ['closed', 'archived']) {
      await c.query(`UPDATE public.cycles SET status=$2 WHERE id=$1`, [r.cycle, status]);
      expect((await c.query(
        `SELECT o.offer_digest d FROM public.d7_p_invite_offer($1,$2) o`, [ACADEMY, claim])).rows[0].d,
        `${status} does not move the seal — which is exactly why a gate is needed`).toBe(sealed);
      expect((await c.query(
        `SELECT d.verdict, d.reason FROM public.rebook_priority_claim_invite_verdict($1) d`,
        [out.rows[0].outbox_id])).rows[0],
        `a ${status} cycle is not invited into`)
        .toMatchObject({ verdict: 'cancel', reason: 'cycle_not_open' });
    }

    // ...and re-opening makes it sendable again, so the gate is a GATE and not a one-way hold.
    await c.query(`UPDATE public.cycles SET status='open' WHERE id=$1`, [r.cycle]);
    expect((await c.query(
      `SELECT d.verdict FROM public.rebook_priority_claim_invite_verdict($1) d`,
      [out.rows[0].outbox_id])).rows[0].verdict).toBe('send');
  });

  it('AN ORPHAN CYCLE ID IS NOT AN OPEN CYCLE', async () => {
    // REVIEW ROUND 5 (P1). Keying the gate on "status is non-null and not open" let through a
    // session whose `cyclus_id` names a `cycles` row that does not exist: the lookup returns NULL,
    // so no gate fired and an actionable bearer link went out for a cycle whose lifecycle cannot be
    // established at all. Those rows are expressly possible — `availability_slots_cyclus_id_fkey`
    // was added NOT VALID, with historical orphans left for owner-run repair (`20260630120000`).
    //
    // The orphan is in place BEFORE the enqueue, because `cyclus_id` is a sealed fact: introducing
    // it afterwards is an `offer_changed`, which would hide the gate under a different cancel.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    // NOT VALID skips existing rows but still enforces every new write, so this row cannot be made
    // through the product today — only inherited. The replica role reproduces inherited data for
    // exactly one statement.
    await c.query(`SET session_replication_role = replica`);
    await c.query(`UPDATE public.availability_slots
       SET cyclus_id = '00000000-0000-4000-8000-0000000000cc' WHERE id=$1`, [slot]);
    await c.query(`SET session_replication_role = origin`);

    expect((await c.query(
      `SELECT o.cyclus_id::text AS id, o.cycle_status FROM public.d7_p_invite_offer($1,$2) o`,
      [ACADEMY, claim])).rows[0],
      'the session names a cycle that does not exist')
      .toMatchObject({ id: '00000000-0000-4000-8000-0000000000cc', cycle_status: null });

    // REFUSED BEFORE ANY WRITE, which is the convergence contract: the verdict holding a closed
    // cycle at dispatch is a backstop, but by then a row exists and the caller has stamped
    // `invited_at`, so the claim reads as handled while the only possible outcome is a hold.
    await expect(enqueue(c, { claim, round: r.round, user }),
      'a cycle whose lifecycle cannot be established is not invited into')
      .rejects.toThrow(/belongs to a cycle that is not open/);
    expect((await c.query(
      `SELECT count(*)::int n FROM public.notification_outbox WHERE related_slot_priority_claim_id=$1`,
      [claim])).rows[0].n, 'and no row was written').toBe(0);
    expect((await c.query(
      `SELECT invited_at FROM public.slot_priority_claims WHERE id=$1`, [claim])).rows[0].invited_at,
      'so nothing downstream can stamp it either').toBeNull();
  });

  it('AN INVITATION WITH NO DEADLINE AT ALL IS HELD, not recycled forever', async () => {
    // REVIEW ROUND 3 (P2). With neither a slot cutoff nor a member window the effective deadline is
    // NULL, the verdict used to answer `send`, and `begin_dispatch` refuses a null window outright.
    // The row was leased, judged sendable, refused, recovered — the janitor asking the same verdict
    // and hearing `send` again — and leased once more, burning a lease in every batch forever.
    const c = await db();
    const r = await seedRound(c, 1, { memberWindow: `NULL` });
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    await c.query(`UPDATE public.availability_slots
       SET priority_window_ends_at = NULL WHERE id=$1`, [slot]);
    const out = await enqueue(c, { claim, round: r.round, user });

    const resolved = await resolveOnce(c, out.rows[0].outbox_id, 'w-nodeadline');
    expect(resolved.disposition, 'a row that can never dispatch is not called sendable').toBe('held');
    expect(resolved.refusal_reason).toBe('no_effective_deadline');
    expect((await c.query(
      `SELECT transport_state FROM public.notification_outbox WHERE id=$1`,
      [out.rows[0].outbox_id])).rows[0].transport_state,
      'and it leaves the claimable set instead of cycling').toBe('configuration_hold');

    // ...and the janitor agrees, which is the half that made it a LOOP rather than a stall.
    await c.query('SET ROLE service_role');
    await c.query(`SELECT * FROM public.rebook_member_open_recover_expired_leases(50, 0)`);
    await c.query('RESET ROLE');
    expect((await c.query(
      `SELECT transport_state FROM public.notification_outbox WHERE id=$1`,
      [out.rows[0].outbox_id])).rows[0].transport_state).toBe('configuration_hold');
  });

  it('AN INFINITE DEADLINE IS NOT A DEADLINE EITHER', async () => {
    // REVIEW ROUND 4 (P3, test-quality): the case above covers NULL/NULL only, so deleting the
    // `infinity` half of the guard restored the send → window_invalid → recover loop with that test
    // still green. `infinity` is a legal `timestamptz` and a backfill can write one.
    const c = await db();
    const r = await seedRound(c, 1, { memberWindow: `'infinity'::timestamptz` });
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    await c.query(`UPDATE public.availability_slots
       SET priority_window_ends_at = 'infinity'::timestamptz WHERE id=$1`, [slot]);
    const out = await enqueue(c, { claim, round: r.round, user });
    expect((await c.query(
      `SELECT d.verdict, d.reason FROM public.rebook_priority_claim_invite_verdict($1) d`,
      [out.rows[0].outbox_id])).rows[0])
      .toMatchObject({ verdict: 'cancel', reason: 'no_effective_deadline' });
  });

  it('A CLAIM THAT NO LONGER EXISTS IS ANSWERED, not crashed on', async () => {
    // REVIEW ROUND 4 (P3, test-quality): the `claim_absent_or_foreign` arm had no behavioural
    // sensor at all — the test that deletes a claim never asked the resolver afterwards.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];
    const out = await enqueue(c, { claim, round: r.round, user });
    // The claim is deleted out from under the queued row — there is no FK from the outbox to it,
    // which is the whole point of the subject columns. The CAPTURE is append-only and stays, so
    // this is exactly the shipped shape: a guest merge deletes claims and leaves the history.
    await c.query(`DELETE FROM public.slot_priority_claims WHERE id=$1`, [claim]);
    expect((await c.query(
      `SELECT d.verdict, d.reason FROM public.rebook_priority_claim_invite_verdict($1) d`,
      [out.rows[0].outbox_id])).rows[0])
      .toMatchObject({ verdict: 'cancel', reason: 'claim_absent_or_foreign' });
    const held = await resolveOnce(c, out.rows[0].outbox_id, 'w-gone');
    expect(held.disposition, 'and the worker holds it rather than failing the batch').toBe('held');
    expect(held.refusal_reason).toBe('claim_absent_or_foreign');
  });

  it("THE FENCE IS THE PLAYER'S DEADLINE — an invitation begins under a round with no member window", async () => {
    // REVIEW ROUND 2 (P1). `begin_dispatch` fences on the ROUND's member window and refuses a NULL
    // or infinite one outright, BEFORE consulting the verdict. An invitation with a perfectly good
    // finite slot cutoff could therefore never begin: the resolver and the janitor would keep
    // calling it sendable, and the arming would keep refusing `window_invalid`, forever.
    const c = await db();
    const r = await seedRound(c, 1, { memberWindow: `NULL` });
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    await c.query(`UPDATE public.availability_slots
       SET priority_window_ends_at = now()+interval '2 days' WHERE id=$1`, [slot]);
    expect((await c.query(
      `SELECT s.member_window_ends_at FROM public.abc27_a_round_state($1) s`, [r.round])).rows[0]
      .member_window_ends_at, 'the round really has no member window').toBeNull();

    const out = await enqueue(c, { claim, round: r.round, user });
    await c.query('SET ROLE service_role');
    const leased = (await c.query(
      `SELECT * FROM public.rebook_member_open_claim_batch($1,$2)`, ['w-nowin', 10])).rows
      .find((x) => x.outbox_id === out.rows[0].outbox_id);
    await c.query(`SELECT * FROM public.rebook_member_open_pre_dispatch_resolve($1,$2,$3)`,
      [out.rows[0].outbox_id, 'w-nowin', leased.lease_generation]);
    const begun = (await c.query(
      `SELECT * FROM public.rebook_member_open_begin_dispatch($1,$2,$3,$4,$5,$6,$7)`,
      [out.rows[0].outbox_id, 'w-nowin', leased.lease_generation, leased.request_hash,
       leased.canonical_request_bytes, leased.provider_idempotency_key, leased.leased_from_state])).rows[0];
    await c.query('RESET ROLE');
    expect(begun.outcome, "the player's own deadline governs, so the arming proceeds").toBe('begun');
  });

  it("THE FENCE IS THE PLAYER'S DEADLINE — and it refuses once that deadline passes", async () => {
    // The other direction, and the reason the fence cannot simply be widened: with the round's
    // window wide open, an invitation whose PRIORITY window has closed must still refuse at the
    // arming — the last statement before the provider.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    await c.query(`UPDATE public.availability_slots
       SET priority_window_ends_at = now()+interval '2 days' WHERE id=$1`, [slot]);
    const out = await enqueue(c, { claim, round: r.round, user });

    await c.query('SET ROLE service_role');
    const leased = (await c.query(
      `SELECT * FROM public.rebook_member_open_claim_batch($1,$2)`, ['w-cross', 10])).rows
      .find((x) => x.outbox_id === out.rows[0].outbox_id);
    await c.query(`SELECT * FROM public.rebook_member_open_pre_dispatch_resolve($1,$2,$3)`,
      [out.rows[0].outbox_id, 'w-cross', leased.lease_generation]);
    await c.query('RESET ROLE');

    // The deadline passes between the resolve and the arming. The OFFER is untouched otherwise, and
    // the round's own window is still seven days out.
    await c.query(`UPDATE public.availability_slots
       SET priority_window_ends_at = now()-interval '1 minute' WHERE id=$1`, [slot]);
    await c.query('SET ROLE service_role');
    const begun = (await c.query(
      `SELECT * FROM public.rebook_member_open_begin_dispatch($1,$2,$3,$4,$5,$6,$7)`,
      [out.rows[0].outbox_id, 'w-cross', leased.lease_generation, leased.request_hash,
       leased.canonical_request_bytes, leased.provider_idempotency_key, leased.leased_from_state])).rows[0];
    await c.query('RESET ROLE');
    expect(begun.outcome, 'a deadline crossed before the arming is not authorized').toBe('refused');
    expect((await c.query(
      `SELECT first_dispatch_at FROM public.notification_outbox WHERE id=$1`,
      [out.rows[0].outbox_id])).rows[0].first_dispatch_at, 'and nothing was stamped').toBeNull();
  });

  it('THE VERDICT IS RE-ASKED AT begin_dispatch — a proceed does not survive the offer moving', async () => {
    // REVIEW ROUND 1 (P2, test-quality): three call sites ask the verdict, and only two of them had
    // a negative behaviour test. `begin_dispatch` is the LAST gate before the provider — it is the
    // statement that stamps `first_dispatch_at` and arms the generation — so a stale proceed here
    // is the one that actually sends. This isolates it: the resolver says proceed, the offer moves
    // AFTERWARDS, and the arming must refuse.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    const out = await enqueue(c, { claim, round: r.round, user });

    await c.query('SET ROLE service_role');
    const leased = (await c.query(
      `SELECT * FROM public.rebook_member_open_claim_batch($1,$2)`, ['w-recheck', 10])).rows
      .find((x) => x.outbox_id === out.rows[0].outbox_id);
    const resolved = (await c.query(
      `SELECT * FROM public.rebook_member_open_pre_dispatch_resolve($1,$2,$3)`,
      [out.rows[0].outbox_id, 'w-recheck', leased.lease_generation])).rows[0];
    await c.query('RESET ROLE');
    expect(resolved.disposition, 'the resolver authorized it on the offer as it stood').toBe('proceed');

    // The offer moves in the window between the two statements — the window a worker really has.
    await c.query(`UPDATE public.availability_slots
       SET start_time = start_time - interval '45 minutes' WHERE id=$1`, [slot]);

    await c.query('SET ROLE service_role');
    const begun = (await c.query(
      `SELECT * FROM public.rebook_member_open_begin_dispatch($1,$2,$3,$4,$5,$6,$7)`,
      [out.rows[0].outbox_id, 'w-recheck', leased.lease_generation, leased.request_hash,
       leased.canonical_request_bytes, leased.provider_idempotency_key, leased.leased_from_state])).rows[0];
    await c.query('RESET ROLE');

    expect(begun.outcome, 'the arming re-asks the verdict rather than trusting the resolver').toBe('refused');
    expect(begun.refusal_reason).toBe('ineligible');
    // AND NOTHING WAS ARMED. A refusal that still stamped the row would be a send waiting to happen.
    expect((await c.query(
      `SELECT first_dispatch_at, dispatch_authorized_generation
         FROM public.notification_outbox WHERE id=$1`, [out.rows[0].outbox_id])).rows[0])
      .toEqual({ first_dispatch_at: null, dispatch_authorized_generation: null });
  });

  it('AN ANSWERED CLAIM IS HELD, not sent and not silently dropped', async () => {
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];
    const out = await enqueue(c, { claim, round: r.round, user });

    // The player answers between enqueue and dispatch — the whole reason eligibility is re-read at
    // the linearization point rather than trusted from enqueue time.
    await c.query(`UPDATE public.slot_priority_claims SET status='claimed' WHERE id=$1`, [claim]);

    await c.query('SET ROLE service_role');
    const claimed = await c.query(
      `SELECT * FROM public.rebook_member_open_claim_batch($1, $2)`, ['w-held', 10]);
    const mine = claimed.rows.find((x) => x.outbox_id === out.rows[0].outbox_id);
    const resolved = await c.query(
      `SELECT * FROM public.rebook_member_open_pre_dispatch_resolve($1,$2,$3)`,
      [out.rows[0].outbox_id, 'w-held', mine.lease_generation]);
    await c.query('RESET ROLE');

    // HELD, not terminal. A terminal would write a `rebook_round_recipient_decisions` row, which an
    // invitation can never have; `held` retains the row, sends nothing and leaves it for a human.
    expect(resolved.rows[0].disposition).toBe('held');
    expect(resolved.rows[0].refusal_reason, 'the verdict names the specific cause').toBe('claim_answered');
    expect((await c.query(
      `SELECT count(*)::int n FROM public.rebook_round_recipient_decisions
        WHERE rebook_round_id = $1`, [r.round])).rows[0].n,
      'and no decision was written for it').toBe(0);

    // AND THE HOLD IS DURABLE. Review round 2: the first version returned `held` and wrote NOTHING,
    // so the row stayed `leased`; the worker returns on any non-proceed disposition assuming durable
    // state exists, and the janitor later restored the row to its exact claimable origin — so it
    // could be claimed, held and recovered forever, burning a lease in every batch.
    expect((await c.query(
      `SELECT transport_state FROM public.notification_outbox WHERE id=$1`,
      [out.rows[0].outbox_id])).rows[0].transport_state,
      'a held invitation leaves the claimable set').toBe('configuration_hold');
    // It is genuinely out of the set: a fresh claimer does not see it again.
    await c.query('SET ROLE service_role');
    const again = await c.query(
      `SELECT * FROM public.rebook_member_open_claim_batch($1, $2)`, ['w-held-2', 10]);
    await c.query('RESET ROLE');
    expect(again.rows.some((x) => x.outbox_id === out.rows[0].outbox_id),
      'and is not re-leased on the next pass').toBe(false);
  });

  it('A CLAIM THAT MOVED TO ANOTHER PERSON IS NOT SENT THE FROZEN INVITATION', async () => {
    // REVIEW ROUND 2's P1. The frozen bytes carry a claim token, which is a bearer credential. A
    // claim's `player_id`/`guest_player_id` are mutable by the slot owner while its status stays
    // `pending`, so re-reading only `still_pending` at dispatch authorized sending Bob's token to
    // Alice — the address the row was frozen for.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, profile } = r.recipients[0];
    const out = await enqueue(c, { claim, round: r.round, user });

    // The claim is repointed at somebody else, still pending. Its routing address moves with it.
    await c.query(`UPDATE public.profiles SET email = 'bob@example.test' WHERE id = $1`, [profile]);

    await c.query('SET ROLE service_role');
    const claimed = await c.query(
      `SELECT * FROM public.rebook_member_open_claim_batch($1, $2)`, ['w-moved', 10]);
    const mine = claimed.rows.find((x) => x.outbox_id === out.rows[0].outbox_id);
    const resolved = await c.query(
      `SELECT * FROM public.rebook_member_open_pre_dispatch_resolve($1,$2,$3)`,
      [out.rows[0].outbox_id, 'w-moved', mine.lease_generation]);
    await c.query('RESET ROLE');

    expect(resolved.rows[0].disposition, 'the frozen invitation is not authorized').toBe('held');
    expect(resolved.rows[0].refusal_reason,
      'a moved person is a CHANGED OFFER — the address it was frozen for is part of the promise')
      .toBe('offer_changed');
    expect((await c.query(
      `SELECT transport_state FROM public.notification_outbox WHERE id=$1`,
      [out.rows[0].outbox_id])).rows[0].transport_state).toBe('configuration_hold');
  });

  /** Enqueue, then claim and resolve as the worker does. Returns the resolver's row. */
  const resolveOnce = async (c: pg.Client, outboxId: string, worker: string) => {
    await c.query('SET ROLE service_role');
    try {
      const claimed = await c.query(
        `SELECT * FROM public.rebook_member_open_claim_batch($1, $2)`, [worker, 10]);
      const mine = claimed.rows.find((x) => x.outbox_id === outboxId);
      if (!mine) return null;
      return (await c.query(
        `SELECT * FROM public.rebook_member_open_pre_dispatch_resolve($1,$2,$3)`,
        [outboxId, worker, mine.lease_generation])).rows[0];
    } finally { await c.query('RESET ROLE'); }
  };

  it('AN INVITATION OBEYS THE CHANNEL KILL SWITCH', async () => {
    // REVIEW ROUND 3's P1. The early return skipped every shared operational gate, so a queued
    // invitation would have gone to the provider while the channel was killed.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const out = await enqueue(c, { claim: r.recipients[0].claim, round: r.round, user: r.recipients[0].user });
    await c.query(
      `INSERT INTO public.notification_channel_kill_switches(channel,reason,request_id)
       VALUES ('email','test kill', gen_random_uuid())`);

    const resolved = await resolveOnce(c, out.rows[0].outbox_id, 'w-kill');
    expect(resolved.disposition, 'a killed channel defers, it does not send').toBe('deferred');
    const row = (await c.query(
      `SELECT transport_state, locked_by, locked_at FROM public.notification_outbox WHERE id=$1`,
      [out.rows[0].outbox_id])).rows[0];
    expect(row.transport_state).toBe('channel_kill_deferred');
    // AND THE LEASE IS RELEASED. Round 3's P3: the first hold left `locked_by`/`locked_at` set, so
    // the row claimed forever to be owned by a worker that had finished.
    expect([row.locked_by, row.locked_at], 'a deferred row releases its lease').toEqual([null, null]);
  });

  it('AN INVITATION RESPECTS QUIET HOURS', async () => {
    const c = await freshDb({ quietHours: true });
    opened.push(c);
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const out = await enqueue(c, { claim: r.recipients[0].claim, round: r.round, user: r.recipients[0].user });
    const resolved = await resolveOnce(c, out.rows[0].outbox_id, 'w-quiet');
    expect(resolved.disposition, 'the event declares quiet_hours_respect').toBe('deferred');
    expect(resolved.defer_until, 'and names when it may go').toBeTruthy();
    expect((await c.query(
      `SELECT transport_state FROM public.notification_outbox WHERE id=$1`,
      [out.rows[0].outbox_id])).rows[0].transport_state).toBe('quiet_hours_deferred');
  });

  it('AN ADDRESS SUPPRESSED AFTER ENQUEUE IS NOT SENT TO', async () => {
    // Suppression was checked only at enqueue, and a durable row can wait a long time.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, profile } = r.recipients[0];
    const out = await enqueue(c, { claim, round: r.round, user });
    // `is_email_suppressed` reads the canonical `email_address_state.is_suppressed`.
    await c.query(
      `INSERT INTO public.email_address_state(email, state)
       VALUES (lower($1),'hard_bounced')
       ON CONFLICT (email) DO UPDATE SET state='hard_bounced'`, [`${profile}@example.test`]);
    expect((await c.query(`SELECT public.is_email_suppressed($1) AS s`,
      [`${profile}@example.test`])).rows[0].s, 'the fixture really suppresses').toBe(true);
    const resolved = await resolveOnce(c, out.rows[0].outbox_id, 'w-supp');
    expect(resolved.disposition).toBe('held');
    expect(resolved.refusal_reason).toBe('address_suppressed');
  });

  it('THE PERSON AND THE SLOT ARE PART OF IDENTITY, not just the address', async () => {
    // Round 3's P1s. Profile emails are NOT unique, so repointing the claim to another profile with
    // the SAME address passed every earlier check — and the live claim is what gets booked, so the
    // wrong person received a working token. The slot is the same story: the frozen HTML describes
    // one session and the token books whichever the claim now points at.
    const c = await db();
    const r = await seedRound(c, 2);
    await giveProfileEmails(c, r);
    const [a, b] = r.recipients;
    // Same address on both profiles — the address alone can no longer tell them apart.
    await c.query(`UPDATE public.profiles SET email='shared@example.test' WHERE id IN ($1,$2)`,
      [a.profile, b.profile]);
    const out = await enqueue(c, { claim: a.claim, round: r.round, user: a.user });

    await c.query(`UPDATE public.slot_priority_claims SET player_id=$2 WHERE id=$1`, [a.claim, b.profile]);
    const moved = await resolveOnce(c, out.rows[0].outbox_id, 'w-person');
    expect(moved.disposition, 'a claim that changed person is not sent the frozen invitation').toBe('held');

    // And the slot, on a fresh row.
    const c2 = await db();
    const r2 = await seedRound(c2, 1);
    await giveProfileEmails(c2, r2);
    const out2 = await enqueue(c2, { claim: r2.recipients[0].claim, round: r2.round, user: r2.recipients[0].user });
    const otherSlot = await addSlot(c2, r2.cycle);
    await c2.query(`UPDATE public.slot_priority_claims SET slot_id=$2 WHERE id=$1`,
      [r2.recipients[0].claim, otherSlot]);
    const movedSlot = await resolveOnce(c2, out2.rows[0].outbox_id, 'w-slot');
    expect(movedSlot.disposition, 'a claim that changed session is not sent the frozen invitation').toBe('held');
  });

  it('ONE ROW PER CLAIM ACROSS EVERY TENANT', async () => {
    // ROUND 3's P1. `uq_notification_outbox_idem` is `(channel, idempotency_key, tenant_scope_key)`,
    // and `tenant_scope_key` is GENERATED from the tenant columns. A claim that moves academies
    // therefore gets a NEW scope key and a SECOND row — and, past the provider's own time-bounded
    // window, a second provider send for the same claim. "Once per claim" was only once per claim
    // per tenant.
    //
    // THE WHOLE SCENARIO HAS TO BE BUILT, and a mutation run is what proved it: the claim must
    // actually move to B's slot AND be captured by B, or the tenant fence and then the round
    // resolver refuse first and the cross-tenant guard behind them is never reached.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, profile } = r.recipients[0];
    await enqueue(c, { claim, round: r.round, user });

    const B = '13131313-1313-4131-8131-131313131313';
    await c.query(
      `INSERT INTO public.academy_profiles(id,name) VALUES ($1,'tenant b') ON CONFLICT DO NOTHING`, [B]);
    const bCycle = (await c.query(
      `INSERT INTO public.cycles(id,owner_id,owner_type,type,name,status,start_date)
       VALUES (gen_random_uuid(),$1,'academy','cyclus','B','open',current_date) RETURNING id`, [B])).rows[0].id;
    const bSlot = (await c.query(
      `INSERT INTO public.availability_slots
         (id,trainer_id,academy_profile_id,source_cycle_id,start_time,end_time,max_participants,member_window_ends_at)
       VALUES (gen_random_uuid(),$1,$2,$3,
               now()+interval '9 days'+make_interval(hours => $4),
               now()+interval '9 days'+make_interval(hours => $4)+interval '1 hour',4,
               now()+interval '30 days') RETURNING id`, [TRAINER, B, bCycle, nextLane()])).rows[0].id;
    await c.query(`UPDATE public.slot_priority_claims SET slot_id=$2 WHERE id=$1`, [claim, bSlot]);
    const bRound = (await c.query(
      `INSERT INTO public.rebook_rounds (academy_profile_id,label,priority_window_ends_at,member_window_ends_at)
       VALUES ($1,'b round',now()-interval '1 hour',now()+interval '7 days') RETURNING id`, [B])).rows[0].id;
    const bRecip = (await c.query(
      `INSERT INTO public.rebook_round_recipients
         (rebook_round_id,academy_profile_id,recipient_player_profile_id,captured_at)
       VALUES ($1,$2,$3,clock_timestamp()) RETURNING id`, [bRound, B, profile])).rows[0].id;
    await c.query(
      `INSERT INTO public.rebook_round_recipient_claim_sources
         (rebook_round_recipient_id,rebook_round_id,academy_profile_id,source_claim_id,
          source_slot_id,source_cycle_id,claimed_player_profile_id,claim_status,captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',clock_timestamp() + interval '1 second')`,
      [bRecip, bRound, B, claim, bSlot, bCycle, profile]);

    // Everything B needs is now true — its own slot, its own newer capture, its own round — and the
    // ONLY thing standing between this claim and a second provider send is the cross-tenant guard.
    await expect(enqueue(c, { claim, round: bRound, academy: B, user }))
      .rejects.toThrow(/already enqueued under another tenant/);
    expect((await c.query(
      `SELECT count(*)::int n FROM public.notification_outbox
        WHERE related_slot_priority_claim_id = $1`, [claim])).rows[0].n,
      'still exactly one row for the claim').toBe(1);
  });

  it('A → B → A CONVERGES — the same offer\'s own row comes back, but only if it never left', async () => {
    // OWNER DECISION A: the key carries the offer digest, so a changed offer is genuinely a
    // different message and may be sent. Returning to the ORIGINAL offer finds that offer's own
    // row — cancelled when the offer moved — and it may be restored ONLY if it never reached the
    // provider. `RE_INVITATION_SAFETY` outranks the convenience of a manager pressing resend.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];

    // A
    const a = await enqueue(c, { claim, round: r.round, user });
    expect(a.rows[0].status).toBe('pending');
    const keyA = a.rows[0].idempotency_key as string;
    // Same offer again while it is queued: no second message.
    expect((await enqueue(c, { claim, round: r.round, user })).rows[0].skip_reason)
      .toBe('already_enqueued');

    // → B. The offer changes, so A's row is cancelled by the verdict and B is a new message.
    await c.query(`UPDATE public.availability_slots SET price_per_session = 42 WHERE id = $1`, [slot]);
    const held = await resolveOnce(c, a.rows[0].outbox_id, 'w-abа');
    expect(held.disposition, "A's row is cancelled once its offer moved").toBe('held');
    expect(held.refusal_reason).toBe('offer_changed');
    const b = await enqueue(c, { claim, round: r.round, user });
    expect(b.rows[0].status, 'B is a genuinely different message').toBe('pending');
    expect(b.rows[0].idempotency_key).not.toBe(keyA);

    // → A again. The original row is found by its own key and RESTORED, because it never dispatched.
    await c.query(`UPDATE public.availability_slots SET price_per_session = NULL WHERE id = $1`, [slot]);
    const again = await enqueue(c, { claim, round: r.round, user });
    expect(again.rows[0].skip_reason, "A's own row is restored, not duplicated").toBe('restored');
    expect(again.rows[0].outbox_id).toBe(a.rows[0].outbox_id);
    expect(again.rows[0].idempotency_key).toBe(keyA);
    expect((await c.query(
      `SELECT transport_state FROM public.notification_outbox WHERE id=$1`,
      [a.rows[0].outbox_id])).rows[0].transport_state).toBe('queued');

    // NO DUPLICATE PROVIDER EFFECT: two distinct offers, two rows, never three.
    expect((await c.query(
      `SELECT count(*)::int n FROM public.notification_outbox
        WHERE related_slot_priority_claim_id = $1`, [claim])).rows[0].n).toBe(2);
  });

  it('THE THREE HALVES OF "REACHED THE PROVIDER" — why the restore gate names all of them', async () => {
    // MUTATION EVIDENCE, and an honest one. Weakening ONLY `first_dispatch_at IS NULL` in the
    // restore gate changed nothing the suite could see, and the reason is not a missing sensor: the
    // two facts are written by the SAME statement and the generation may never be cleared, so no
    // legally reachable row can have one without the other. The mutant is unreachable, not missed.
    //
    // That is a claim about the schema, so it is asserted rather than assumed — otherwise the gate's
    // redundancy is cargo, and a future change that decoupled the two would silently make the
    // remaining conjunct the only guard.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];
    const out = await enqueue(c, { claim, round: r.round, user });

    await c.query('SET ROLE service_role');
    const leased = (await c.query(
      `SELECT * FROM public.rebook_member_open_claim_batch($1,$2)`, ['w-halves', 10])).rows
      .find((x) => x.outbox_id === out.rows[0].outbox_id);
    await c.query(`SELECT * FROM public.rebook_member_open_pre_dispatch_resolve($1,$2,$3)`,
      [out.rows[0].outbox_id, 'w-halves', leased.lease_generation]);
    await c.query(`SELECT * FROM public.rebook_member_open_begin_dispatch($1,$2,$3,$4,$5,$6,$7)`,
      [out.rows[0].outbox_id, 'w-halves', leased.lease_generation, leased.request_hash,
       leased.canonical_request_bytes, leased.provider_idempotency_key, leased.leased_from_state]);
    await c.query('RESET ROLE');

    // 1 · ONE STATEMENT SETS BOTH.
    expect((await c.query(
      `SELECT first_dispatch_at IS NOT NULL AS stamped,
              dispatch_authorized_generation IS NOT NULL AS armed
         FROM public.notification_outbox WHERE id=$1`, [out.rows[0].outbox_id])).rows[0],
      'arming a dispatch stamps both facts together')
      .toEqual({ stamped: true, armed: true });

    // 2 · AND THE GENERATION MAY NEVER BE CLEARED, so the pair cannot come apart afterwards.
    //
    // The first version of this asserted only that a direct outbox UPDATE throws — which it does
    // for a reason that has nothing to do with monotonicity: the D7 transport-grant guard refuses
    // any ungranted mutation first. Deleting ABC-27's monotonicity block outright would have left
    // that assertion green, and its companion checked only the text of an error message. Review
    // round 1 caught it. What is asserted now is the FUNCTIONAL RULE, from the installed trigger
    // function rather than from the migration file.
    const guardSrc = (await c.query(
      `SELECT string_agg(pg_get_functiondef(t.tgfoid), E'\n' ORDER BY t.tgname) AS d
         FROM pg_trigger t
        WHERE t.tgrelid = 'public.notification_outbox'::regclass AND NOT t.tgisinternal`)).rows[0].d as string;
    expect(guardSrc, 'an installed trigger compares the OLD and NEW generation')
      .toMatch(/OLD\.dispatch_authorized_generation IS NOT NULL[\s\S]{0,200}?NEW\.dispatch_authorized_generation IS NULL/);
    expect(guardSrc, 'and refuses a decrease as well as a clear')
      .toMatch(/NEW\.dispatch_authorized_generation < OLD\.dispatch_authorized_generation/);
    // ...and behaviourally, from a path that is NOT refused by the transport guard: an UPDATE that
    // presents no grant at all is refused for that reason, so the arming is checked afterwards to
    // show the attempt changed nothing either way.
    await expect(c.query(
      `UPDATE public.notification_outbox SET dispatch_authorized_generation = NULL WHERE id=$1`,
      [out.rows[0].outbox_id])).rejects.toThrow();
    expect((await c.query(
      `SELECT dispatch_authorized_generation IS NOT NULL AS armed
         FROM public.notification_outbox WHERE id=$1`, [out.rows[0].outbox_id])).rows[0].armed,
      'and the arming survived the attempt').toBe(true);

    // 3 · SO THE GATE'S REDUNDANCY IS DELIBERATE. It reads the way ABC-27's own delete guard reads
    // — `first_dispatch_at IS NOT NULL OR dispatch_authorized_generation IS NOT NULL` — because
    // "did a provider call possibly happen?" is one question with two witnesses.
    const core = (await c.query(
      `SELECT pg_get_functiondef(to_regprocedure(
         'public.rebook_priority_claim_invite_enqueue_core(uuid,uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid)')) AS d`))
      .rows[0].d as string;
    for (const witness of ['o.first_dispatch_at IS NULL', 'o.dispatch_authorized_generation IS NULL',
                           "o.status <> 'sent'"]) {
      expect(core, `the restore gate names ${witness}`).toContain(witness);
    }
  });

  it('A ROW THAT REACHED THE PROVIDER IS NEVER REACTIVATED', async () => {
    // `RE_INVITATION_SAFETY`. The restore above is only safe because the row never dispatched. A row
    // that was authorized, sent, or left ambiguous must never come back automatically — that is the
    // ambiguous-provider-send rule, and it does not bend for a resend button.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    const a = await enqueue(c, { claim, round: r.round, user });

    // REACHED THE PROVIDER THE REAL WAY. A direct UPDATE is refused by the outbox guard — "a D7
    // mutation must PRESENT its exact transition grant id and action" — which is itself the reason
    // this state can only be produced by the machine.
    await c.query('SET ROLE service_role');
    const leased = (await c.query(
      `SELECT * FROM public.rebook_member_open_claim_batch($1, $2)`, ['w-sent', 10])).rows
      .find((x) => x.outbox_id === a.rows[0].outbox_id);
    await c.query(`SELECT * FROM public.rebook_member_open_pre_dispatch_resolve($1,$2,$3)`,
      [a.rows[0].outbox_id, 'w-sent', leased.lease_generation]);
    const begun = await c.query(
      `SELECT * FROM public.rebook_member_open_begin_dispatch($1,$2,$3,$4,$5,$6,$7)`,
      [a.rows[0].outbox_id, 'w-sent', leased.lease_generation, leased.request_hash,
       leased.canonical_request_bytes, leased.provider_idempotency_key, leased.leased_from_state]);
    await c.query('RESET ROLE');
    expect(begun.rows[0].outcome, 'it really was authorized to dispatch').toBe('begun');

    // Now the offer moves, so the verdict cancels it — with `first_dispatch_at` already stamped.
    await c.query(`UPDATE public.availability_slots SET price_per_session = 7 WHERE id = $1`, [slot]);
    await c.query('SET ROLE service_role');
    const held = await c.query(
      `SELECT * FROM public.rebook_member_open_pre_dispatch_resolve($1,$2,$3)`,
      [a.rows[0].outbox_id, 'w-sent', leased.lease_generation]);
    await c.query('RESET ROLE');
    expect(held.rows[0].disposition).toBe('held');
    // Back to the original offer: the key matches the row that DID dispatch.
    await c.query(`UPDATE public.availability_slots SET price_per_session = NULL WHERE id = $1`, [slot]);

    const again = await enqueue(c, { claim, round: r.round, user });
    expect(again.rows[0].skip_reason, 'a dispatched row is surfaced, never restored')
      .toBe('existing_row_not_sendable');
    expect((await c.query(
      `SELECT transport_state FROM public.notification_outbox WHERE id=$1`,
      [a.rows[0].outbox_id])).rows[0].transport_state,
      'and it stays exactly where it was').toBe('configuration_hold');
  });

  it('THE MACHINE ROLE REACHES THE ENTRYPOINT AND NOTHING BELOW IT', async () => {
    const c = await db();
    // The private core is a WRITER, not an entrypoint. If this ever became callable, a sender could
    // mint a transport row without going through the branch that validates the claim.
    for (const priv of [
      'public.rebook_priority_claim_invite_enqueue_core(uuid,uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid)',
      'public.d7_p_invite_contact(uuid,uuid)',
    ]) {
      const can = (await c.query(
        `SELECT has_function_privilege('service_role', to_regprocedure($1), 'EXECUTE') AS c`, [priv])).rows[0].c;
      expect(can, `${priv} must not be machine-reachable`).toBe(false);
    }
    // And the generic email claimer still cannot see an invitation, so the D7 machine is the only
    // thing that will ever dispatch one.
    const claimer = (await c.query(
      `SELECT pg_get_functiondef(to_regprocedure('public.claim_notification_outbox_batch(text,text,int,int)')) AS d`)).rows[0].d;
    expect(claimer, 'the generic claimer excludes every protected type')
      .toContain('rebook_round_protected_event_types');
  });

  // ══ EVERY PROMISED FACT IS DISPATCH IDENTITY ══════════════════════════════════════════════
  //
  // Round 5's P1-2 and P1-3 were the same defect twice: the fingerprint covered four facts while
  // the message promised a dozen, so any of the other eight could move between enqueue and dispatch
  // and the frozen bytes would still be sent — a stale price, a dead link, the wrong series.
  //
  // The sealed contract answers that by making the digest the WHOLE offer, and this sweep is what
  // makes that claim checkable rather than asserted. Each case moves EXACTLY ONE source fact after
  // the enqueue and requires the row to be held. A test per fact, not a test of the digest, because
  // a digest that silently stopped covering one column would still pass a whole-digest test.
  //
  // The control at the end is load-bearing: the sweep proves the gate FIRES, and the control proves
  // it fires ON THE DRIFT rather than on the fixture.
  /**
   * Four sessions in one group for one person: an early sibling, the claim's own session, a middle
   * sibling and a late one. The claim sits INSIDE the range, so moving either end or removing the
   * middle changes exactly one of the three series facts.
   */
  const buildSeries = async (c: pg.Client, x: SeedCtx) => {
    const sib = async (days: string) => {
      const slot = (await c.query(`INSERT INTO public.availability_slots
        (id,trainer_id,academy_profile_id,source_cycle_id,start_time,end_time,max_participants,member_window_ends_at)
        VALUES (gen_random_uuid(),$1,$2,$3,
                now()+$4::interval+make_interval(hours => $5),
                now()+$4::interval+make_interval(hours => $5)+interval '1 hour',4,
                now()+interval '30 days') RETURNING id`, [TRAINER, ACADEMY, x.cycle, days, nextLane()])).rows[0].id;
      const id = (await c.query(
        `INSERT INTO public.slot_priority_claims(slot_id,player_id,status,rebook_group_id)
         VALUES ($1,$2,'pending',$3) RETURNING id`, [slot, x.profile, x.group])).rows[0].id as string;
      // CAPTURED, as the materializer captures every claim it creates. Without this the sibling has
      // no provenance, and the enqueue's birth-coherence check refuses it — which matters now that
      // the SERIES LEADER is what gets enqueued, and the leader is a sibling.
      await c.query(`INSERT INTO public.rebook_round_recipient_claim_sources
        (rebook_round_recipient_id,rebook_round_id,academy_profile_id,source_claim_id,
         source_slot_id,source_cycle_id,claimed_player_profile_id,claim_status,captured_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',clock_timestamp())`,
      [x.recipient, x.round, ACADEMY, id, slot, x.cycle, x.profile]);
      return id;
    };
    await c.query(`UPDATE public.slot_priority_claims SET rebook_group_id=$2 WHERE id=$1`, [x.claim, x.group]);
    x.seriesFirst  = await sib('1 day');    // earlier than the claim's own session (2 days)
    x.seriesMiddle = await sib('5 days');
    x.seriesLast   = await sib('9 days');
  };

  /** A guest sharing this profile's exact address — the address cannot tell the two apart. */
  const twinGuest = async (c: pg.Client, x: SeedCtx, name = 'Twin Guest') => {
    const email = (await c.query(`SELECT email FROM public.profiles WHERE id=$1`, [x.profile])).rows[0].email;
    return (await c.query(
      `INSERT INTO public.guest_players(academy_profile_id, full_name, email)
       VALUES ($1,$2,$3) RETURNING id`, [ACADEMY, name, email])).rows[0].id as string;
  };

  const offerFacts: Array<{
    fact: string;
    why: string;
    before?: (c: pg.Client, x: SeedCtx) => Promise<void>;
    drift: (c: pg.Client, x: SeedCtx) => Promise<void>;
  }> = [
    {
      fact: 'the claim token',
      why: 'a rotated token is a DEAD LINK — the mail arrives and the button does nothing',
      drift: async (c, x) => { await c.query(
        `UPDATE public.slot_priority_claims SET claim_token = encode(gen_random_bytes(16),'hex') WHERE id=$1`,
        [x.claim]); },
    },
    {
      fact: 'the session start',
      why: 'the mail states the time; a moved session invites the player to an hour that no longer exists',
      // EARLIER, not later: the seeded session is exactly an hour long, and pushing its start past
      // its end violates `availability_slots_time_order_check` — the fixture would then fail for a
      // reason that has nothing to do with the digest.
      drift: async (c, x) => { await c.query(
        `UPDATE public.availability_slots SET start_time = start_time - interval '30 minutes' WHERE id=$1`, [x.slot]); },
    },
    {
      fact: 'the session end',
      why: 'the mail states the duration',
      drift: async (c, x) => { await c.query(
        `UPDATE public.availability_slots SET end_time = end_time + interval '30 minutes' WHERE id=$1`, [x.slot]); },
    },
    {
      fact: 'the price',
      why: 'the mail quotes a price and the claim button accepts it — a changed price is a changed contract',
      before: async (c, x) => { await c.query(
        `UPDATE public.availability_slots SET price_per_session = 20.00 WHERE id=$1`, [x.slot]); },
      drift: async (c, x) => { await c.query(
        `UPDATE public.availability_slots SET price_per_session = 25.00 WHERE id=$1`, [x.slot]); },
    },
    {
      fact: 'the response deadline',
      why: 'the mail states how long the player has',
      before: async (c, x) => { await c.query(
        `UPDATE public.availability_slots SET priority_window_ends_at = now()+interval '2 days' WHERE id=$1`, [x.slot]); },
      drift: async (c, x) => { await c.query(
        `UPDATE public.availability_slots SET priority_window_ends_at = now()+interval '3 days' WHERE id=$1`, [x.slot]); },
    },
    {
      fact: 'the cycle name',
      why: 'the mail names the cycle the player is being invited back into — and it prints the SESSION\'s '
         + 'own label, `availability_slots.cyclus_name`, not the cycle row\'s name',
      before: async (c, x) => { await c.query(
        `UPDATE public.availability_slots SET cyclus_id = $2, cyclus_name = 'Najaar 2026' WHERE id=$1`,
        [x.slot, x.cycle]); },
      drift: async (c, x) => { await c.query(
        `UPDATE public.availability_slots SET cyclus_name = 'Najaar 2026 (herfst)' WHERE id=$1`, [x.slot]); },
    },
    {
      fact: 'the cycle start date',
      why: 'the mail states when the cycle begins',
      before: async (c, x) => { await c.query(
        `UPDATE public.availability_slots SET cyclus_id = $2 WHERE id=$1`, [x.slot, x.cycle]); },
      drift: async (c, x) => { await c.query(
        `UPDATE public.cycles SET start_date = start_date + 7 WHERE id=$1`, [x.cycle]); },
    },
    {
      fact: 'the payment mode',
      why: 'the mail says either PAY NOW or pay when the cycle starts, and the two are not the same offer',
      before: async (c, x) => { await c.query(
        `UPDATE public.availability_slots SET cyclus_id = $2 WHERE id=$1`, [x.slot, x.cycle]); },
      drift: async (c, x) => { await c.query(
        `UPDATE public.cycles SET settings = jsonb_build_object('rebook_payment_mode','upfront') WHERE id=$1`,
        [x.cycle]); },
    },
    // ── THE SERIES, THREE WAYS ────────────────────────────────────────────────────────────
    //
    // The first version of this sweep had ONE series case: add a sibling. It passed with
    // `group_sessions` deleted from the digest, because a sibling added at the end moves the LAST
    // START too — so the count was never the fact under test. Three cases, each isolating one of
    // the three series facts, is what makes each of them individually load-bearing.
    //
    // The shared shape: a group of four sessions for this one person, with the claim's own session
    // in the middle so that nothing done to the ends can be confused with it.
    {
      // ISOLATES `rebook_group_id`. Every other way of moving the group also moves the series shape
      // — a different group has different members — so the id itself was covered only by proxy.
      // A lone claim moved from one single-member group to another moves the id and NOTHING else:
      // one session, same first, same last.
      fact: 'which series the claim belongs to',
      why: 'accepting acts on the GROUP the claim carries; repointing it books the player into a '
         + 'different series than the one the mail described',
      before: async (c, x) => { await c.query(
        `UPDATE public.slot_priority_claims SET rebook_group_id=$2 WHERE id=$1`, [x.claim, x.group]); },
      drift: async (c, x) => { await c.query(
        `UPDATE public.slot_priority_claims SET rebook_group_id=gen_random_uuid() WHERE id=$1`, [x.claim]); },
    },
    {
      fact: 'the series length',
      why: 'the mail says "N sessions"; a sibling withdrawing changes that sentence and nothing else',
      before: buildSeries,
      drift: async (c, x) => { await c.query(
        `UPDATE public.slot_priority_claims SET status='declined' WHERE id=$1`, [x.seriesMiddle]); },
    },
    {
      fact: 'the first session of the series',
      why: 'the mail states the date range; moving the earliest session moves its left edge',
      before: buildSeries,
      drift: async (c, x) => { await c.query(
        `UPDATE public.availability_slots
            SET start_time = start_time - interval '6 hours', end_time = end_time - interval '6 hours'
          WHERE id = (SELECT slot_id FROM public.slot_priority_claims WHERE id=$1)`, [x.seriesFirst]); },
    },
    {
      fact: 'the last session of the series',
      why: 'and its right edge',
      before: buildSeries,
      drift: async (c, x) => { await c.query(
        `UPDATE public.availability_slots
            SET start_time = start_time + interval '2 days', end_time = end_time + interval '2 days'
          WHERE id = (SELECT slot_id FROM public.slot_priority_claims WHERE id=$1)`, [x.seriesLast]); },
    },
    {
      fact: 'the cycle itself',
      why: 'a session repointed at a DIFFERENT cycle that happens to be named and dated identically '
         + 'reads the same and is not the same cycle',
      before: async (c, x) => {
        await c.query(`UPDATE public.availability_slots SET cyclus_id = $2 WHERE id=$1`, [x.slot, x.cycle]);
      },
      drift: async (c, x) => {
        // A TWIN: same name, same start date, same settings. Only the identity differs, so this is
        // the one case in which `cyclus_id` is the only fact that can move.
        const twin = (await c.query(
          `INSERT INTO public.cycles(id,owner_id,owner_type,name,status,start_date,settings)
           SELECT gen_random_uuid(), cy.owner_id, cy.owner_type, cy.name, cy.status, cy.start_date, cy.settings
             FROM public.cycles cy WHERE cy.id = $1 RETURNING id`, [x.cycle])).rows[0].id;
        await c.query(`UPDATE public.availability_slots SET cyclus_id = $2 WHERE id=$1`, [x.slot, twin]);
      },
    },
    {
      fact: 'the person behind the claim',
      why: 'a claim re-keyed onto a guest that shares the address is a DIFFERENT person with the '
         + 'same inbox — the address alone cannot tell them apart',
      drift: async (c, x) => {
        await c.query(`UPDATE public.slot_priority_claims SET guest_player_id=$2 WHERE id=$1`,
          [x.claim, await twinGuest(c, x)]);
      },
    },
    {
      // ISOLATES `guest_player_id`. In the case above, repointing a PROFILE claim at a guest also
      // empties `account_user_id`, so either field alone would still catch it and neither is
      // individually proven. Guest → guest moves exactly one.
      fact: 'which guest the claim belongs to',
      why: 'two children in one family share a parent inbox; the invitation is for one of them',
      before: async (c, x) => {
        x.guestId = await twinGuest(c, x);
        await c.query(`UPDATE public.slot_priority_claims SET guest_player_id=$2 WHERE id=$1`,
          [x.claim, x.guestId]);
      },
      drift: async (c, x) => { await c.query(
        `UPDATE public.slot_priority_claims SET guest_player_id=$2 WHERE id=$1`,
        [x.claim, await twinGuest(c, x, 'Second Twin')]); },
    },
    {
      // ISOLATES `player_id`, which the seal did not carry at all until review round 2. On a
      // dual-keyed claim the guest stays, the account is NULL either way (a guest claim has no
      // account), and the address is the guest's — so re-pointing the PROFILE half moved nothing
      // sealed, while the accept's pair-exact predicate now books the new profile.
      fact: 'the profile half of the identity pair',
      why: 'the accept books the exact (player, guest) pair, so a re-pointed profile books somebody '
         + 'else against an invitation sealed for the first',
      before: async (c, x) => {
        x.guestId = await twinGuest(c, x);
        await c.query(`UPDATE public.slot_priority_claims SET guest_player_id=$2 WHERE id=$1`,
          [x.claim, x.guestId]);
      },
      drift: async (c, x) => {
        const other = (await c.query(
          `INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
        const otherProfile = (await c.query(
          `SELECT id FROM public.profiles WHERE user_id=$1`, [other])).rows[0].id;
        await c.query(`UPDATE public.slot_priority_claims SET player_id=$2 WHERE id=$1`,
          [x.claim, otherProfile]);
      },
    },
    {
      // ISOLATES `account_user_id`: the profile keeps its address and its identity; only the login
      // behind it changes. The invitation would then be attributed to an account that is not the
      // one the offer was made to.
      fact: 'the account behind the profile',
      why: 'the outbox row carries `recipient_user_id`, and a re-pointed profile sends the '
         + 'invitation to a different account at the same address',
      drift: async (c, x) => {
        const u = (await c.query(`INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
        // The auto-created profile for that user is collateral; the claim still points at the
        // ORIGINAL profile, whose account is what moves.
        await c.query(`DELETE FROM public.profiles WHERE user_id=$1`, [u]);
        await c.query(`UPDATE public.profiles SET user_id=$2 WHERE id=$1`, [x.profile, u]);
      },
    },
    {
      fact: 'the destination',
      why: 'the address is who the offer was made TO; the frozen bytes still carry the old one',
      drift: async (c, x) => { await c.query(
        `UPDATE public.profiles SET email = 'elsewhere@example.test' WHERE id=$1`, [x.profile]); },
    },
  ];

  for (const f of offerFacts) {
    it(`OFFER IDENTITY — ${f.fact} is part of it: ${f.why}`, async () => {
      const c = await db();
      const r = await seedRound(c, 1);
      await giveProfileEmails(c, r);
      const { claim, user, slot, profile } = r.recipients[0];
      const ctx: SeedCtx = {
        claim, user, slot, profile, cycle: r.cycle, round: r.round,
        recipient: r.recipients[0].recipient,
        group: (await c.query(`SELECT gen_random_uuid() AS g`)).rows[0].g as string,
      };
      // The fact is put in place BEFORE the enqueue, so the sender renders from it and the digest
      // freezes it. A `before` that ran after would be testing a fact the message never promised.
      await f.before?.(c, ctx);
      // A `before` that re-keys the claim onto a guest changes WHO the enqueue must be called as:
      // the entrypoint refuses a guest claim that carries an account id, and vice versa. That
      // refusal is its own test; here it would just mask the fact under examination.
      // THE LEADER IS WHAT GETS ENQUEUED. A series has ONE invitation and the enqueue refuses any
      // other claim of it, so a fixture that builds a series must enqueue its leader — which is
      // exactly what every caller now does. The drift cases still work: the series aggregates are
      // shared, so moving an end or removing a middle moves the leader's digest too.
      const target = (await c.query(
        `SELECT o.series_leader_claim_id::text AS id FROM public.d7_p_invite_offer($1,$2) o`,
        [ACADEMY, claim])).rows[0].id as string;
      const out = ctx.guestId
        ? await enqueue(c, { claim: target, round: r.round, user: null, guest: ctx.guestId })
        : await enqueue(c, { claim: target, round: r.round, user });

      await f.drift(c, ctx);

      const resolved = await resolveOnce(c, out.rows[0].outbox_id, `w-${f.fact.replace(/\W+/g, '')}`);
      expect(resolved.disposition, `${f.fact} moved — the frozen message is not sent`).toBe('held');
      expect(resolved.refusal_reason, 'and the reason names the whole offer, not one column')
        .toBe('offer_changed');
      expect((await c.query(
        `SELECT transport_state FROM public.notification_outbox WHERE id=$1`,
        [out.rows[0].outbox_id])).rows[0].transport_state,
        'the row leaves the claimable set instead of recycling').toBe('configuration_hold');
    });
  }

  it('OFFER IDENTITY — THE CONTROL: an untouched offer still sends', async () => {
    // Without this the sweep above proves only that the fixture is fragile. Same seed, same setup
    // steps, no drift — and it must proceed.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    await c.query(`UPDATE public.availability_slots
       SET price_per_session = 20.00, priority_window_ends_at = now()+interval '2 days' WHERE id=$1`, [slot]);
    const out = await enqueue(c, { claim, round: r.round, user });
    const resolved = await resolveOnce(c, out.rows[0].outbox_id, 'w-control');
    expect(resolved.disposition, 'an offer that did not move is authorized').toBe('proceed');
    expect(resolved.refusal_reason).toBeNull();
  });

  it('THE SEAL IS FRAMED — a delimiter inside a session label cannot forge another offer', async () => {
    // REVIEW ROUND 2 (P1). The digest joined its fields with a pipe. Session labels are free text
    // and the enqueue's address pattern admits pipes, so a coordinated pair of values could shift
    // the framing and hash IDENTICALLY for a different offer — a stale bearer invitation left
    // authorized while both the label and the destination had changed. One-field-at-a-time mutants
    // cannot see it; only a constructed collision can.
    const c = await db();
    const r = await seedRound(c, 1);
    const { claim, slot, profile } = r.recipients[0];

    // Two offers that a pipe-joined encoding would render as the same byte string: the boundary
    // between the label and the fields after it is moved INTO the label.
    const read = async () => (await c.query(
      `SELECT o.offer_digest d FROM public.d7_p_invite_offer($1,$2) o`, [ACADEMY, claim])).rows[0].d;

    await c.query(`UPDATE public.profiles SET email = $2 WHERE id = $1`, [profile, 'a@example.test']);
    await c.query(`UPDATE public.availability_slots SET cyclus_name = $2 WHERE id=$1`, [slot, 'X']);
    const first = await read();

    // Same characters, different fields: the label absorbs what used to follow it.
    await c.query(`UPDATE public.availability_slots SET cyclus_name = $2 WHERE id=$1`,
      [slot, 'X|shifted']);
    await c.query(`UPDATE public.profiles SET email = $2 WHERE id = $1`, [profile, 'a@example.test']);
    const second = await read();
    expect(second, 'a pipe inside a label is not a field boundary').not.toBe(first);

    // ── THE ENCODING ITSELF, RECONSTRUCTED ────────────────────────────────────────────────
    //
    // Grepping the installed body for `jsonb_build_array` proves NOTHING: `prosrc` includes
    // comments, so restoring a delimiter join and leaving `-- jsonb_build_array` behind satisfies
    // it. An adversarial reader demonstrated exactly that mutation against the first version of
    // this test. So the encoding is REBUILT here from the offer's own eighteen facts and the
    // installed digest is required to equal the framed form — and NOT to equal the delimiter-joined
    // form of the same eighteen values. No comment can satisfy that, and no re-ordering of the
    // array can quietly weaken it.
    const enc = (await c.query(
      `SELECT encode(sha256(convert_to(jsonb_build_array(
                'd7.invite.offer.v1',
                coalesce(o.claim_token,''), coalesce(o.slot_id::text,''),
                coalesce(extract(epoch FROM o.start_time)::text,''),
                coalesce(extract(epoch FROM o.end_time)::text,''),
                coalesce(to_char(o.price_per_session,'FM999999999990.00'),''),
                coalesce(extract(epoch FROM o.priority_window_ends_at)::text,''),
                coalesce(o.cyclus_id::text,''), coalesce(o.cyclus_name,''),
                coalesce(to_char(o.cycle_start_date,'YYYY-MM-DD'),''),
                coalesce(o.payment_mode,''), coalesce(o.rebook_group_id::text,''),
                coalesce(o.group_sessions::text,''),
                coalesce(extract(epoch FROM o.group_first_start)::text,''),
                coalesce(extract(epoch FROM o.group_last_start)::text,''),
                coalesce(o.player_id::text,''), coalesce(o.guest_player_id::text,''),
                coalesce(o.account_user_id::text,''), coalesce(o.destination,'')
              )::text,'UTF8')),'hex') AS framed,
              encode(sha256(convert_to(concat_ws('|',
                'd7.invite.offer.v1',
                coalesce(o.claim_token,''), coalesce(o.slot_id::text,''),
                coalesce(extract(epoch FROM o.start_time)::text,''),
                coalesce(extract(epoch FROM o.end_time)::text,''),
                coalesce(to_char(o.price_per_session,'FM999999999990.00'),''),
                coalesce(extract(epoch FROM o.priority_window_ends_at)::text,''),
                coalesce(o.cyclus_id::text,''), coalesce(o.cyclus_name,''),
                coalesce(to_char(o.cycle_start_date,'YYYY-MM-DD'),''),
                coalesce(o.payment_mode,''), coalesce(o.rebook_group_id::text,''),
                coalesce(o.group_sessions::text,''),
                coalesce(extract(epoch FROM o.group_first_start)::text,''),
                coalesce(extract(epoch FROM o.group_last_start)::text,''),
                coalesce(o.player_id::text,''), coalesce(o.guest_player_id::text,''),
                coalesce(o.account_user_id::text,''), coalesce(o.destination,'')
              ),'UTF8')),'hex') AS joined,
              o.offer_digest
         FROM public.d7_p_invite_offer($1,$2) o`, [ACADEMY, claim])).rows[0];
    expect(enc.offer_digest, 'the installed seal IS the framed encoding of its eighteen facts')
      .toBe(enc.framed);
    expect(enc.offer_digest, 'and is NOT the delimiter-joined encoding of the same values')
      .not.toBe(enc.joined);
    expect(enc.framed, 'the two encodings really do differ here').not.toBe(enc.joined);
  });

  it('THE CYCLE DATE IS DateStyle-INVARIANT — a session preference cannot hold an invitation', async () => {
    // REVIEW ROUND 2 (P2), and a mutant proved the first fix had no sensor: with the test session on
    // ISO, `date::text` and the canonical form are the same string, so reverting the comparison
    // passed everything. `DateStyle` is session state exactly as `TimeZone` is — an `SQL, DMY`
    // session renders 2026-09-01 as 01/09/2026 — and the sender always sends ISO. Under the old
    // form every enqueue from such a session was refused as a changed offer, and every dispatch
    // would have re-judged the seal against a different rendering of an unmoved date.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    await c.query(`UPDATE public.availability_slots SET cyclus_id = $2 WHERE id=$1`, [slot, r.cycle]);

    // Prove the session preference really does move a bare `::text` rendering, or this is vacuous.
    await c.query(`SET DateStyle = 'SQL, DMY'`);
    const bare = (await c.query(
      `SELECT cy.start_date::text AS t, to_char(cy.start_date,'YYYY-MM-DD') AS canonical
         FROM public.cycles cy WHERE cy.id=$1`, [r.cycle])).rows[0];
    expect(bare.t, 'the session renders the date its own way').not.toBe(bare.canonical);

    // The canonical facts are unmoved, and the enqueue accepts the ISO date the sender always sends.
    const facts = await renderedFacts(c, ACADEMY, claim);
    expect(facts.cycle_start, 'the server states ISO whatever the session prefers').toBe(bare.canonical);
    const out = await enqueue(c, { claim, round: r.round, user });
    expect(out.rows[0].skip_reason, 'and the enqueue is not refused for a date that never moved')
      .toBeNull();

    // The seal does not move with the session preference either.
    const underSql = (await c.query(
      `SELECT o.offer_digest d FROM public.d7_p_invite_offer($1,$2) o`, [ACADEMY, claim])).rows[0].d;
    await c.query(`SET DateStyle = 'ISO, MDY'`);
    expect((await c.query(
      `SELECT o.offer_digest d FROM public.d7_p_invite_offer($1,$2) o`, [ACADEMY, claim])).rows[0].d,
      'the seal is the same under either DateStyle').toBe(underSql);
    await c.query(`RESET DateStyle`);
  });

  it('THE DIGEST IS TIMEZONE-INVARIANT — the session TimeZone cannot hold a live invitation', async () => {
    // ROUND 5's P3. Every instant used to reach the digest through `::text`, which renders through
    // the session `TimeZone` — so an enqueue under Europe/Amsterdam and a dispatch under UTC
    // produced two different digests for one unchanged offer, and a legitimate invitation was held.
    // The migration proves NO instant is cast to text; this proves the consequence.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    await c.query(`UPDATE public.availability_slots
       SET price_per_session = 20.00, priority_window_ends_at = now()+interval '2 days' WHERE id=$1`, [slot]);

    await c.query(`SET TimeZone = 'Europe/Amsterdam'`);
    const ams = (await renderedFacts(c, ACADEMY, claim));
    const out = await enqueue(c, { claim, round: r.round, user });

    // The worker runs elsewhere — a different pod, a different session default, a DST change.
    await c.query(`SET TimeZone = 'Pacific/Kiritimati'`);
    const kir = (await renderedFacts(c, ACADEMY, claim));
    const digests = await c.query(
      `SELECT o.offer_digest FROM public.d7_p_invite_offer($1,$2) o`, [ACADEMY, claim]);
    expect(kir, 'the rendered instants DO differ between zones — otherwise this proves nothing')
      .not.toEqual(ams);
    expect(digests.rows[0].offer_digest,
      'but the digest does not, because it digests epochs rather than renderings')
      .toBe((await c.query(
        `SELECT (o.payload ->> 'd7_offer_digest') d FROM public.notification_outbox o WHERE o.id=$1`,
        [out.rows[0].outbox_id])).rows[0].d);

    const resolved = await resolveOnce(c, out.rows[0].outbox_id, 'w-tz');
    expect(resolved.disposition, 'and a zone change alone does not hold the invitation').toBe('proceed');
    await c.query(`RESET TimeZone`);
  });

  // ══ THE RENDERED BINDING IS MANDATORY, NOT OPTIONAL ═══════════════════════════════════════
  //
  // ROUND 5's P1-1, and the most instructive finding of the five rounds: round 4 added the binding
  // as a check that fired ONLY when the field was present, so a caller that omitted it got the old
  // behaviour — and because the helper omitted it too, most of the suite proved the bypass. The
  // conditional existed so the existing tests would keep passing, which is the wrong reason to make
  // a security check conditional.
  //
  // It is now required. The absence case below is the one that would have caught round 4.
  it('A SESSION WITH NO CYCLE ENQUEUES — the sender renders \'\' and the server must not answer NULL', async () => {
    // `availability_slots.cyclus_id` is nullable, and the sender derives `payment_mode` from a
    // BOOLEAN — `isUpfront ? "upfront" : ""` — so a cycle-less session renders as ''. A server that
    // answered NULL there would disagree with '' on every such session and refuse the lot.
    //
    // This is the same two-source trap as the session label, in its NULL form, and it is the reason
    // the rendered facts are compared against a canonicalised projection rather than a raw column.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    await c.query(`UPDATE public.availability_slots SET cyclus_id = NULL WHERE id=$1`, [slot]);

    const facts = await renderedFacts(c, ACADEMY, claim);
    expect(facts.payment_mode, "the server says '' rather than NULL for a session with no cycle").toBe('');
    expect(facts.cyclus_id, 'and it genuinely has no cycle').toBeNull();

    // The SENDER's shape, byte for byte: a boolean rendered as 'upfront' or ''.
    const out = await enqueue(c, { claim, round: r.round, user, rendered: { payment_mode: '' } });
    expect(out.rows[0].outbox_id, 'the invitation is enqueued').toBeTruthy();
    expect(out.rows[0].skip_reason).toBeNull();
  });

  // ══ THE TWO SIDES AGREE, DERIVED APART ════════════════════════════════════════════════════
  //
  // The one test the rest of this file structurally cannot be: both sides of the fifteen-field
  // comparison, computed from their own sources, required to match. Three shapes, because the
  // disagreements that matter live in the NULL corners.
  for (const shape of ['a plain session', 'a session in a series', 'a session with no cycle',
                       'a guest claim'] as const) {
    it(`SOURCE AGREEMENT — the sender's reads and the offer contract agree for ${shape}`, async () => {
      const c = await db();
      const r = await seedRound(c, 1);
      await giveProfileEmails(c, r);
      const { claim, slot, profile } = r.recipients[0];
      // Give the session everything a real one carries, INCLUDING the denormalized label that does
      // not have to equal the cycle's name — the case the first draft got wrong.
      await c.query(`UPDATE public.availability_slots
         SET cyclus_id = $2, cyclus_name = 'Najaar 2026 · di 19:00',
             price_per_session = 22.50, priority_window_ends_at = now()+interval '2 days'
       WHERE id=$1`, [slot, r.cycle]);
      await c.query(`UPDATE public.cycles SET name = 'A COMPLETELY DIFFERENT NAME',
         settings = jsonb_build_object('rebook_payment_mode','upfront') WHERE id=$1`, [r.cycle]);
      if (shape === 'a session in a series') {
        const group = (await c.query(`SELECT gen_random_uuid() g`)).rows[0].g;
        await buildSeries(c, {
          claim, user: r.recipients[0].user, slot, profile, cycle: r.cycle, round: r.round, group,
          recipient: r.recipients[0].recipient,
        });
      }
      if (shape === 'a session with no cycle') {
        await c.query(`UPDATE public.availability_slots SET cyclus_id = NULL WHERE id=$1`, [slot]);
      }
      if (shape === 'a guest claim') {
        // WITHOUT THIS SHAPE the guest arm of both derivations is dead code — review round 1's
        // finding. It is the arm that goes through `resolve_guest_member_contacts`, and it is the
        // one that matters most: a guest has no account to fall back to, so an address that
        // disagrees makes that child permanently un-invitable.
        const guest = (await c.query(
          `INSERT INTO public.guest_players(academy_profile_id, full_name, email)
           VALUES ($1,'Series Guest',$2) RETURNING id`,
          [ACADEMY, `guest-${claim}@example.test`])).rows[0].id;
        await c.query(`UPDATE public.slot_priority_claims SET guest_player_id=$2 WHERE id=$1`,
          [claim, guest]);
      }

      const mine = await senderFacts(c, claim);
      const theirs = await renderedFacts(c, ACADEMY, claim);
      expect(theirs, `${shape}: fifteen facts, two derivations, one answer`).toEqual(mine);
    });
  }

  it('BINDING — a claim re-pointed BETWEEN the render and the enqueue is refused', async () => {
    // REVIEW ROUND 3's P1. `player_id` reached the DIGEST in round 2, but the digest is computed
    // from the server's own read AFTER the rendered facts are compared — so it catches drift after
    // the enqueue, never a substitution before it. A product writer moving a dual-keyed claim from
    // (P1, G) to (P2, G) between the render and the enqueue left the guest, the address, the slot,
    // the token and a one-session series all unchanged: the enqueue accepted, sealed (P2, G), and
    // the mailed bearer token — which accepts PAIR-EXACTLY — acted on P2. The message said one
    // person and the button booked another.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, profile } = r.recipients[0];
    const email = (await c.query(`SELECT email FROM public.profiles WHERE id=$1`, [profile])).rows[0].email;
    const guest = (await c.query(
      `INSERT INTO public.guest_players(academy_profile_id, full_name, email)
       VALUES ($1,'Dual Key',$2) RETURNING id`, [ACADEMY, email])).rows[0].id;
    await c.query(`UPDATE public.slot_priority_claims SET guest_player_id=$2 WHERE id=$1`, [claim, guest]);

    // WHAT THE SENDER RENDERED — captured before the substitution, as the edge captures it.
    const rendered = await renderedFacts(c, ACADEMY, claim);
    expect(rendered.player_id, 'the render was for this profile').toBe(profile);

    // The claim is re-pointed at a different profile. Everything the message SAYS is unchanged.
    const other = (await c.query(
      `INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id`)).rows[0].id;
    const otherProfile = (await c.query(
      `SELECT id FROM public.profiles WHERE user_id=$1`, [other])).rows[0].id;
    await c.query(`UPDATE public.slot_priority_claims SET player_id=$2 WHERE id=$1`, [claim, otherProfile]);
    const after = await renderedFacts(c, ACADEMY, claim);
    expect(after.destination, 'the address did not move').toBe(rendered.destination);
    expect(after.slot_id, 'nor the session').toBe(rendered.slot_id);
    expect(after.claim_token, 'nor the token').toBe(rendered.claim_token);

    // The enqueue must refuse the facts the sender rendered, because they are no longer this claim's.
    await expect(enqueue(c, { claim, round: r.round, user: null, guest, rendered: null,
      payload: { d7_rendered: rendered } }),
      'a message rendered for one person may not be sealed for another')
      .rejects.toThrow(/changed between rendering and enqueue/);
    expect((await c.query(
      `SELECT count(*)::int n FROM public.notification_outbox WHERE related_slot_priority_claim_id=$1`,
      [claim])).rows[0].n, 'and nothing was written').toBe(0);
  });

  it('WHITESPACE — an address the sender trims and the server did not is not a changed offer', async () => {
    // REVIEW ROUND 1. The sender trims with JavaScript `.trim()`, which strips the whole Unicode
    // whitespace set; the offer trimmed with PostgreSQL `btrim()`, which strips ASCII spaces only.
    // An imported address wrapped in tabs — or in the non-breaking space a spreadsheet paste leaves
    // behind — was clean in the message and decorated in the authoritative read, so every enqueue
    // for that recipient was refused as "changed between rendering and enqueue". Not a rare shape:
    // both email columns are unconstrained text and the data is imported.
    const c = await db();
    const r = await seedRound(c, 1);
    const { claim, user, profile } = r.recipients[0];
    const clean = `${profile}@example.test`;
    // EVERY CHARACTER IN THE CLASS, one at a time. Round 2: the first version tried four of them,
    // so deleting any of the other sixteen from the server's class passed here while JavaScript
    // went on trimming it — and that recipient's every enqueue would be refused. The list below is
    // JavaScript's own `trim()` set; `String.prototype.trim` is asserted to agree on each, so the
    // two definitions are compared rather than both being assumed.
    const jsWhitespace = ['\t', '\n', '\r', '\f', '\v', ' ', '\u00a0', '\u1680', '\u2000',
      '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008',
      '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff'];
    for (const ch of jsWhitespace) {
      const decorated = `${ch}${clean}${ch}`;
      expect(decorated.trim(), `JavaScript trims U+${ch.codePointAt(0)!.toString(16).padStart(4, '0')}`)
        .toBe(clean);
      await c.query(`UPDATE public.profiles SET email = $2 WHERE id = $1`, [profile, decorated]);
      expect((await renderedFacts(c, ACADEMY, claim)).destination,
        `and the server strips U+${ch.codePointAt(0)!.toString(16).padStart(4, '0')} too`).toBe(clean);
    }
    await c.query(`UPDATE public.profiles SET email = $2 WHERE id = $1`, [profile, clean]);
    // ...and it still enqueues, with the clean address the message was addressed to.
    const out = await enqueue(c, { claim, round: r.round, user, rendered: { destination: clean } });
    expect(out.rows[0].skip_reason).toBeNull();
    expect((await c.query(
      `SELECT destination_normalized FROM public.notification_outbox WHERE id=$1`,
      [out.rows[0].outbox_id])).rows[0].destination_normalized).toBe(clean);
  });

  it('PRICE — the mail quotes the price the offer seals, to the cent', async () => {
    // REVIEW ROUND 1. The HTML printed `Number(price).toFixed(2)` while the sender echoed the RAW
    // numeric, and PostgreSQL canonicalised it with a different rounding: a stored 2.675 is quoted
    // as EUR 2.67 and was sealed as 2.68. The echo is now the rendered string and the server
    // compares that exact text, so the two cannot disagree silently — a divergence refuses.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    await c.query(`UPDATE public.availability_slots SET price_per_session = 2.675 WHERE id=$1`, [slot]);

    expect((await renderedFacts(c, ACADEMY, claim)).price,
      'the server states a canonical two-decimal price').toBe('2.68');
    // What JavaScript prints for the same stored value. If they ever differ the enqueue must refuse
    // rather than seal a price the message does not state.
    expect(Number('2.675').toFixed(2), 'and JavaScript prints something else entirely').toBe('2.67');
    await expect(enqueue(c, { claim, round: r.round, user, rendered: { price: '2.67' } }),
      'a mail quoting 2.67 may not be sealed against 2.68')
      .rejects.toThrow(/changed between rendering and enqueue/);
    // ...and the comparison is on the TEXT, not on the number. A mutant reverting it to
    // `::numeric(12,2)` survived the assertion above, because 2.67 and 2.68 differ as numbers too.
    // What only the text form catches is a price that is numerically equal and differently written:
    // the seal must be the exact string the message printed, not a value that rounds to it.
    await expect(enqueue(c, { claim, round: r.round, user, rendered: { price: '2.680' } }),
      'a differently-written price is not the price the mail printed')
      .rejects.toThrow(/changed between rendering and enqueue/);
    await expect(enqueue(c, { claim, round: r.round, user, rendered: { price: '2.6800' } }))
      .rejects.toThrow(/changed between rendering and enqueue/);

    // The agreeing case still enqueues.
    const out = await enqueue(c, { claim, round: r.round, user, rendered: { price: '2.68' } });
    expect(out.rows[0].skip_reason).toBeNull();
  });

  it('BINDING — an enqueue with no rendered facts at all is REFUSED', async () => {
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];
    await expect(enqueue(c, { claim, round: r.round, user, rendered: null }))
      .rejects.toThrow(/without the facts it was rendered from/);
    expect((await c.query(
      `SELECT count(*)::int n FROM public.notification_outbox WHERE related_slot_priority_claim_id=$1`,
      [claim])).rows[0].n, 'and nothing was written').toBe(0);
  });

  it('BINDING — an OMITTED field is refused even when the server\'s own value is null', async () => {
    // REVIEW ROUND 1. `->>` on a missing key is SQL NULL, and `IS NOT DISTINCT FROM` then accepted
    // omission for every fact whose authoritative value happened to be null — nine of the fifteen
    // for a cycle-less, groupless, priceless session. Worse in the other direction: a caller that
    // rendered a price and then lost the key would be waved through by the very check meant to
    // catch a stale render. Presence is now required before equality is asked.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    // A session with NOTHING optional set, so every omitted key agrees with a null.
    await c.query(`UPDATE public.availability_slots
       SET cyclus_id = NULL, cyclus_name = NULL, price_per_session = NULL,
           priority_window_ends_at = NULL WHERE id=$1`, [slot]);

    for (const omitted of ['price', 'cyclus_id', 'cyclus_name', 'cycle_start', 'sessions',
                           'group_id', 'priority_ends', 'first_start', 'last_start']) {
      const base = await renderedFacts(c, ACADEMY, claim);
      expect(base[omitted], `${omitted} really is null here`).toBeNull();
      const partial = { ...base };
      delete (partial as Record<string, unknown>)[omitted];
      await expect(enqueue(c, { claim, round: r.round, user, rendered: null,
        payload: { d7_rendered: partial } }),
        `omitting ${omitted} must not pass as "equal to null"`)
        .rejects.toThrow(/without every fact it was rendered from/);
    }
    expect((await c.query(
      `SELECT count(*)::int n FROM public.notification_outbox WHERE related_slot_priority_claim_id=$1`,
      [claim])).rows[0].n, 'and nothing was written by any of them').toBe(0);
  });

  it('BINDING — a rendered field that is not an object is refused, not coerced', async () => {
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];
    // `->` on a string returns a jsonb string, and `->>` on it returns NULL for every key — so a
    // typeof check is what stops a scalar from satisfying fifteen NULL-vs-NULL comparisons.
    await expect(enqueue(c, {
      claim, round: r.round, user, rendered: null,
      payload: { d7_rendered: 'yes' },
    })).rejects.toThrow(/without the facts it was rendered from/);
  });

  // Each of the fifteen fields, one at a time. A field-by-field sweep is the only thing that proves
  // the comparison list is COMPLETE — a whole-object test passes just as happily with fourteen.
  const renderedFields: Array<[string, unknown]> = [
    ['slot_id', '00000000-0000-4000-8000-000000000001'],
    ['claim_token', 'not-the-token'],
    ['group_id', '00000000-0000-4000-8000-000000000002'],
    ['cyclus_id', '00000000-0000-4000-8000-000000000003'],
    ['cyclus_name', 'Een andere cyclus'],
    ['cycle_start', '2030-01-01'],
    ['payment_mode', 'upfront'],
    ['sessions', '3'],
    ['destination', 'other@example.test'],
    ['price', '99.00'],
    ['start', '2030-01-01T10:00:00+00'],
    ['end', '2030-01-01T11:00:00+00'],
    ['priority_ends', '2030-01-01T09:00:00+00'],
    ['first_start', '2030-01-01T10:00:00+00'],
    ['last_start', '2030-01-01T10:00:00+00'],
  ];
  for (const [field, wrong] of renderedFields) {
    it(`BINDING — a rendered '${field}' that disagrees with the server is refused`, async () => {
      const c = await db();
      const r = await seedRound(c, 1);
      await giveProfileEmails(c, r);
      const { claim, user } = r.recipients[0];
      await expect(enqueue(c, { claim, round: r.round, user, rendered: { [field]: wrong } }))
        .rejects.toThrow(/changed between rendering and enqueue/);
      expect((await c.query(
        `SELECT count(*)::int n FROM public.notification_outbox WHERE related_slot_priority_claim_id=$1`,
        [claim])).rows[0].n, 'and the refusal came before any write').toBe(0);
    });
  }

  it('THE CLAIM IS LOCKED BEFORE IT IS READ, not merely before it is written', async () => {
    // ROUND 5's P1-6. The lock used to be taken after the authoritative claim read, so a claim that
    // moved during the enqueue was still written under the tenant read before the move — one row,
    // the wrong owner, and the correct tenant permanently blocked by the one-row-per-claim rule.
    // Concurrency-only, so it is asserted from the installed body, in ORDER.
    const c = await db();
    const core = (await c.query(
      `SELECT pg_get_functiondef(to_regprocedure(
         'public.rebook_priority_claim_invite_enqueue_core(uuid,uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid)')) AS d`))
      .rows[0].d as string;
    const lock = core.indexOf('pg_advisory_xact_lock');
    expect(lock, 'the lock is taken').toBeGreaterThan(-1);
    expect(lock, 'BEFORE the claim facts are read')
      .toBeLessThan(core.indexOf('d7_p_invite_offer'));
    expect(lock, 'and before the cross-tenant check it also protects')
      .toBeLessThan(core.indexOf('tenant_academy_profile_id IS DISTINCT FROM p_academy'));
    // ...and it is the FIRST statement of the body, which is the only version of this property that
    // a later insertion cannot quietly undo.
    // ...and nothing READS before it. Argument validation may precede the lock — refusing a NULL
    // claim needs no lock and could not race — but a query may not, because a value read before the
    // lock is exactly the stale value this ordering exists to prevent.
    const body = core.slice(core.indexOf('BEGIN'));
    const preamble = body.slice(0, body.lastIndexOf('PERFORM', body.indexOf('pg_advisory_xact_lock')));
    expect(preamble, 'nothing is read before the lock')
      .not.toMatch(/\b(SELECT|UPDATE|INSERT|DELETE)\b/);
    expect((preamble.match(/RAISE EXCEPTION/g) ?? []).length,
      'and the only thing in front of it is the one argument guard').toBe(1);
  });

  it('COHERENT AT BIRTH — a claim sitting on a session its round did not capture is refused', async () => {
    // ROUND 5's P1-7. A claim captured for R1/S1 and moved to same-academy S2 before rendering
    // produced a row attributed to R1 whose token acts on S2. Both halves are same-academy, so no
    // tenant fence catches it; only the capture does.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];
    const other = (await c.query(`INSERT INTO public.availability_slots
      (id,trainer_id,academy_profile_id,source_cycle_id,start_time,end_time,max_participants,member_window_ends_at)
      VALUES (gen_random_uuid(),$1,$2,$3,
              now()+interval '11 days'+make_interval(hours => $4),
              now()+interval '11 days'+make_interval(hours => $4)+interval '1 hour',4,
              now()+interval '30 days') RETURNING id`, [TRAINER, ACADEMY, r.cycle, nextLane()])).rows[0].id;
    await c.query(`UPDATE public.slot_priority_claims SET slot_id=$2 WHERE id=$1`, [claim, other]);

    await expect(enqueue(c, { claim, round: r.round, user }))
      .rejects.toThrow(/sits on a session its round did not capture/);
  });

  it('COHERENT AT DISPATCH — a claim that moves session after enqueue is held', async () => {
    // The same fact re-read at the linearization point. The enqueue check alone would leave a row
    // frozen for S1 sending after the claim had moved to S2.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];
    const out = await enqueue(c, { claim, round: r.round, user });
    const other = (await c.query(`INSERT INTO public.availability_slots
      (id,trainer_id,academy_profile_id,source_cycle_id,start_time,end_time,max_participants,member_window_ends_at)
      VALUES (gen_random_uuid(),$1,$2,$3,
              now()+interval '12 days'+make_interval(hours => $4),
              now()+interval '12 days'+make_interval(hours => $4)+interval '1 hour',4,
              now()+interval '30 days') RETURNING id`, [TRAINER, ACADEMY, r.cycle, nextLane()])).rows[0].id;
    await c.query(`UPDATE public.slot_priority_claims SET slot_id=$2 WHERE id=$1`, [claim, other]);

    const resolved = await resolveOnce(c, out.rows[0].outbox_id, 'w-moved-slot');
    expect(resolved.disposition, 'a moved session is not sent for').toBe('held');
    // The slot is part of the offer, so the offer moved first — either reason is a hold, and the
    // assertion names both rather than pretending the ordering is the interesting part.
    expect(['offer_changed', 'placement_incoherent'],
      'and the reason is one of the two facts that moved').toContain(resolved.refusal_reason);
  });

  // ══ THE DEADLINE IS THE PLAYER'S OWN ══════════════════════════════════════════════════════
  it("DEADLINE — an invitation past the PLAYER's priority window is not sent, though the member window is open", async () => {
    // ROUND 5's P1-4. Dispatch was gated by `member_window_ends_at`, but claiming is refused after
    // the SLOT's `priority_window_ends_at` — so with a member window seven days out and a priority
    // window that closed an hour ago, the runtime would cheerfully send an invitation to a button
    // that already refuses. The cutoff is the EARLIER of the two.
    //
    // The closed window is in place BEFORE the enqueue, which is what makes this a deadline test
    // rather than a digest test: the offer never moves, so the only thing that can hold this row is
    // the cutoff itself.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    await c.query(`UPDATE public.availability_slots
       SET priority_window_ends_at = now()-interval '1 hour' WHERE id=$1`, [slot]);
    expect((await c.query(
      `SELECT s.member_window_ends_at > now() AS open FROM public.abc27_a_round_state($1) s`,
      [r.round])).rows[0].open, "the ROUND's own window is still wide open").toBe(true);

    const out = await enqueue(c, { claim, round: r.round, user });
    const resolved = await resolveOnce(c, out.rows[0].outbox_id, 'w-deadline');
    expect(resolved.disposition, 'a dead-on-arrival invitation is not sent').toBe('held');
    expect(resolved.refusal_reason, "held on the PLAYER's deadline, not the round's")
      .toBe('deadline_passed');
  });

  it('DEADLINE — a deferral that would land past the cutoff CANCELS instead of recycling forever', async () => {
    // ROUND 5's P1-5. Round 4 wrapped only the quiet-hours branch, so a killed channel always
    // rescheduled `now + 15 minutes` — past a cutoff five minutes away, then again, and again: a
    // row that can never send and never stops being examined.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    await c.query(`UPDATE public.availability_slots
       SET priority_window_ends_at = now()+interval '5 minutes' WHERE id=$1`, [slot]);
    const out = await enqueue(c, { claim, round: r.round, user });
    await c.query(
      `INSERT INTO public.notification_channel_kill_switches(channel,reason,request_id)
       VALUES ('email','test kill', gen_random_uuid())`);

    const resolved = await resolveOnce(c, out.rows[0].outbox_id, 'w-conflict');
    expect(resolved.disposition, 'a deferral it could never come back from is a hold').toBe('held');
    expect(resolved.refusal_reason).toBe('deadline_conflict');
    expect((await c.query(
      `SELECT transport_state, scheduled_for <= now() + interval '1 minute' AS soon
         FROM public.notification_outbox WHERE id=$1`, [out.rows[0].outbox_id])).rows[0].transport_state,
      'and it leaves the claimable set rather than being re-examined every 15 minutes')
      .toBe('configuration_hold');
  });

  it('THE CONTROL — the same kill switch with room to spare DEFERS rather than cancelling', async () => {
    // Without this, the test above passes on any hold for any reason.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    await c.query(`UPDATE public.availability_slots
       SET priority_window_ends_at = now()+interval '2 days' WHERE id=$1`, [slot]);
    const out = await enqueue(c, { claim, round: r.round, user });
    await c.query(
      `INSERT INTO public.notification_channel_kill_switches(channel,reason,request_id)
       VALUES ('email','test kill', gen_random_uuid())`);

    const resolved = await resolveOnce(c, out.rows[0].outbox_id, 'w-defer-ok');
    expect(resolved.disposition, 'a deferral that fits inside the window is a deferral').toBe('deferred');
    expect((await c.query(
      `SELECT transport_state FROM public.notification_outbox WHERE id=$1`,
      [out.rows[0].outbox_id])).rows[0].transport_state).toBe('channel_kill_deferred');
  });

  it('PLACEMENT — a capture that moves under an unchanged claim is held on its own reason', async () => {
    // ISOLATED ON PURPOSE. Every other way of making the placement incoherent also moves the offer,
    // so `offer_changed` fires first and `placement_incoherent` is never the reason under test —
    // the check could be deleted and the suite would not notice. A NEW capture row moves only the
    // capture: the claim, its slot and every promised fact are byte-identical.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];
    const before = (await c.query(
      `SELECT o.offer_digest d FROM public.d7_p_invite_offer($1,$2) o`, [ACADEMY, claim])).rows[0].d;
    const out = await enqueue(c, { claim, round: r.round, user });

    // A LATER capture of the same claim, for a DIFFERENT session. `uq_rrrcs_claim_per_round` allows
    // one capture per round, so the later one necessarily belongs to a second round — which is a
    // real event: the next round's materializer re-captures a claim that has been re-seated.
    const r2 = await seedRound(c, 0);
    const other = (await c.query(`INSERT INTO public.availability_slots
      (id,trainer_id,academy_profile_id,source_cycle_id,start_time,end_time,max_participants,member_window_ends_at)
      VALUES (gen_random_uuid(),$1,$2,$3,
              now()+interval '13 days'+make_interval(hours => $4),
              now()+interval '13 days'+make_interval(hours => $4)+interval '1 hour',4,
              now()+interval '30 days') RETURNING id`, [TRAINER, ACADEMY, r2.cycle, nextLane()])).rows[0].id;
    const rec2 = (await c.query(`INSERT INTO public.rebook_round_recipients
      (rebook_round_id,academy_profile_id,recipient_player_profile_id,captured_at)
      VALUES ($1,$2,$3,clock_timestamp()) RETURNING id`,
    [r2.round, ACADEMY, r.recipients[0].profile])).rows[0].id;
    await c.query(`INSERT INTO public.rebook_round_recipient_claim_sources
      (rebook_round_recipient_id,rebook_round_id,academy_profile_id,source_claim_id,
       source_slot_id,source_cycle_id,claimed_player_profile_id,claim_status,captured_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',clock_timestamp()+interval '1 second')`,
    [rec2, r2.round, ACADEMY, claim, other, r2.cycle, r.recipients[0].profile]);

    expect((await c.query(
      `SELECT o.offer_digest d FROM public.d7_p_invite_offer($1,$2) o`, [ACADEMY, claim])).rows[0].d,
      'the OFFER did not move — otherwise this proves nothing about placement').toBe(before);

    const resolved = await resolveOnce(c, out.rows[0].outbox_id, 'w-placement');
    expect(resolved.disposition).toBe('held');
    expect(resolved.refusal_reason,
      'the round it is attributed to and the session its token acts on are no longer the same thing')
      .toBe('placement_incoherent');
  });

  it('THE SERIES THE MAIL DESCRIBES IS THE SERIES THE ACCEPT BOOKS — pair-exact, not guest-first', async () => {
    // `OWNER_DECISION_D7_RUNTIME_PRIORITY_INVITE_SEMANTICS_V1`. Review round 1 measured that the
    // offer aggregated a person's siblings GUEST-FIRST while `respond_to_priority_claim` selects
    // them PAIR-EXACT. A representative claim `(P, G)` beside a sibling `(NULL, G)` was described as
    // two sessions and booked as one — the mail made a promise the button does not keep.
    //
    // The owner ruled that the invitation's scope equals the BOOKING scope and that the booking
    // scope does not widen, so this test asserts the two against each other rather than asserting a
    // number: the count in the offer is compared to the rows the accept's own predicate selects.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, profile, slot } = r.recipients[0];
    const group = (await c.query(`SELECT gen_random_uuid() g`)).rows[0].g;
    const guest = (await c.query(
      `INSERT INTO public.guest_players(academy_profile_id, full_name, email)
       VALUES ($1,'Dual Key',$2) RETURNING id`, [ACADEMY, `dual-${claim}@example.test`])).rows[0].id;

    // The representative is DUAL-KEYED: it carries both a profile and a guest.
    await c.query(`UPDATE public.slot_priority_claims SET rebook_group_id=$2, guest_player_id=$3 WHERE id=$1`,
      [claim, group, guest]);
    // The sibling carries the SAME guest and NO profile — guest-first says "same person", the
    // accept says "different pair".
    const sibSlot = (await c.query(`INSERT INTO public.availability_slots
      (id,trainer_id,academy_profile_id,source_cycle_id,start_time,end_time,max_participants,member_window_ends_at)
      VALUES (gen_random_uuid(),$1,$2,$3,
              now()+interval '16 days'+make_interval(hours => $4),
              now()+interval '16 days'+make_interval(hours => $4)+interval '1 hour',4,
              now()+interval '30 days') RETURNING id`, [TRAINER, ACADEMY, r.cycle, nextLane()])).rows[0].id;
    await c.query(`INSERT INTO public.slot_priority_claims(slot_id,player_id,guest_player_id,status,rebook_group_id)
      VALUES ($1,NULL,$2,'pending',$3)`, [sibSlot, guest, group]);

    // WHAT THE ACCEPT WOULD BOOK — its predicate, copied from the shipped RPC.
    const booked = (await c.query(
      `SELECT count(*)::int n FROM public.slot_priority_claims spc
        WHERE spc.rebook_group_id = (SELECT rebook_group_id FROM public.slot_priority_claims WHERE id=$1)
          AND spc.status = 'pending'
          AND spc.player_id       IS NOT DISTINCT FROM (SELECT player_id FROM public.slot_priority_claims WHERE id=$1)
          AND spc.guest_player_id IS NOT DISTINCT FROM (SELECT guest_player_id FROM public.slot_priority_claims WHERE id=$1)`,
      [claim])).rows[0].n;
    expect(booked, 'the accept books the representative only — the sibling is a different pair').toBe(1);

    // WHAT THE MAIL SAYS. Equal, by decision.
    const facts = await renderedFacts(c, ACADEMY, claim);
    expect(Number(facts.sessions), 'the mail describes exactly what one click will book').toBe(booked);
    expect(facts.first_start, 'and its range is the booked range, not the wider one')
      .toBe(facts.last_start);
    // The sibling's session is genuinely outside it — otherwise the equality above is vacuous.
    expect((await c.query(
      `SELECT start_time::text t FROM public.availability_slots WHERE id=$1`, [sibSlot])).rows[0].t)
      .not.toBe(facts.first_start);
    // ...and the claim's own session is the one described.
    expect((await c.query(
      `SELECT start_time::text t FROM public.availability_slots WHERE id=$1`, [slot])).rows[0].t)
      .toBe(facts.first_start);
    expect(profile, 'the representative really is dual-keyed').toBeTruthy();
  });

  it('ONE LEADER · a non-leader claim of a series can never be enqueued, on any route', async () => {
    // `APPROVE_D7_RUNTIME_FINAL_CONVERGENCE_V1`. Six routes reach this contract and three carried
    // their own leader rule; two disagreeing produced two live bearer invitations for one accept
    // scope (closure review 6's P1). The offer names ONE leader and the enqueue refuses any other
    // claim of the series — so a duplicate is not unlikely, it is unrepresentable, including from a
    // route written later by someone who never read the rule.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, profile } = r.recipients[0];
    const group = (await c.query(`SELECT gen_random_uuid() g`)).rows[0].g;
    await buildSeries(c, {
      claim, user, slot: r.recipients[0].slot, profile, cycle: r.cycle, round: r.round, group,
      recipient: r.recipients[0].recipient,
    });

    // The server names the leader, and it is the EARLIEST session — not the claim we started from.
    const leader = (await c.query(
      `SELECT o.series_leader_claim_id::text AS id FROM public.d7_p_invite_offer($1,$2) o`,
      [ACADEMY, claim])).rows[0].id as string;
    expect(leader, 'the leader is a sibling, not the claim asked about').not.toBe(claim);
    expect((await c.query(
      `SELECT o.series_leader_claim_id::text AS id FROM public.d7_p_invite_offer($1,$2) o`,
      [ACADEMY, leader])).rows[0].id,
      'and every member of the series names the SAME leader').toBe(leader);

    // A non-leader is refused before any write, whatever asked for it.
    await expect(enqueue(c, { claim, round: r.round, user }),
      'the clicked claim is not the one the series is led by')
      .rejects.toThrow(/is not the leader of its series/);
    expect((await c.query(
      `SELECT count(*)::int n FROM public.notification_outbox
        WHERE related_slot_priority_claim_id = ANY($1::uuid[])`,
      [[claim, leader]])).rows[0].n, 'and nothing was written').toBe(0);

    // The leader itself enqueues, once. A second attempt for the same series is the same key.
    const first = await enqueue(c, { claim: leader, round: r.round, user });
    expect(first.rows[0].skip_reason).toBeNull();
    const second = await enqueue(c, { claim: leader, round: r.round, user });
    expect(second.rows[0].skip_reason, 'a second attempt adds nothing').toBe('already_enqueued');
    expect((await c.query(
      `SELECT count(*)::int n FROM public.notification_outbox
        WHERE related_slot_priority_claim_id = ANY($1::uuid[])`,
      [[claim, leader]])).rows[0].n, 'ONE row for the whole series').toBe(1);
  });

  it('ONE LEADER · a claim with no group is its own leader', async () => {
    // The common shape, and the one a leader rule most easily gets wrong: a single session is a
    // series of one and must not be refused by a rule written for groups.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];
    expect((await c.query(
      `SELECT o.series_leader_claim_id::text AS id, o.rebook_group_id
         FROM public.d7_p_invite_offer($1,$2) o`, [ACADEMY, claim])).rows[0])
      .toMatchObject({ id: claim, rebook_group_id: null });
    const out = await enqueue(c, { claim, round: r.round, user });
    expect(out.rows[0].skip_reason).toBeNull();
  });

  it('A CLAIM RE-CAPTURED BY A LATER ROUND IS NOT PERMANENTLY BLOCKED', async () => {
    // REVIEW ROUND 1's worst finding. The restore branch issues its transition grant for the round
    // it resolves NOW, while the outbox guard consumes that grant against the ROW's own
    // `related_rebook_round_id`. A claim captured by a second round therefore reached the first
    // round's row — same claim, same unchanged offer, same key — and its restore was refused by a
    // mismatch nothing could resolve. Every retry produced the same hard error, forever.
    //
    // The round is now part of the key, so a re-captured claim is simply a different message.
    const c = await db();
    const r1 = await seedRound(c, 1);
    await giveProfileEmails(c, r1);
    const { claim, user, profile } = r1.recipients[0];
    const first = await enqueue(c, { claim, round: r1.round, user });

    // The next round captures the same claim, for the same session, with the offer untouched.
    const digestBefore = (await c.query(
      `SELECT o.offer_digest d FROM public.d7_p_invite_offer($1,$2) o`, [ACADEMY, claim])).rows[0].d;
    const r2 = await seedRound(c, 0);
    const rec2 = (await c.query(`INSERT INTO public.rebook_round_recipients
      (rebook_round_id,academy_profile_id,recipient_player_profile_id,captured_at)
      VALUES ($1,$2,$3,clock_timestamp()) RETURNING id`, [r2.round, ACADEMY, profile])).rows[0].id;
    await c.query(`INSERT INTO public.rebook_round_recipient_claim_sources
      (rebook_round_recipient_id,rebook_round_id,academy_profile_id,source_claim_id,
       source_slot_id,source_cycle_id,claimed_player_profile_id,claim_status,captured_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',clock_timestamp()+interval '1 second')`,
    [rec2, r2.round, ACADEMY, claim, r1.recipients[0].slot, r1.cycle, profile]);
    expect((await c.query(
      `SELECT o.offer_digest d FROM public.d7_p_invite_offer($1,$2) o`, [ACADEMY, claim])).rows[0].d,
      'the OFFER is unchanged — this is about identity, not terms').toBe(digestBefore);

    // The invitation for the NEW round succeeds. Before the fix this raised, and kept raising.
    const second = await enqueue(c, { claim, round: r2.round, user });
    expect(second.rows[0].skip_reason, 'a new round is a new message, not a collision').toBeNull();
    expect(second.rows[0].outbox_id).not.toBe(first.rows[0].outbox_id);
    expect(second.rows[0].idempotency_key, 'and the two keys differ by their round')
      .not.toBe(first.rows[0].idempotency_key);

    // AND THE OLD ROW IS NOT ALSO SENDABLE. Review round 2: proving a second row can be created
    // says nothing about the first, and deleting the verdict's `round_moved` arm left this test
    // green while BOTH rows passed the verdict for the unchanged offer — two invitations for one
    // claim, under two different provider keys. The old row must be held on that exact reason.
    const held = await resolveOnce(c, first.rows[0].outbox_id, 'w-old-round');
    expect(held.disposition, 'the superseded row is not sendable').toBe('held');
    expect(held.refusal_reason, 'and it names the round having moved').toBe('round_moved');
    expect((await c.query(
      `SELECT transport_state FROM public.notification_outbox WHERE id=$1`,
      [first.rows[0].outbox_id])).rows[0].transport_state).toBe('configuration_hold');
  });

  it('RE-INVITATION — a CHANGED offer is a different message, and gets its own row', async () => {
    // The other half of A → B → A. The key carries the offer digest, so the moment the offer moves
    // the old key can no longer be reached: a re-invitation is a NEW message with a new key, and
    // the dead row for the superseded offer stays exactly where it is. A key without the digest
    // would instead collide, report `already_enqueued`, and silently never re-invite anybody.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    await c.query(`UPDATE public.availability_slots SET price_per_session = 20.00 WHERE id=$1`, [slot]);
    const first = await enqueue(c, { claim, round: r.round, user });

    // The manager re-prices the session and invites again.
    await c.query(`UPDATE public.availability_slots SET price_per_session = 24.00 WHERE id=$1`, [slot]);
    const second = await enqueue(c, { claim, round: r.round, user });

    expect(second.rows[0].outbox_id, 'a changed offer is not the same message')
      .not.toBe(first.rows[0].outbox_id);
    expect(second.rows[0].skip_reason, 'and it is not turned away as a duplicate').toBeNull();
    expect(second.rows[0].idempotency_key, 'the two keys differ by their offer digests')
      .not.toBe(first.rows[0].idempotency_key);

    const rows = await c.query(
      `SELECT transport_state FROM public.notification_outbox
        WHERE related_slot_priority_claim_id=$1 ORDER BY created_at`, [claim]);
    expect(rows.rows.length, 'two rows, one per offer').toBe(2);
    // AND THE SUPERSEDED ONE IS NOT TOUCHED. Nothing cancels it here — that is the operator's call,
    // and `RE_INVITATION_SAFETY` forbids this path from reaching back into a row it did not create.
    expect(rows.rows[0].transport_state, 'the superseded row is left exactly as it was').toBe('queued');
  });

  it('RECOVERY — a lease that expires on a row the verdict now CANCELS is not put back in the queue', async () => {
    // The second half of the deferral loop. Recovery restores a leased row to `leased_from_state`,
    // so a row leased from `queued` came back claimable no matter what had happened to its offer
    // meanwhile — the janitor undoing the very hold the resolver would have applied.
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user, slot } = r.recipients[0];
    const out = await enqueue(c, { claim, round: r.round, user });

    await c.query('SET ROLE service_role');
    const claimed = await c.query(
      `SELECT * FROM public.rebook_member_open_claim_batch($1,$2)`, ['w-recover', 10]);
    await c.query('RESET ROLE');
    expect(claimed.rows.some((x) => x.outbox_id === out.rows[0].outbox_id), 'it was leased').toBe(true);

    // The worker dies holding the lease, and the offer moves while nobody is looking.
    await c.query(`UPDATE public.availability_slots SET start_time = start_time - interval '30 minutes' WHERE id=$1`,
      [slot]);
    await c.query('SET ROLE service_role');
    await c.query(`SELECT * FROM public.rebook_member_open_recover_expired_leases(50, 0)`);
    await c.query('RESET ROLE');

    expect((await c.query(
      `SELECT transport_state FROM public.notification_outbox WHERE id=$1`,
      [out.rows[0].outbox_id])).rows[0].transport_state,
      'recovery hands it to an operator instead of back to the queue').toBe('configuration_hold');
  });

  it('RECOVERY — THE CONTROL: an unchanged offer IS returned to its exact origin', async () => {
    const c = await db();
    const r = await seedRound(c, 1);
    await giveProfileEmails(c, r);
    const { claim, user } = r.recipients[0];
    const out = await enqueue(c, { claim, round: r.round, user });
    await c.query('SET ROLE service_role');
    await c.query(`SELECT * FROM public.rebook_member_open_claim_batch($1,$2)`, ['w-recover-ok', 10]);
    await c.query(`SELECT * FROM public.rebook_member_open_recover_expired_leases(50, 0)`);
    await c.query('RESET ROLE');
    expect((await c.query(
      `SELECT transport_state, locked_by FROM public.notification_outbox WHERE id=$1`,
      [out.rows[0].outbox_id])).rows[0],
      'a live invitation goes back exactly where it came from')
      .toMatchObject({ transport_state: 'queued', locked_by: null });
  });

});
