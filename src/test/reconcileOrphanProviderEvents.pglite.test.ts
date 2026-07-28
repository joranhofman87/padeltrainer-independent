// @vitest-environment node
// 10c-a3 PR-1 — atomic orphan enrollment (apply_notification_provider_event) + bounded, claim-first reconciliation
// (migration 20261006110000). Digest bind/apply/assert are STUBBED (bind result is driven by a per-group column so
// early-orphan / poison / link states are all reachable); the real correlation semantics live in the digest suite.
import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIG = (name: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', name), 'utf8');
let db: PGlite;
const CH = 'email';

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    GRANT USAGE ON SCHEMA public TO service_role;
    CREATE TABLE public.notification_digest_groups (
      id uuid PRIMARY KEY, provider_message_id text, channel text NOT NULL, bind_result text NOT NULL DEFAULT 'ok',
      CONSTRAINT uq_g_id_pm UNIQUE (id, provider_message_id));
    CREATE TABLE public.notification_provider_events (
      resend_event_id text PRIMARY KEY, provider_message_id text NOT NULL, digest_group_id uuid,
      status text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), received_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT fk_pe_group FOREIGN KEY (digest_group_id, provider_message_id)
        REFERENCES public.notification_digest_groups(id, provider_message_id));
    CREATE TABLE public.notification_worker_runs (
      run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel text NOT NULL, phase text NOT NULL, ended_at timestamptz);
    CREATE FUNCTION public.notif_digest_assert_run(p_run_id uuid, p_phase text, p_channel text) RETURNS void
      LANGUAGE plpgsql AS $$ DECLARE r record; BEGIN
        IF p_run_id IS NULL THEN RAISE EXCEPTION 'worker run id is required'; END IF;
        SELECT * INTO r FROM public.notification_worker_runs WHERE run_id = p_run_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'run % not found', p_run_id; END IF;
        IF r.ended_at IS NOT NULL THEN RAISE EXCEPTION 'run % finished', p_run_id; END IF;
        IF p_phase IS NOT NULL AND r.phase <> p_phase THEN RAISE EXCEPTION 'phase %', r.phase; END IF;
        IF p_channel IS NOT NULL AND (r.channel IS DISTINCT FROM p_channel) THEN RAISE EXCEPTION 'channel %', r.channel; END IF; END $$;
    -- bind returns the group's configured result (drives orphan/link/error deterministically).
    CREATE FUNCTION public.notif_digest_bind_provider_message(p_group uuid, p_pm text, p_now timestamptz) RETURNS text
      LANGUAGE sql AS $$ SELECT coalesce((SELECT bind_result FROM public.notification_digest_groups WHERE id = p_group), 'missing') $$;
    CREATE FUNCTION public.notif_digest_apply_provider_transition(p_run_id uuid, p_group uuid, p_status text, p_now timestamptz) RETURNS text
      LANGUAGE sql AS $$ SELECT 'sent'::text $$;
  `);
  await db.exec(MIG('20261006110000_reconcile_orphan_provider_events.sql'));
});

const newRun = async (phase = 'dispatch', channel = CH, ended = false) =>
  (await db.query<{ run_id: string }>(`INSERT INTO notification_worker_runs (channel, phase, ended_at) VALUES ($1,$2,${ended ? 'now()' : 'NULL'}) RETURNING run_id`, [channel, phase])).rows[0].run_id;
// create a group. bindResult drives what bind returns; pmBound controls whether the group already holds the message id.
const makeGroup = async (pm: string, bindResult = 'ok', pmBound = true, channel = CH) =>
  (await db.query<{ id: string }>(`INSERT INTO notification_digest_groups (id, provider_message_id, channel, bind_result) VALUES (gen_random_uuid(),$1,$2,$3) RETURNING id`,
    [pmBound ? pm : null, channel, bindResult])).rows[0].id;
// call apply_ (the atomic enroller): tag = the group id.
const apply = (eid: string, pm: string, tag: string | null, run: string, status = 'delivered') =>
  db.query<{ r: string }>(`SELECT apply_notification_provider_event($1,$2,$3,$4,$5,now(),now()) AS r`, [run, eid, pm, tag, status]);
const reconcile = (runId: string, limit = 100, now = 'now()', channel = `'${CH}'`) =>
  db.query<{ examined: number; linked: number; errors: number; deferred: number; quarantined: number; has_more: boolean }>(
    `SELECT * FROM reconcile_orphan_provider_events($1,${channel},${now},$2)`, [runId, limit]);
// enrol a provider event + a queue row directly (the tag group is retained in the queue).
const enqueue = async (eid: string, pm: string, gid: string, channel = CH) => {
  await db.query(`INSERT INTO notification_provider_events (resend_event_id, provider_message_id, status) VALUES ($1,$2,'delivered')`, [eid, pm]);
  await db.query(`INSERT INTO notification_orphan_reconcile_state (resend_event_id, channel, digest_group_id) VALUES ($1,$2,$3)`, [eid, channel, gid]);
};
const linkedGid = async (eid: string) =>
  (await db.query<{ digest_group_id: string | null }>(`SELECT digest_group_id FROM notification_provider_events WHERE resend_event_id=$1`, [eid])).rows[0]?.digest_group_id ?? null;
const queueRow = async (eid: string) =>
  (await db.query<{ attempts: number; next_eligible_at: string; quarantined: boolean; last_error_code: string }>(
    `SELECT attempts, next_eligible_at, quarantined, last_error_code FROM notification_orphan_reconcile_state WHERE resend_event_id=$1`, [eid])).rows[0];
const queueCount = async () => (await db.query<{ n: number }>(`SELECT count(*)::int n FROM notification_orphan_reconcile_state`)).rows[0].n;

describe('atomic enrollment via apply_ (findings 1,3)', () => {
  it('a correlated callback links immediately and creates NO queue row', async () => {
    const gid = await makeGroup('pm-ok', 'ok', true);
    expect((await apply('e-ok', 'pm-ok', gid, await newRun())).rows[0].r).toBe('sent');
    expect(await linkedGid('e-ok')).toBe(gid);
    expect(await queueCount()).toBe(0);
  });

  it('an early orphan stores the event AND enrols a queue row in ONE call, channel derived from the tag', async () => {
    const gid = await makeGroup('pm-early', 'no_live_send', /*pmBound*/ false); // group exists, not yet bound/sent
    expect((await apply('e-early', 'pm-early', gid, await newRun())).rows[0].r).toBe('orphan');
    expect(await linkedGid('e-early')).toBeNull();
    const q = await queueRow('e-early');
    expect(q).toBeDefined();       // enrolled atomically
    expect(q.attempts).toBe(0);
    // channel was DERIVED from the tag's group (never caller-supplied)
    expect((await db.query<{ channel: string }>(`SELECT channel FROM notification_orphan_reconcile_state WHERE resend_event_id='e-early'`)).rows[0].channel).toBe(CH);
  });

  it('a duplicate webhook retry is a no-op (one event, one queue row)', async () => {
    const gid = await makeGroup('pm-dup', 'no_live_send', false);
    const run = await newRun();
    await apply('e-dup', 'pm-dup', gid, run);
    expect((await apply('e-dup', 'pm-dup', gid, await newRun())).rows[0].r).toBe('duplicate');
    expect(await queueCount()).toBe(1);
  });
});

describe('mandatory digest contract + continuation + queue ACL (round-5 findings 1,3,4)', () => {
  it('a callback with no derivable group returns not_digest — no event, no queue row', async () => {
    // no tag + a provider_message_id that matches no group → not a digest event
    expect((await apply('e-nd', 'pm-unknown', null, await newRun())).rows[0].r).toBe('not_digest');
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM notification_provider_events WHERE resend_event_id='e-nd'`)).rows[0].n).toBe(0);
    expect(await queueCount()).toBe(0);
  });

  it('never returns orphan without enrolling: an early orphan always leaves a queue row', async () => {
    const gid = await makeGroup('pm-inv', 'no_live_send', /*pmBound*/ false);
    expect((await apply('e-inv', 'pm-inv', gid, await newRun())).rows[0].r).toBe('orphan');
    expect(await queueRow('e-inv')).toBeDefined();   // enrolled — no lost-event path
  });

  it('has_more = examined==p_limit (concurrency-safe drain, not a plain EXISTS): loop until a short pass', async () => {
    for (const [e, pm] of [['m1', 'pm-m1'], ['m2', 'pm-m2']] as const) {
      const gid = await makeGroup(pm, 'ok', true);
      await enqueue(e, pm, gid);
    }
    // p_limit+1 due rows: a FULL batch (examined==limit) can never report complete, even with errors=0.
    const r1 = (await reconcile(await newRun(), 1)).rows[0];
    expect(r1).toMatchObject({ examined: 1, linked: 1, has_more: true });
    const r2 = (await reconcile(await newRun(), 1)).rows[0];
    expect(r2).toMatchObject({ examined: 1, linked: 1, has_more: true }); // full batch → still "keep draining"
    const r3 = (await reconcile(await newRun(), 1)).rows[0];
    expect(r3).toMatchObject({ examined: 0, has_more: false });           // short pass ends the caller loop
    expect(await queueCount()).toBe(0);
  });

  it('the queue table is SELECT-only for service_role (mutations are owner-only)', async () => {
    await db.exec(`SET ROLE service_role`);
    await expect(db.query(`INSERT INTO notification_orphan_reconcile_state (resend_event_id, channel, digest_group_id) VALUES ('x',$1,gen_random_uuid())`, [CH])).rejects.toThrow(/permission denied/i);
    await expect(db.query(`DELETE FROM notification_orphan_reconcile_state`)).rejects.toThrow(/permission denied/i);
    await expect(db.query(`UPDATE notification_orphan_reconcile_state SET quarantined=false`)).rejects.toThrow(/permission denied/i);
    await db.query(`SELECT count(*) FROM notification_orphan_reconcile_state`); // SELECT is allowed
    await db.exec(`RESET ROLE`);
  });
});

