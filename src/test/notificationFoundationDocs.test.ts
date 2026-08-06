import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * N6 — the DRIFT PINS for the two canonical notification documents.
 *
 * `docs/NOTIFICATION_FOUNDATION.md` and `docs/NOTIFICATION_OPERATIONS.md` make claims an operator
 * acts on: which controls exist, what refuses what, which paths are inert, where the boundary is
 * enforced. A document nothing enforces rots into a lie — the attribution matrix earned that
 * lesson (`notificationAttributionMatrix.test.ts`), and these are the same device for the same
 * reason.
 *
 * What is pinned here is deliberately narrow: claims that would become FALSE if the code changed,
 * checked against the code rather than against the prose. Wording, ordering and structure are not
 * pinned — a doc test that fails on an edited sentence teaches people to stop editing sentences.
 */

const ROOT = resolve(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(resolve(ROOT, ...p), 'utf8');
const FOUNDATION = read('docs', 'NOTIFICATION_FOUNDATION.md');
const OPERATIONS = read('docs', 'NOTIFICATION_OPERATIONS.md');
const MIGRATIONS = resolve(ROOT, 'supabase', 'migrations');
const migration = (f: string) => read('supabase', 'migrations', f);
/** the newest migration text that defines a given function — the definition production runs */
/** the newest definition of ONE function, body only — file-wide counts would blend functions */
const bodyOfNewest = (fn: string) => {
  const src = newestDefining(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  const start = src.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  const term = /\n(?:END\s+)?\$\$;\n/g;
  term.lastIndex = start;
  const m = term.exec(src);
  if (!m) throw new Error(`${fn}: unterminated definition`);
  return src.slice(start, m.index + m[0].length);
};

const newestDefining = (needle: string) => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  const hit = files.filter((f) => migration(f).includes(needle)).pop();
  if (!hit) throw new Error(`no migration defines ${needle}`);
  return migration(hit);
};

describe('N6 doc pins — the foundation reference', () => {
  it('the delivery paths it names are exactly the ones the schema allows', () => {
    const sql = migration('20261028100000_notif_n5_activation_boundary.sql');
    const allowed = sql.match(/path\s+text PRIMARY KEY CHECK \(path IN \(([^)]*)\)\)/)?.[1];
    expect(allowed).toBeTruthy();
    const paths = [...allowed!.matchAll(/'([a-z:]+)'/g)].map((m) => m[1]);
    expect(paths.sort()).toEqual(['email:digest', 'email:instant', 'whatsapp:instant']);
    for (const p of paths) expect(FOUNDATION).toContain(p);
  });

  it('the boundary is enforced at every authority the doc lists — and the doc lists every one', () => {
    // the three claims, each checked against the function that must carry the gate
    const claims: [string, string][] = [
      ['claim_notification_outbox_batch', 'notif_activation_boundary(p_channel || \':instant\')'],
      ['materialize_notification_digest_groups', 'notif_activation_boundary(p_channel || \':digest\')'],
      ['claim_notification_digest_group', 'notif_activation_boundary(p_channel || \':digest\')'],
    ];
    for (const [fn, gate] of claims) {
      expect(FOUNDATION).toContain(fn);
      const src = newestDefining(`CREATE OR REPLACE FUNCTION public.${fn}(`);
      expect(src, `${fn} must read its path's boundary`).toContain(gate);
      expect(src, `${fn} must refuse an inert path`).toMatch(/v_boundary IS NULL THEN\s*\n\s*RETURN/);
    }
  });

  it('the live path really is seeded UNBOUNDED, and the other two really are inert', () => {
    const sql = migration('20261028100000_notif_n5_activation_boundary.sql');
    expect(sql).toContain("VALUES ('email:instant', 'active', '-infinity'::timestamptz,");
    expect(sql).toMatch(/VALUES \('email:digest', 'inert'\), \('whatsapp:instant', 'inert'\)/);
    expect(FOUNDATION).toContain('-infinity');
    expect(OPERATIONS).toContain('seeded **inert**');
  });

  it('the outbox skip reasons the doc enumerates are the ones the code writes', () => {
    const resolver = newestDefining('CREATE OR REPLACE FUNCTION public.enqueue_notification(');
    for (const reason of ['preference_off', 'tenant_restricted', 'no_email_contact', 'email_suppressed',
                          'marketing_unsubscribed', 'no_deliverable_channel']) {
      expect(resolver, `the resolver must write ${reason}`).toContain(`'${reason}'`);
      expect(FOUNDATION, `the doc must list ${reason}`).toContain(reason);
    }
    // …and the one N5 adds, written by the disposal rather than the resolver
    expect(migration('20261029100000_notif_n5_readiness_and_backlog_disposal.sql'))
      .toContain("skip_reason = 'pre_activation_boundary'");
    expect(FOUNDATION).toContain('pre_activation_boundary');
  });

  it('the digest group states the doc lists are exactly the schema CHECK', () => {
    const sql = migration('20261002100000_notification_digest_schema_foundation.sql');
    const block = sql.match(/state\s+text NOT NULL DEFAULT 'pending' CHECK \(state IN\s*\n([\s\S]*?)\)\),/)?.[1];
    expect(block).toBeTruthy();
    const states = [...block!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(states.length).toBeGreaterThan(5);
    for (const s of states) expect(FOUNDATION, `the doc must name the ${s} state`).toContain(s);
  });

  it('the instant path\'s duplicate prevention is what the doc says it is: ONE stable key', () => {
    // the doc now claims duplicates are prevented by the PROVIDER's dedup window rather than by
    // never retrying, and that claim is only true while the key is derived from durable identity.
    // An attempt-dependent key would make every retry a new message at the provider.
    const worker = read('supabase', 'functions', 'notification-email-worker', 'index.ts');
    expect(worker).toContain('idempotencyKey: `notification-outbox-${row.outbox_id}`');
    const adapter = read('supabase', 'functions', '_shared', 'resend-send.ts');
    // the header is set ONCE, outside the attempt loop — inside it, a per-attempt key could creep in
    const headerAt = adapter.indexOf('headers["Idempotency-Key"]');
    const loopAt = adapter.indexOf('for (let attempt = 1');
    expect(headerAt).toBeGreaterThan(0);
    expect(headerAt).toBeLessThan(loopAt);
    expect(FOUNDATION).toContain('notification-outbox-<row id>');
    expect(FOUNDATION).toContain('across every attempt, requeue and');
  });

  it('the activation boundary compares EVENT-OCCURRENCE time, at every send authority', () => {
    // The claim "only events at or after the boundary" used to be only as true as "producers
    // enqueue at event time" — and none of them strictly does. The occurrence clock is what makes
    // it enforceable, so these pin that it exists, that it is checked everywhere, and that the
    // document describes the system that ships rather than the one that was planned.
    const claim = bodyOfNewest('claim_notification_outbox_batch');
    expect(claim).toContain('o.created_at >= v_boundary');
    expect(claim).toContain('o.occurred_at >= v_min_occurred');       // BOTH clocks, both arms
    const mat = bodyOfNewest('materialize_notification_digest_groups');
    expect(mat.match(/o\.occurred_at >= v_min_occurred/g) ?? []).toHaveLength(2);  // candidate + member scans
    const dispatch = bodyOfNewest('claim_notification_digest_group');
    expect(dispatch.match(/o\.occurred_at < v_min_occurred/g) ?? []).toHaveLength(2);  // scan + breaker probe

    const resolver = bodyOfNewest('enqueue_notification');
    expect(resolver).toMatch(/p_occurred_at\s+timestamptz/);         // the parameter exists…
    expect(resolver).toContain('is in the future');                   // …and cannot be laundered forward

    // the floor is the LATER of the boundary and the age ceiling — which is the only reason the
    // contract means anything on email:instant, whose boundary is -infinity
    const floor = bodyOfNewest('notif_activation_min_occurred_at');
    expect(floor).toContain('greatest(b.boundary_at');
    expect(floor).toContain('max_event_age_minutes');

    expect(FOUNDATION).toContain('the one that counts is the event');
    expect(FOUNDATION).toContain('Pass `p_occurred_at`, derived from the domain row');
    // the doc must NOT still carry the admission it was written to make honest
    expect(FOUNDATION).not.toContain('not an event-occurrence timestamp, because the pipeline');
  });

  it('the marketing unsubscribe the footer promises is READ by the resolver (the N2<->N3 seam)', () => {
    const resolver = newestDefining('CREATE OR REPLACE FUNCTION public.enqueue_notification(');
    expect(resolver).toContain('is_marketing_suppressed');
    expect(resolver).toContain("email_footer_policy = 'marketing_unsubscribe'");
    // …and at SEND time too: enqueue and delivery are separated in time, and the live gate both
    // paths delegate to is where a row queued before the unsubscribe gets stopped
    const live = newestDefining('CREATE OR REPLACE FUNCTION public.notif_digest_member_stop_reason(');
    expect(live).toContain('is_marketing_suppressed');
    expect(live).toContain("RETURN 'marketing_unsubscribed'");
    // scope-aware: platform silences everything, a tenant one only that tenant
    expect(resolver).toContain("is_marketing_suppressed(v_dest, 'platform', NULL)");
    expect(resolver).toContain("'academy', p_tenant_academy_profile_id");
    expect(FOUNDATION).toContain('marketing_unsubscribed');
  });

  it('required delivery is applied LAST for email, as the precedence table claims', () => {
    const resolver = newestDefining('CREATE OR REPLACE FUNCTION public.enqueue_notification(');
    const cap = resolver.indexOf('academy_notification_restrictions');
    const required = resolver.indexOf("IF v_evt.required_delivery AND v_channel = 'email' THEN");
    expect(cap).toBeGreaterThan(0);
    expect(required).toBeGreaterThan(cap);   // the cap cannot weaken a required send
  });

  it('the unsupported channel really is decided before any resolution, as section 2 claims', () => {
    const resolver = newestDefining('CREATE OR REPLACE FUNCTION public.enqueue_notification(');
    const skip = resolver.indexOf('CONTINUE WHEN NOT v_supports;');
    const prefs = resolver.indexOf('notification_preferences_v2');
    expect(skip).toBeGreaterThan(0);
    expect(prefs).toBeGreaterThan(skip);
  });
});

