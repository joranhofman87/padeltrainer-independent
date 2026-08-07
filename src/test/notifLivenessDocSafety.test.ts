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

  it('the operations doc DELEGATES credential handling to the tested helper', () => {
    // The plumbing used to be prose, and prose cannot be fail-closed: the blocks had no strict
    // mode, a `trap … INT` that did not terminate, and a printed token. It now lives in a script
    // with an executable proof, and the doc's job is to call it.
    const src = read('docs/NOTIFICATION_OPERATIONS.md');
    expect(src).toMatch(/notif-liveness-secret\.sh provision/);
    expect(src).toMatch(/notif-liveness-secret\.sh with-env -- \\?\s*\n?\s*supabase secrets set --env-file \{\}/);
    expect(src).toMatch(/notif-liveness-secret\.sh check-endpoint/);
    expect(src).toMatch(/secrets unset NOTIF_LIVENESS_TOKEN/);   // revocation
    expect(src).toMatch(/pbcopy/);                                // says the clipboard is NOT used
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

  it('the 7b proof asserts BOTH the status and the state', () => {
    // 503 alone is ambiguous (query_failed / misconfigured / stale share it) and the state alone
    // does not prove the transport worked, so the helper is invoked with both expectations.
    expect(src()).toMatch(/--expect-status 503[\s\S]{0,80}--expect-state cron_disarmed/);
    // and the pre-activation check uses the other pair
    expect(src()).toMatch(/--expect-status 200[\s\S]{0,80}--expect-state inert/);
  });
});

describe('credential plumbing must not return to prose', () => {
  const src = () => read('docs/NOTIFICATION_OPERATIONS.md');

  it('no raw keychain / temp-file / curl-config plumbing in the doc', () => {
    // Each of these was a defect when it was prose: an EXIT trap that fired at logout, a subshell
    // that deleted the config the next step needed, a token echoed for pasting. The helper owns
    // them now, under scripts/rollout/notif-10cb/verify/liveness-token-selftest.sh.
    const s = src();
    expect(s).not.toMatch(/add-generic-password/);
    expect(s).not.toMatch(/mktemp -t notif-liveness/);
    expect(s).not.toMatch(/trap 'rm -f/);
    expect(s).not.toMatch(/--config "\$CURLRC"/);
  });

  it('the helper and its executable proof both exist and are wired into verify:rollout', () => {
    const helper = 'scripts/rollout/notif-10cb/notif-liveness-secret.sh';
    const proof  = 'scripts/rollout/notif-10cb/verify/liveness-token-selftest.sh';
    expect(() => read(helper)).not.toThrow();
    expect(() => read(proof)).not.toThrow();
    expect(read(helper)).toMatch(/set -Eeuo pipefail/);
    expect(read(helper)).toMatch(/on_signal/);
    expect(read('package.json')).toContain('liveness-token-selftest.sh');
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

describe('the endpoint check stays structural and provisioning stays non-destructive', () => {
  const helper = () => read('scripts/rollout/notif-10cb/notif-liveness-secret.sh');
  const checkEndpointFn = () => {
    const src = helper();
    const start = src.indexOf('cmd_check_endpoint()');
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('\nusage()', start));
  };

  it('validates the body with a parser, never by grepping for the state', () => {
    // The substring match let an error envelope that merely ECHOED the requested state read as
    // success — measured on {"ok":false,"state":"query_failed","echo":{"state":"cron_disarmed"}}.
    const src = helper();
    expect(src).toMatch(/--slurp/);
    expect(src).toMatch(/--arg want/);
    expect(src).not.toMatch(/grep -q "\\"state\\":/);
  });

  it('--slurp and the length check are both present (a stream hole reopens without them)', () => {
    // jq reads a STREAM: a filter over `input` accepts {"state":"x"}{"state":"y"} and drops the
    // tail, so `length == 1` over the slurped array is what rejects a trailing value.
    expect(checkEndpointFn()).toMatch(/length == 1 and \(\.\[0\] \| type\) == "object"/);
  });

  it('preflights the parser BEFORE the keychain read and before any request', () => {
    const fn = checkEndpointFn();
    const jq = fn.indexOf('command -v "$JQ_BIN"');
    const kc = fn.indexOf('keychain_read');
    const curl = fn.indexOf('"$CURL_BIN"');
    expect(jq).toBeGreaterThan(-1);
    expect(kc).toBeGreaterThan(jq);
    expect(curl).toBeGreaterThan(kc);
  });

  it('never prints the response body or the parser stderr on failure', () => {
    const fn = checkEndpointFn();
    for (const m of fn.match(/die "\$EXIT_(BODY_SHAPE|STATE)"[^\n]*/g) ?? []) {
      expect(m).not.toMatch(/\$\(cat |\$\{?body|jq_err/);
    }
  });

  it('the write is a CREATE unless --force explicitly asks for an update', () => {
    const src = helper();
    expect(src).toMatch(/if \[ "\$force" -eq 1 \]; then upd=" -U"; fi/);
    // the original defect: -U baked into the add line as a constant
    expect(src).not.toMatch(/add-generic-password -s %s -a %s -U -w/);
    // and a duplicate must be its own outcome, not folded into a generic write failure
    expect(src).toMatch(/"\$SEC_DUPLICATE"\)/);
  });

  it('a lookup failure that is not "not found" is refused rather than read as absence', () => {
    const src = helper();
    expect(src).toMatch(/EXIT_KC_LOOKUP/);
    expect(src).toMatch(/"\$SEC_NOT_FOUND"\) KC_PRESENCE="absent"/);
    // presence must not be decided by a bare `if find …; then`, which reads 36/51 as absent
    expect(src).not.toMatch(/if "\$SECURITY_BIN" find-generic-password[^\n]*; then/);
  });

  it('the operations doc records the jq requirement and the create/force contract', () => {
    const src = read('docs/NOTIFICATION_OPERATIONS.md');
    expect(src).toMatch(/Requires `jq`/);
    expect(src).toMatch(/structurally/i);
    expect(src).toMatch(/errSecDuplicateItem/);
    expect(src).toMatch(/refused rather than overwritten|refused rather than/i);
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
