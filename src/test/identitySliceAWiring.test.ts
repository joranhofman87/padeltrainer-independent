import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Slice A — the production wiring the behavioural tests deliberately cannot see.
 *
 * `identity-worker-handler.test.ts` injects its own transport, which is what makes the send path
 * assertable at all. The cost of that seam is that those tests stay green if the PRODUCTION default
 * or the HTTP guard is deleted, because neither is on the path they exercise. Codex round 3 called
 * that out, and it is right: a security guard that no test pins is a guard waiting to be refactored
 * away.
 *
 * So these read the shipped source and assert the constructs are present. Source assertions are a
 * blunt instrument and are used here only for wiring that has no other observable surface — never as
 * a substitute for exercising behaviour that can be exercised.
 */

const worker = readFileSync('supabase/functions/notification-identity-worker/index.ts', 'utf8');
const cron = readFileSync('supabase/migrations/20261202100000_u2_identity_worker_cron_inert.sql', 'utf8');

describe('slice A — the identity sender is wired for production, not just for tests', () => {
  it('authenticates the caller BEFORE it builds a service-role client', () => {
    // verify_jwt = false is correct for a cron drainer, which makes the check the function's job.
    const guard = worker.indexOf('requireServiceRole(req)');
    const client = worker.indexOf('createClient(');
    expect(guard, 'requireServiceRole must be called').toBeGreaterThan(-1);
    // the guard is inside Deno.serve; the only createClient is after it
    expect(guard).toBeLessThan(worker.lastIndexOf('Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")'));
    expect(client).toBeGreaterThan(-1);
  });

  it('defaults to the real provider, keyed for idempotency on the outbox id', () => {
    // the injectable seam must fall back to the reviewed sender, not to a stub
    expect(worker).toContain('deps.send ??');
    expect(worker).toContain('sendResendEmail(k, p, o)');
    expect(worker).toContain('idempotencyKey: row.outbox_id');
  });

  it('claims only its own worker kind', () => {
    expect(worker).toContain('p_worker_kind: WORKER_KIND');
    expect(worker).toContain('const WORKER_KIND = "identity_verify"');
  });

  it('resolves the address from the challenge, never from the outbox row', () => {
    expect(worker).toContain('identity_challenge_send_target');
    // the outbox destination must not be used as a send target
    expect(worker).not.toContain('destination_normalized');
  });
});

describe('slice A — the identity cron is inert by construction', () => {
  it('is disabled in the same transaction that creates it', () => {
    expect(cron).toContain('cron.alter_job(v_jobid, active := false)');
  });

  it('takes the jobid from cron.schedule rather than re-looking it up by name', () => {
    expect(cron).toContain('v_jobid := cron.schedule(');
  });

  it('scopes the existing-job lookup to the current owner, and leaves it untouched', () => {
    // pg_cron uniqueness is (jobname, username): a bare lookup can act on another role's job.
    //
    // This must assert on the EXECUTABLE lookup, not on the file. `username = current_user` also
    // appears in the activation comment at the top, so a whole-file `toContain` stayed green with
    // the real predicate deleted — the exact failure mode this file exists to prevent, found in this
    // file. Comments are stripped first, then the SELECT itself is matched.
    // Strip INLINE comments as well as whole-line ones. A trailing `-- username = current_user`
    // after a weakened predicate is valid SQL and would otherwise satisfy this assertion — the same
    // false-green this test already had once, one layer down.
    const stripped = cron.replace(/--[^\n]*/g, '');
    // ...then scope to the ONE executable statement, so a match somewhere else in the file cannot
    // stand in for it.
    const lookup = stripped.match(/SELECT\s+jobid\s+INTO\s+v_jobid[\s\S]*?;/i)?.[0] ?? '';
    expect(lookup, 'the owner-scoped lookup statement must exist').not.toBe('');
    expect(lookup).toMatch(/FROM\s+cron\.job/i);
    expect(lookup).toMatch(/username\s*=\s*current_user/i);
    expect(stripped).toMatch(/IF v_jobid IS NOT NULL THEN[\s\S]*?RETURN;/);
  });

  it('serializes check-then-create against a concurrent apply', () => {
    expect(cron).toContain('pg_advisory_xact_lock');
  });

  it('schema-qualifies EVERY resolvable name in the stored command', () => {
    // a cron job runs under its owner's search_path, and resolution does not prefer pg_catalog:
    // an exact-arity overload in `public` would receive the decrypted service-role bearer.
    for (const qualified of [
      'pg_catalog.jsonb_build_object',
      'OPERATOR(pg_catalog.||)',
      'OPERATOR(pg_catalog.=)',
      "::pg_catalog.jsonb",
    ]) {
      expect(cron, `the cron command must qualify ${qualified}`).toContain(qualified);
    }
    // and must NOT contain the unqualified forms inside the command body
    const body = cron.slice(cron.indexOf('$cmd$'), cron.lastIndexOf('$cmd$'));
    expect(body).not.toMatch(/[^.]\bjsonb_build_object\(/);
  });

  it('installs even when the Vault secret is absent, because the command reads Vault at tick time', () => {
    // An apply-time guard would record the migration as applied while creating no job at all. The
    // NOTICE text alone does not protect that: inserting `RETURN;` straight after it restores the
    // skip and leaves a text assertion green. So this pins the CONTROL FLOW — between the empty-key
    // branch and the cron.schedule call there must be no RETURN.
    const stripped = cron.replace(/--[^\n]*/g, '');
    const emptyKeyBranch = stripped.indexOf('IF sr_key IS NULL OR sr_key');
    const scheduleCall = stripped.indexOf('v_jobid := cron.schedule(');
    expect(emptyKeyBranch, 'the empty-key branch must exist').toBeGreaterThan(-1);
    expect(scheduleCall).toBeGreaterThan(emptyKeyBranch);
    const between = stripped.slice(emptyKeyBranch, scheduleCall);
    // the only RETURN allowed between them is the already-scheduled early exit, which is guarded by
    // `IF v_jobid IS NOT NULL` — an unguarded RETURN here would re-create the apply-time skip
    const returnsBefore = between.slice(0, between.indexOf('IF v_jobid IS NOT NULL THEN'));
    expect(returnsBefore).not.toMatch(/\bRETURN\s*;/i);
    expect(cron).toContain('installing notification-identity-worker INACTIVE anyway');
  });
});
