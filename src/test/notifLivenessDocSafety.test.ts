import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The monitor's credential must never be documented in a form that puts it in argv or shell
 * history. `supabase secrets set NAME=<value>` exposes it in `ps` output while the command runs and
 * writes it to the operator's history file; `curl -H "Authorization: Bearer <token>"` does the same.
 *
 * This is pinned as a TEST rather than left to review because the unsafe forms are the ones people
 * reach for by muscle memory — they are shorter, they are what the vendor docs show, and a reviewer
 * skims a diff of prose. The safe forms (a mode-0600 env file, a curl config file, a named Keychain
 * item) have to be the ones that survive.
 */
const ROOT = join(__dirname, '..', '..');
const DOCS = [
  'docs/NOTIFICATION_OPERATIONS.md',
  'scripts/rollout/notif-10cb/README.md',
  'docs/deployment/EDGE_FUNCTION_DEPLOY_SAFETY.md',
];

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('notif-liveness documentation cannot reintroduce a secret in argv', () => {
  it.each(DOCS)('%s never sets the token inline', (rel) => {
    const src = read(rel);
    // `supabase secrets set NOTIF_LIVENESS_TOKEN=…` in any spacing
    expect(src).not.toMatch(/secrets\s+set\s+[^\n]*NOTIF_LIVENESS_TOKEN\s*=/);
  });

  it.each(DOCS)('%s never passes the token as a curl -H argument', (rel) => {
    const src = read(rel);
    // -H "Authorization: Bearer …" on a command line. The provider-UI prose form (backticked,
    // no -H) is fine and is deliberately not matched.
    expect(src).not.toMatch(/-H\s+["']Authorization:\s*Bearer/i);
    expect(src).not.toMatch(/-H\s+["']x-monitor-token/i);
  });

  it('the operations doc documents the SAFE forms it is meant to steer people to', () => {
    const src = read('docs/NOTIFICATION_OPERATIONS.md');
    expect(src).toMatch(/secrets\s+set\s+--env-file/);      // env-file, not inline
    expect(src).toMatch(/curl\s+-sf\s+--config/);            // curl config, not -H
    expect(src).toMatch(/chmod\s+600/);                      // mode-0600
    expect(src).toMatch(/trap\s+'rm -f/);                    // fail-closed cleanup
    expect(src).toMatch(/security (add|find)-generic-password/); // named Keychain item
    expect(src).toMatch(/secrets unset NOTIF_LIVENESS_TOKEN/);   // revocation
  });
});

describe('the impossible stale-before-first-send requirement stays removed', () => {
  it('no runbook asks for a stale last_success_at before the first send', () => {
    for (const rel of DOCS) {
      const src = read(rel);
      // The exact instruction that could not be satisfied: "alerts on a stale last_success_at"
      // presented as a step-3c precondition.
      expect(src).not.toMatch(/verify it alerts on a stale `?last_success_at`?\s*(before the FIRST send)?/i);
    }
  });

  it('the rehearsal that replaces it is documented, and it stays inert', () => {
    const src = read('docs/NOTIFICATION_OPERATIONS.md');
    expect(src).toMatch(/safe rehearsal/i);
    expect(src).toMatch(/cron_disarmed/);
    expect(src).toMatch(/provider alerts/i);
    expect(src).toMatch(/reports recovery/i);
    // and it must say, in terms, that it arms and sends nothing
    expect(src).toMatch(/never arm|arms the cron, enables an engine, or sends/i);
  });
});

describe('the activation ordering is documented in execution order', () => {
  it('7a and 7b precede 7c in the canonical runbook', () => {
    const src = read('scripts/rollout/notif-10cb/README.md');
    const a = src.indexOf('| 7a |');
    const b = src.indexOf('| 7b |');
    const c = src.indexOf('| 7c |');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    // and 7c is the one that arms, carrying the new assertion
    expect(src.slice(c, c + 400)).toMatch(/--liveness-expectation-confirmed/);
  });

  it('activate requires the new assertion in usage and in the script', () => {
    const sh = read('scripts/rollout/notif-10cb/run-enablement.sh');
    expect(sh).toMatch(/--liveness-expectation-confirmed\)\s*LIVENESS_EXPECTATION_CONFIRMED=1/);
    expect(sh).toMatch(/require_liveness_expectation "arming the digest cron"/);
    // it must be a DIFFERENT fact from --monitor-confirmed, not an alias
    expect(sh).toMatch(/require_liveness_expectation\(\)/);
    expect(sh).toMatch(/require_monitor\(\)/);
  });
});