describe('run-attribution + event-first idempotency (round-9 findings 2,3)', () => {
  it('apply validates a supplied run as an UNFINISHED email/dispatch run before attribution', async () => {
    const gid = await makeGroup('pm-rv', 'ok', true);
    // NEW event + a bad run → raise before any mutation (missing / finished / materialize / whatsapp)
    await expect(apply('e-rv1', 'pm-rv', gid, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/);
    await expect(apply('e-rv2', 'pm-rv', gid, await newRun('dispatch', CH, /*ended*/ true))).rejects.toThrow(/finished/);
    await expect(apply('e-rv3', 'pm-rv', gid, await newRun('materialize'))).rejects.toThrow(/phase/);
    await expect(apply('e-rv4', 'pm-rv', gid, await newRun('dispatch', 'whatsapp'))).rejects.toThrow(/channel/);
    // none of the rejected NEW events were stored
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM notification_provider_events WHERE resend_event_id LIKE 'e-rv%'`)).rows[0].n).toBe(0);
  });

  it('a duplicate stays idempotent AFTER its group is deleted (event checked BEFORE tag validation)', async () => {
    const gid = await makeGroup('pm-idem', 'no_live_send', false);
    expect((await apply('e-idem', 'pm-idem', gid, await newRun())).rows[0].r).toBe('orphan');
    await db.query(`DELETE FROM notification_digest_groups WHERE id=$1`, [gid]);   // group purged
    // the retry must NOT raise unknown/stale — the already-recorded event short-circuits to duplicate
    expect((await apply('e-idem', 'pm-idem', gid, await newRun())).rows[0].r).toBe('duplicate');
  });

  it('an event-id collision (same id, different provider payload) fails loudly', async () => {
    const gid = await makeGroup('pm-coll', 'ok', true);
    await apply('e-coll', 'pm-coll', gid, await newRun());                        // recorded pm=pm-coll/delivered
    await expect(apply('e-coll', 'pm-DIFFERENT', gid, await newRun())).rejects.toThrow(/collision/);
    await expect(apply('e-coll', 'pm-coll', gid, await newRun(), 'bounced')).rejects.toThrow(/collision/);
  });

  it('a NULL-run apply is allowed (webhook path) and still idempotent', async () => {
    const gid = await makeGroup('pm-nr', 'no_live_send', false);
    expect((await db.query<{ r: string }>(`SELECT apply_notification_provider_event(NULL,'e-nr','pm-nr',$1,'delivered',now(),now()) r`, [gid])).rows[0].r).toBe('orphan');
    expect((await db.query<{ r: string }>(`SELECT apply_notification_provider_event(NULL,'e-nr','pm-nr',$1,'delivered',now(),now()) r`, [gid])).rows[0].r).toBe('duplicate');
  });
});

describe('tag-faithful correlation: no reassignment, loud invalid tags (round-6 findings 1,2)', () => {
  it('a TAGGED MISMATCH is quarantined + never reassigned to whatever group holds the message id', async () => {
    // tag=A, but the callback carries pm-B (owned by a different group B). apply → mismatch (A bound pm-A ≠ pm-B).
    const gA = await makeGroup('pm-A', 'mismatch', /*pmBound*/ true);
    await makeGroup('pm-B', 'ok', /*pmBound*/ true);             // B genuinely owns pm-B — the tempting wrong target
    expect((await apply('e-mm', 'pm-B', gA, await newRun())).rows[0].r).toBe('mismatch');
    // the queue retains the ORIGINAL tag (A), not B
    expect((await db.query<{ g: string }>(`SELECT digest_group_id g FROM notification_orphan_reconcile_state WHERE resend_event_id='e-mm'`)).rows[0].g).toBe(gA);
    const res = (await reconcile(await newRun())).rows[0];
    expect(res).toMatchObject({ examined: 1, linked: 0, errors: 1 });
    expect(res.quarantined).toBe(1);                             // quarantined, distinct from deferred
    expect((await queueRow('e-mm')).quarantined).toBe(true);
    expect(await linkedGid('e-mm')).toBeNull();                  // NEVER linked — not to A, and CRUCIALLY not to B
    expect(res.deferred).toBe(0);
  });

  it('a present but UNKNOWN/stale tag fails LOUDLY (not laundered into not_digest, no event stored)', async () => {
    await expect(apply('e-stale-tag', 'pm-x', '00000000-0000-0000-0000-000000000000', await newRun()))
      .rejects.toThrow(/unknown\/stale digest_group_id/);
    expect(await queueCount()).toBe(0);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM notification_provider_events WHERE resend_event_id='e-stale-tag'`)).rows[0].n).toBe(0);
  });

  it('a tag pointing at a NON-email group fails loudly (this Resend path is email-only)', async () => {
    const gw = await makeGroup('pm-wa', 'ok', true, /*channel*/ 'whatsapp');
    await expect(apply('e-wa', 'pm-wa', gw, await newRun())).rejects.toThrow(/is channel whatsapp, not email/);
  });

  it('an untagged callback matching a non-email group is not_digest (not this path’s concern)', async () => {
    await makeGroup('pm-wa2', 'ok', true, 'whatsapp');
    expect((await apply('e-wa2', 'pm-wa2', null, await newRun())).rows[0].r).toBe('not_digest');
    expect(await queueCount()).toBe(0);
  });

});

