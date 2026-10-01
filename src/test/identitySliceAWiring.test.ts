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
 * blunt instrument and are used here ONLY for edge-function wiring that has no observable surface
 * without deploying the function — never as a substitute for behaviour that can be exercised. Where
 * behaviour CAN be exercised it is: the cron migration's properties moved to a real-Postgres test
 * (identityCronInert.realpg.test.ts) after two source-regex versions each passed a mutation that
 * broke the property they claimed to hold.
 */

const worker = readFileSync('supabase/functions/notification-identity-worker/index.ts', 'utf8');

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

// The cron migration's properties — installed, inactive, non-destructive on re-apply, owner-scoped,
// and schema-qualified — are NOT asserted here any more. They are proven behaviourally by executing
// the migration in src/test/identityCronInert.realpg.test.ts. Two successive source-regex versions of
// those assertions each passed a mutation that broke the property, which is the argument for moving
// them rather than sharpening them a third time.