describe('N6 doc pins — the operations reference', () => {
  it('every admin control the doc names exists, and no control exists that the doc does not name', () => {
    // the complete admin surface, from the migrations that define it
    // the NOTIFICATION admin surface only: other domains have their own admin_* functions and
    // their own docs, and sweeping them in here would make this pin fail for someone else's change
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && /notif/i.test(f));
    const fns = new Set<string>();
    for (const f of files) {
      for (const m of migration(f).matchAll(/CREATE OR REPLACE FUNCTION public\.(admin_[a-z_]+)\(/g)) fns.add(m[1]);
    }
    // …minus the pure reads, which the surface table covers as sections rather than by name
    const controls = [...fns].filter((n) => !/^admin_(list|notification|preview|search)_/.test(n)).sort();
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) {
      // a control the operations doc never mentions is a control nobody was told how to use
      const verb = c.replace(/^admin_/, '').split('_')[0];
      expect(OPERATIONS.toLowerCase(), `${c} is undocumented`).toContain(verb);
    }
    // and the doctrine that made this surface disable-only
    for (const c of controls) expect(c).not.toMatch(/retry|resend|redeliver/);
    expect(OPERATIONS).toContain('No control here resends anything');
    // …and the doc must not claim the WORKERS never retry: the instant one does, under a stable
    // key, and an on-call reader comparing a row's history to the docs must not be misled
    expect(OPERATIONS).toContain('The instant worker retries a row it');
    // …and it must warn about the one case where a retry can duplicate: an outage longer than
    // the provider's dedup window, which nothing in this repository bounds
    expect(OPERATIONS).toContain('After prolonged downtime');
    expect(OPERATIONS).toContain('not-before condition');
    // …and the mitigation it prescribes must EXIST. A documented recovery nobody can execute reads
    // as safety while leaving the operator to improvise SQL against production.
    for (const fn of ['admin_stale_outbox_preview', 'admin_dispose_stale_outbox']) {
      expect(OPERATIONS, `the doc must name ${fn}`).toContain(fn);
      const src = newestDefining(`CREATE OR REPLACE FUNCTION public.${fn}(`);
      // …and it must be RUNNABLE where the doc sends the operator. Both are admin-gated on
      // auth.uid(), so a psql runbook cannot execute them — the page is the only surface that
      // carries the session, and a procedure that names a control the operator cannot reach is
      // the same defect as one that names a control that does not exist.
      expect(src, `${fn} must be admin-gated`).toMatch(/notif_admin_gate\(\)|has_role\(auth\.uid\(\), 'admin'\)/);
      // "reachable from the page" means the page OR the admin modules it composes — the decision
      // itself lives in useOpsDecision so the page stays a thin orchestrator, and a pin that only
      // looked at the page would push the call back into it to stay green.
      const surface = ['AdminNotificationOps.tsx'].map((f) => read('src', 'pages', 'admin', f))
        .concat(['StaleOutboxSection.tsx', 'useOpsDecision.ts']
          .map((f) => read('src', 'components', 'notifications', 'admin', f)))
        .join('\n');
      expect(surface, `${fn} must be reachable from the admin page`).toContain(fn);
    }
    expect(OPERATIONS).toContain('/admin/notifications` → After a long outage');
  });

  it('the rollout steps the doc tables are the subcommands the runner actually has', () => {
    const sh = read('scripts', 'rollout', 'notif-10cb', 'run-enablement.sh');
    const steps = [...sh.matchAll(/^ {2}([a-z-]+)\)$/gm)].map((m) => m[1]);
    expect(steps.length).toBeGreaterThan(5);
    for (const step of steps) {
      // as a WHOLE token, not a substring: 'rollback' inside 'rollbackX' would otherwise satisfy
      // the pin for a subcommand the doc no longer names
      expect(OPERATIONS, `${step} is a subcommand nobody documented`)
        .toMatch(new RegExp(`\\b${step.replace(/-/g, '\\-')}\\b(?![\\w-])`));
    }
  });

  it('enable-engine really does open the path in the same transaction, as the sequence claims', () => {
    const sql = read('scripts', 'rollout', 'notif-10cb', 'sql', 'enable_engine.sql');
    const begin = sql.indexOf('BEGIN;');
    const boundary = sql.indexOf('record_notification_activation_boundary');
    const update = sql.indexOf('     SET digest_engine_enabled = true, updated_at = now()');
    const commit = sql.lastIndexOf('COMMIT;');
    expect(begin).toBeGreaterThan(0);
    expect(boundary).toBeGreaterThan(begin);
    expect(update).toBeGreaterThan(boundary);     // the boundary is also the replay oracle
    expect(commit).toBeGreaterThan(update);
  });

  it('activation refuses under a kill and under an unresolved invocation, as the gate table claims', () => {
    const asserts = read('scripts', 'rollout', 'notif-10cb', 'sql', '_activation_assertions.sql');
    expect(asserts).toContain('notification_channel_kill_switches');
    const gate = read('scripts', 'rollout', 'notif-10cb', 'sql', '_invocation_gate.sql');
    expect(gate).toContain("status IN ('pending', 'started')");
    expect(OPERATIONS).toContain('refuses under a kill, an unresolved invocation');
  });

  it('the kill-clear procedure the doc gives is the one the artifact and the RPC actually implement', () => {
    // the P3 this closes: the doc used to send on-call to "the runbook" for a procedure that did
    // not exist, over the single control that decides whether mail resumes
    const sql = read('scripts', 'rollout', 'notif-10cb', 'sql', 'clear_kill.sql');
    expect(sql).toContain('clear_notification_channel_kill');
    expect(sql).toContain('preview_notification_channel_kill_clear');   // the same read, in the transcript
    const fn = newestDefining('CREATE OR REPLACE FUNCTION public.clear_notification_channel_kill(');
    expect(fn).toContain("'rejected_stale_kill'");               // a different live kill is refused
    expect(fn).toContain("'channel_kill_cleared'");              // …and the clearing is audited
    const sh = read('scripts', 'rollout', 'notif-10cb', 'run-enablement.sh');
    for (const flag of ['--kill-request-id=', '--expected-pending=', '--channel=', '--clear-request-id=', '--preview']) {
      expect(sh, `clear-kill must support ${flag}`).toContain(flag);
      expect(OPERATIONS, `the doc must tell the operator about ${flag}`).toContain(flag.replace('=', ''));
    }
    expect(OPERATIONS).toContain('clear-kill');
    // the confirmation must be about a number the operator SAW: a preview step that reads, and a
    // clear that revalidates it. A flag asserting "I read it" would confirm nothing.
    expect(read('scripts', 'rollout', 'notif-10cb', 'sql', 'preview_kill_clear.sql'))
      .toContain('preview_notification_channel_kill_clear');
    expect(fn).toContain("'rejected_backlog_grew'");
    // the refusal EVIDENCE must survive the artifact: a raise inside the transaction would roll
    // back the rejected attempt and the consumed request id, which is the defect this bundle
    // already fixed once on the admin RPCs
    expect(sql.indexOf('COMMIT;')).toBeGreaterThan(sql.indexOf('clear_notification_channel_kill'));
    expect(sql.indexOf('COMMIT;')).toBeLessThan(sql.indexOf('pg_temp.assert('));
    // and the bound is transactional, not merely likely
    expect(fn).toContain('LOCK TABLE public.notification_outbox IN SHARE MODE');
    expect(sh).not.toContain('--backlog-confirmed');
    // …and the doc must not claim the owner is bound by a trigger
    expect(OPERATIONS).toContain('no trigger can bind a superuser');
  });

  it('rollback deactivates and never unschedules — the doc says so because the artifact does', () => {
    const sql = read('scripts', 'rollout', 'notif-10cb', 'sql', 'rollback_disable.sql');
    expect(sql).not.toContain('cron.unschedule');
    expect(OPERATIONS).toContain('never unschedules');
  });

  it('the readiness envelope can never read pass, as the surface table claims', () => {
    const src = newestDefining('CREATE OR REPLACE FUNCTION public.admin_notification_readiness()');
    expect(src).toContain("'readiness', CASE WHEN");
    expect(src).not.toMatch(/'readiness',[^;]*'pass'/);   // no arm produces an overall pass
    expect(OPERATIONS).toContain('Never reads `pass`');
  });
});