describe('audited recovery: requeue (transient only) vs resolve (permanent) — round-7 finding 1', () => {
  const requeue = (eid: string, actor = 'ops', reason = 'group re-sent') =>
    db.query<{ ok: boolean }>(`SELECT notification_orphan_reconcile_requeue($1,$2,$3) ok`, [eid, actor, reason]);
  const resolve = (eid: string, actor = 'ops', reason = 'confirmed bad tag; acknowledged') =>
    db.query<{ ok: boolean }>(`SELECT notification_orphan_reconcile_resolve($1,$2,$3) ok`, [eid, actor, reason]);
  const auditRows = async (eid: string) =>
    (await db.query<{ action: string; actor: string; reason: string; prior_error_code: string }>(
      `SELECT action, actor, reason, prior_error_code FROM notification_orphan_reconcile_actions WHERE resend_event_id=$1 ORDER BY id`, [eid])).rows;
  // quarantine a PERMANENT tagged_mismatch
  const seedMismatch = async (eid: string) => {
    const gA = await makeGroup(`${eid}-A`, 'mismatch', true);
    await makeGroup(`${eid}-B`, 'ok', true);
    await apply(eid, `${eid}-B`, gA, await newRun());
    await reconcile(await newRun());
    expect((await queueRow(eid)).quarantined).toBe(true);
  };

  it('a PERMANENT tagged_mismatch CANNOT be blindly requeued (would just re-quarantine)', async () => {
    await seedMismatch('e-perm');
    await expect(requeue('e-perm')).rejects.toThrow(/PERMANENT reason \(tagged_mismatch\)/);
    expect((await queueRow('e-perm')).quarantined).toBe(true);   // untouched
    expect(await auditRows('e-perm')).toHaveLength(0);           // rejected before any audit write
  });

  it('resolve durably acknowledges a mismatch (actor/reason/time), DEQUEUES it, and preserves the provider event', async () => {
    await seedMismatch('e-res');
    expect((await resolve('e-res')).rows[0].ok).toBe(true);
    expect(await queueRow('e-res')).toBeUndefined();             // operational backlog cleared
    // the provider event is preserved (only the queue row was removed)
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM notification_provider_events WHERE resend_event_id='e-res'`)).rows[0].n).toBe(1);
    const audit = await auditRows('e-res');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'resolve', actor: 'ops', prior_error_code: 'tagged_mismatch' });
    // a subsequent reconcile no longer reports it as quarantined backlog
    expect((await reconcile(await newRun())).rows[0].quarantined).toBe(0);
  });

  it('a TRANSIENT link failure CAN be requeued (audited) and becomes eligible again', async () => {
    const gid = await makeGroup('pm-tr', 'missing', /*pmBound*/ true);   // link raises → transient SQLSTATE, quarantines after cap
    await apply('e-tr', 'pm-tr', gid, await newRun());
    for (let i = 0; i < 8; i++) await reconcile(await newRun(), 100, `now() + interval '${(i + 1) * 5000} minutes'`);
    expect((await queueRow('e-tr')).quarantined).toBe(true);
    expect((await requeue('e-tr', 'ops', 'provider outage cleared')).rows[0].ok).toBe(true);
    const q = await queueRow('e-tr');
    expect(q).toMatchObject({ quarantined: false, attempts: 0, last_error_code: 'requeued' });
    expect((await auditRows('e-tr'))[0]).toMatchObject({ action: 'requeue', actor: 'ops' });
  });

  it('both recovery functions are OWNER-ONLY and require a non-blank actor + reason', async () => {
    await seedMismatch('e-acl');
    await db.exec(`SET ROLE service_role`);
    await expect(db.query(`SELECT notification_orphan_reconcile_requeue('e-acl','a','b')`)).rejects.toThrow(/permission denied/i);
    await expect(db.query(`SELECT notification_orphan_reconcile_resolve('e-acl','a','b')`)).rejects.toThrow(/permission denied/i);
    await db.exec(`RESET ROLE`);
    await expect(resolve('e-acl', '', 'r')).rejects.toThrow(/p_actor is required/);
    await expect(resolve('e-acl', 'a', '  ')).rejects.toThrow(/p_reason is required/);
  });

  it('the actions audit table is append-only (no UPDATE/DELETE to anyone, SELECT for service_role)', async () => {
    await seedMismatch('e-app');
    await resolve('e-app');
    await db.exec(`SET ROLE service_role`);
    await db.query(`SELECT count(*) FROM notification_orphan_reconcile_actions`);   // SELECT allowed
    await expect(db.query(`UPDATE notification_orphan_reconcile_actions SET reason='x'`)).rejects.toThrow(/permission denied/i);
    await expect(db.query(`DELETE FROM notification_orphan_reconcile_actions`)).rejects.toThrow(/permission denied/i);
    await db.exec(`RESET ROLE`);
  });

  it('the audit is OWNER-EFFECTIVELY append-only: even the owner cannot UPDATE/DELETE (immutable-row trigger)', async () => {
    await seedMismatch('e-imm');
    await resolve('e-imm');   // one audit row, as owner
    // as the table OWNER (grants do not restrain the owner — the trigger does):
    await expect(db.query(`UPDATE notification_orphan_reconcile_actions SET actor='forged', reason='rewritten'`)).rejects.toThrow(/append-only/i);
    await expect(db.query(`DELETE FROM notification_orphan_reconcile_actions`)).rejects.toThrow(/append-only/i);
    // the original row is intact
    expect((await db.query<{ actor: string }>(`SELECT actor FROM notification_orphan_reconcile_actions WHERE resend_event_id='e-imm'`)).rows[0].actor).toBe('ops');
  });

  it('resolve REFUSES to discard active/transient work (round-8 finding 2)', async () => {
    // (a) a non-quarantined not_ready row is live — resolve must refuse
    const g1 = await makeGroup('pm-live', 'no_live_send', /*pmBound*/ false);
    await apply('e-live', 'pm-live', g1, await newRun());
    await reconcile(await newRun());                             // → deferred (not_ready), NOT quarantined
    expect((await queueRow('e-live')).quarantined).toBe(false);
    await expect(resolve('e-live')).rejects.toThrow(/not quarantined/);
    expect(await queueRow('e-live')).toBeDefined();             // still enqueued — nothing lost
    // (b) a quarantined TRANSIENT (link-exception) row must be requeued, not resolved
    const g2 = await makeGroup('pm-trans', 'missing', /*pmBound*/ true);
    await apply('e-trans', 'pm-trans', g2, await newRun());
    for (let i = 0; i < 8; i++) await reconcile(await newRun(), 100, `now() + interval '${(i + 1) * 5000} minutes'`);
    const q = await queueRow('e-trans');
    expect(q.quarantined).toBe(true);
    expect(q.last_error_code).not.toMatch(/tagged_/);           // a transient SQLSTATE, not a permanent reason
    await expect(resolve('e-trans')).rejects.toThrow(/not a KNOWN permanent reason/);
    expect(await queueRow('e-trans')).toBeDefined();            // retained for requeue
  });

  it('resolve is FAIL-CLOSED for a NULL / unknown reason (round-8 finding 5)', async () => {
    // the CHECK forbids a NULL reason on a quarantined row, so seed a quarantined row with an UNKNOWN (non-permanent)
    // reason directly (owner) and confirm resolve refuses it — permanent_reason(...) IS NOT TRUE.
    const gid = await makeGroup('pm-unk', 'no_live_send', false);
    await apply('e-unk', 'pm-unk', gid, await newRun());
    await db.query(`UPDATE notification_orphan_reconcile_state SET quarantined=true, attempts=1, last_error_code='some_unrecognized_code' WHERE resend_event_id='e-unk'`);
    await expect(resolve('e-unk')).rejects.toThrow(/not a KNOWN permanent reason/);
    expect(await queueRow('e-unk')).toBeDefined();
  });

  it('a quarantined row MUST carry a reason (CHECK chk_orphan_quarantine_reason)', async () => {
    const gid = await makeGroup('pm-chk', 'no_live_send', false);
    await apply('e-chk', 'pm-chk', gid, await newRun());
    await expect(db.query(`UPDATE notification_orphan_reconcile_state SET quarantined=true, attempts=1, last_error_code=NULL WHERE resend_event_id='e-chk'`))
      .rejects.toThrow(/chk_orphan_quarantine_reason/);
  });
});

describe('deleted tagged group is PERMANENT, not temporarily unbound — round-7 finding 2', () => {
  it('a missing tagged group quarantines IMMEDIATELY as tagged_group_missing (no 8 pointless retries)', async () => {
    const gid = await makeGroup('pm-del', 'no_live_send', /*pmBound*/ false);
    await apply('e-del', 'pm-del', gid, await newRun());          // enrol (early orphan shape)
    await db.query(`DELETE FROM notification_digest_groups WHERE id=$1`, [gid]);   // group deleted out from under it
    const res = (await reconcile(await newRun())).rows[0];
    expect(res).toMatchObject({ examined: 1, linked: 0, errors: 1, quarantined: 1 });
    const q = await queueRow('e-del');
    expect(q.quarantined).toBe(true);                            // immediate, on the FIRST pass
    expect(q.attempts).toBe(1);
    expect(q.last_error_code).toBe('tagged_group_missing');
  });

  it('an existing-but-unbound group still only DEFERS (not quarantined) — the distinction holds', async () => {
    const gid = await makeGroup('pm-unb', 'no_live_send', /*pmBound*/ false);
    await apply('e-unb', 'pm-unb', gid, await newRun());          // group EXISTS, provider_message_id NULL
    const res = (await reconcile(await newRun())).rows[0];
    expect(res).toMatchObject({ examined: 1, deferred: 1, quarantined: 0 });
    const q = await queueRow('e-unb');
    expect(q.quarantined).toBe(false);
    expect(q.last_error_code).toBe('not_ready');
  });
});

describe('claim-first reconcile: early orphan → deferred → later links (finding 2)', () => {
  it('an unmatched early orphan is DEFERRED (observable), then links once its group binds — no residue', async () => {
    const gid = await makeGroup('pm-e2', 'no_live_send', /*pmBound*/ false);
    await apply('e2', 'pm-e2', gid, await newRun());
    let res = (await reconcile(await newRun())).rows[0];
    expect(res).toMatchObject({ examined: 1, linked: 0, errors: 0 });   // group not bound yet
    expect(res.deferred).toBe(1);
    const q1 = await queueRow('e2');
    expect(q1.attempts).toBe(1);
    expect(new Date(q1.next_eligible_at).getTime()).toBeGreaterThan(Date.now()); // durably deferred
    // the send completes: the group binds its provider_message_id and can now correlate.
    await db.query(`UPDATE notification_digest_groups SET provider_message_id='pm-e2', bind_result='ok' WHERE id=$1`, [gid]);
    res = (await reconcile(await newRun(), 100, `now() + interval '999 minutes'`)).rows[0]; // past the backoff
    expect(res.linked).toBe(1);
    expect(await linkedGid('e2')).toBe(gid);
    expect(await queueCount()).toBe(0);                                  // no residue
  });
});

describe('stale queue cleanup + no residue (finding 5)', () => {
  it('a queue row whose event is already linked is CLEANED UP (no linker call, no residue)', async () => {
    const gid = await makeGroup('pm-stale', 'ok', true);
    // event already linked, but a stale queue row exists (e.g. enqueued then linked by another path)
    await db.query(`INSERT INTO notification_provider_events (resend_event_id, provider_message_id, digest_group_id, status) VALUES ('e-stale','pm-stale',$1,'delivered')`, [gid]);
    await db.query(`INSERT INTO notification_orphan_reconcile_state (resend_event_id, channel, digest_group_id) VALUES ('e-stale',$1,$2)`, [CH, gid]);
    const res = (await reconcile(await newRun())).rows[0];
    expect(res).toMatchObject({ examined: 1, linked: 0, errors: 0 });
    expect(await queueCount()).toBe(0);   // stale row cleaned, zero residue
  });
});

describe('fail-loud input + run-attribution boundary (findings 4,7)', () => {
  it('rejects NULL/blank channel and out-of-range p_limit', async () => {
    await expect(reconcile(await newRun(), 100, 'now()', 'NULL')).rejects.toThrow(/p_channel is required/);
    await expect(reconcile(await newRun(), 100, 'now()', `''`)).rejects.toThrow(/p_channel is required/);
    await expect(reconcile(await newRun(), 0)).rejects.toThrow(/p_limit must be between 1 and 1000/);
    await expect(reconcile(await newRun(), 1001)).rejects.toThrow(/p_limit must be between 1 and 1000/);
  });
  it('rejects NULL / missing / finished / wrong-phase / wrong-channel runs', async () => {
    await expect(reconcile('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/);
    await expect(reconcile(await newRun('dispatch', CH, true))).rejects.toThrow(/finished/);
    await expect(reconcile(await newRun('materialize'))).rejects.toThrow(/phase/);
    await expect(reconcile(await newRun('dispatch', 'whatsapp'))).rejects.toThrow(/channel/);
  });
  it('BOTH linker overloads are OWNER-ONLY (service_role cannot link/apply outside reconcile)', async () => {
    await db.exec(`SET ROLE service_role`);
    await expect(db.query(`SELECT link_notification_provider_event('x', gen_random_uuid())`)).rejects.toThrow(/permission denied/i);
    await expect(db.query(`SELECT link_notification_provider_event('x', gen_random_uuid(), gen_random_uuid(), now())`)).rejects.toThrow(/permission denied/i);
    await db.exec(`RESET ROLE`);
  });
});

describe('poison-row starvation guard (finding 4)', () => {
  const seedPoison = async (eid: string, pm: string) => {
    const gid = await makeGroup(pm, 'missing', /*pmBound*/ true); // discoverable, but link bind → 'missing' (fails)
    await apply(eid, pm, gid, await newRun());                    // apply: bind 'missing' → orphan + enrol
    return gid;
  };
  it('a poison orphan is counted, backed off, and NOT re-examined until its backoff elapses', async () => {
    await seedPoison('p1', 'POISON-1');
    const res = (await reconcile(await newRun())).rows[0];
    expect(res).toMatchObject({ examined: 1, linked: 0, errors: 1 });
    expect((await queueRow('p1')).attempts).toBe(1);
    const res2 = (await reconcile(await newRun())).rows[0];       // immediate second pass, before backoff elapses
    expect(res2.examined).toBe(0);
    expect((await queueRow('p1')).attempts).toBe(1);              // not retried early
    expect(res2.deferred).toBe(1);
  });
  it('SCALE PIN: deferred poison rows do NOT block a later valid orphan', async () => {
    for (let i = 0; i < 3; i++) await seedPoison(`old${i}`, `POISON-${i}`);
    await reconcile(await newRun());                              // poison rows fail once → deferred
    // enrol a valid orphan (tag group bound to its message id) that will link this pass:
    const g2 = await makeGroup('pm-v2', 'ok', true);
    await enqueue('v2', 'pm-v2', g2);
    const res = (await reconcile(await newRun(), 2)).rows[0];
    expect(await linkedGid('v2')).toBe(g2);                       // later valid row progressed
    expect(res.examined).toBeLessThanOrEqual(2);                 // the 3 deferred poison rows were excluded
    expect(res.deferred).toBe(3);
  });
  it('quarantines after the attempt cap and is then excluded, reported via quarantined (not deferred)', async () => {
    await seedPoison('q1', 'POISON-Q');
    for (let i = 0; i < 8; i++) await reconcile(await newRun(), 100, `now() + interval '${(i + 1) * 5000} minutes'`);
    expect((await queueRow('q1')).quarantined).toBe(true);
    const res = (await reconcile(await newRun(), 100, `now() + interval '9999999 minutes'`)).rows[0];
    expect(res.examined).toBe(0);
    expect(res.quarantined).toBe(1);   // permanent backlog is distinct from temporary deferral
    expect(res.deferred).toBe(0);
  });
});
