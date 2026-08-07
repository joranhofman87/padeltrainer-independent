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
    expect(src).toMatch(/curl\s+-s\s+-w[^\n]*--config/);     // curl config, not -H
    expect(src).toMatch(/umask\s+077/);                      // 0600 by construction
    expect(src).toMatch(/trap\s+'rm -f/);                    // fail-closed cleanup
    expect(src).toMatch(/security (add|find)-generic-password/); // named Keychain item
    expect(src).toMatch(/secrets unset NOTIF_LIVENESS_TOKEN/);   // revocation
  });
});

describe('the endpoint proof must be able to succeed, and must assert both facts', () => {
  const src = () => read('docs/NOTIFICATION_OPERATIONS.md');

  it('never uses curl -f against the liveness endpoint', () => {
    // The expected answer at 7b is an HTTP ERROR (503 with a body). `curl -f` suppresses the body
    // and exits 22, so a grep for the state could never match — the proof would be unsatisfiable,
    // which is the same class of defect as the stale-before-first-send requirement it replaced.
    const blocks: string[] = src().match(/```bash\n([\s\S]*?)```/g) ?? [];
    for (const b of blocks) {
      if (!b.includes('notif-liveness')) continue;
      // COMMANDS only — the blocks deliberately explain in comments why `curl -f` is wrong here,
      // and a check that flagged its own explanation would be uselessly literal.
      const commands = b.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
      expect(commands).not.toMatch(/curl\s+(-\w*f\w*|--fail)\b/);
    }
  });

  it('asserts the STATUS as well as the state', () => {
    // 503 alone is ambiguous (query_failed / misconfigured / stale share it) and the state alone
    // does not prove the transport worked, so both are required.
    expect(src()).toMatch(/%\{http_code\}/);
    expect(src()).toMatch(/"\$CODE"\s*=\s*"503"/);
    expect(src()).toMatch(/"state":"cron_disarmed"/);
  });
});

describe('credential handling leaves nothing behind and nothing in argv', () => {
  const src = () => read('docs/NOTIFICATION_OPERATIONS.md');

  it('scopes cleanup to a subshell rather than an interactive EXIT trap', () => {
    // A bare `trap … EXIT` typed into an interactive shell fires at LOGOUT, and a later trap on the
    // same signal REPLACES it — so the temp file survives the session, or forever.
    const all: string[] = src().match(/```bash\n([\s\S]*?)```/g) ?? [];
    const blocks = all.filter((b) => b.includes('mktemp'));
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(b).toMatch(/^\(|\n\(/m);        // opens a subshell
      expect(b).toMatch(/trap 'rm -f/);
    }
  });

  it('never passes the token as a value to security add-generic-password', () => {
    // `-w "$token"` puts the secret in argv, observable via ps. `-w` with no value prompts.
    expect(src()).not.toMatch(/add-generic-password[^\n]*-w\s+["'$]/);
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
