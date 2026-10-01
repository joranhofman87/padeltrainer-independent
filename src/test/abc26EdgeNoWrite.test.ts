import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

const BULK = 'supabase/functions/bulk-rebook-cycle/index.ts';
const CONTRACT = 'supabase/functions/_shared/priority-unavailable.ts';

/**
 * ABC-26 — the Edge no-write boundary, proved where it is actually decided: in the ORDER of the
 * code, and in the SET of keys the round writes.
 *
 * Why a structural suite rather than a behavioural one. The claim is "a refused request performs
 * no side effect", and `bulk-rebook-cycle` reaches its side effects through a live Supabase client
 * it constructs itself. A behavioural test would need that whole client faked, and would then be
 * asserting against the fake — the classic test that passes for the wrong reason. What actually
 * guarantees the property is that the parse-and-return sits ABOVE every `supabase.` call site in
 * the file, and that is a fact about the file which can be checked exactly.
 *
 * The contract's own decisions (which submissions are refused, with which counts) are exercised
 * behaviourally and exhaustively in `supabase/functions/_shared/priority-unavailable.test.ts`.
 */
describe('ABC-26 · bulk-rebook-cycle refuses BEFORE any side effect', () => {
  const src = read(BULK);
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    expect(i, `expected to find ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  it('parses supplementary priority exactly ONCE', () => {
    expect(src.match(/parsePriorityRequest\(/g) ?? []).toHaveLength(1);
  });

  it('the refusal returns BEFORE the first supabase call of any kind', () => {
    const refusalReturn = at('priorityRefusal: refusal');
    // Every read and write in this function goes through `supabase.` — from/rpc/functions alike.
    const firstSupabaseUse = src.search(/\bsupabase\s*\.\s*(from|rpc|functions|auth|storage)\b/);
    expect(firstSupabaseUse).toBeGreaterThan(-1);
    expect(refusalReturn).toBeLessThan(firstSupabaseUse);
  });

  it('the refusal returns before the cycle/slot/claim/email work is even reachable', () => {
    const refusalReturn = at('priorityRefusal: refusal');
    for (const sideEffect of [
      '.from("cycles")',
      '.from("availability_slots")',
      '.from("slot_priority_claims")',
      'send-priority-claim-invitation',
    ]) {
      expect(src.indexOf(sideEffect), `${sideEffect} must come after the refusal`).toBeGreaterThan(refusalReturn);
    }
  });

  it('the parse consumes ALL THREE legacy arms plus the declared version', () => {
    const parseCall = src.slice(at('parsePriorityRequest({'), at('parsePriorityRequest({') + 400);
    for (const field of ['priorityPeople', 'priorityGuests', 'secondBucketSeriesKeys', 'priorityContractVersion']) {
      expect(parseCall).toContain(`${field}: body?.${field}`);
    }
  });

  it('the refusal is the typed contract object, not a hand-built body', () => {
    expect(src).toMatch(/priorityRefusal:\s*refusal/);
    expect(src).toMatch(/phase:\s*"preflight"/);
    expect(src).toMatch(/status:\s*409/);
  });

  it('nothing downstream re-reads the raw arms — there is no second, filtered view', () => {
    const after = src.slice(at('priorityRefusal: refusal'));
    expect(after).not.toMatch(/body\?\.priorityPeople|body\?\.priorityGuests|body\?\.secondBucketSeriesKeys/);
  });
});

describe('ABC-26 · a new round stores no supplementary-priority state', () => {
  const src = read(BULK);

  it.each(['rebook_priority_people', 'rebook_priority_guests', 'rebook_member_open_message'])(
    'never writes %s — not even as an empty value', (key) => {
      // The key may still be NAMED in a comment explaining the withdrawal; it must not appear as
      // an object key being assigned.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      expect(code).not.toMatch(new RegExp(`${key}\\s*:`));
    },
  );

  it('KEEPS the claim-notifier idempotency marker, which is independently required', () => {
    expect(src).toMatch(/rebook_member_open_notified_at:\s*null/);
  });

  it('no longer calls the retired admission RPC', () => {
    expect(src).not.toMatch(/rpc\(\s*["']filter_academy_priority_ids["']/);
  });

  it('carries no dead protocol state for the withdrawn feature', () => {
    // Named bindings that exist only to describe a feature that no longer exists — the class of
    // thing a lint suppression would otherwise be used to keep alive.
    expect(src).not.toMatch(/const priorityContractVersion\s*=/);
    expect(src).not.toMatch(/const priorityPeopleRaw\s*=/);
    expect(src).not.toMatch(/const priorityGuestsRaw\s*=/);
    expect(src).not.toMatch(/secondBucketAddedCount\s*:/);
    expect(src).not.toMatch(/eslint-disable[^\n]*no-unused/);
  });
});

describe('ABC-26 · consumer inventory for the retired admission RPC', () => {
  // `notify-rebook-member-open` was the fifth caller. The D7 runtime cutover HARD-RETIRED it —
  // the function, its shared helper and its cron are gone — so the inventory is four. Its own
  // ABC-26 describe (the claim-holders-only audience, the source guard, the suppression log) went
  // with it: those were assertions about a file that no longer exists, and the properties they
  // protected are now the database's, proved on the real chain rather than by reading source.
  // `src/test/d7RuntimeWiring.test.ts` holds the ABSENCE control that keeps it retired.
  const CALLERS = [
    'supabase/functions/bulk-rebook-cycle/index.ts',
    'src/lib/rebookInviteSend.ts',
    'src/components/cycles/RebookCohortWizard.tsx',
    'src/components/cycles/AcademyNewRoundWizard.tsx',
  ];

  it.each(CALLERS)('%s does not call filter_academy_priority_ids', (file) => {
    expect(read(file)).not.toMatch(/rpc\([^)]*filter_academy_priority_ids/);
  });
});

describe('ABC-26 · one contract authority, no hand-copied second schema', () => {
  it('the browser module RE-EXPORTS the Edge contract instead of redefining it', () => {
    const browser = read('src/lib/priorityUnavailable.ts');
    expect(browser).toMatch(/from '\.\.\/\.\.\/supabase\/functions\/_shared\/priority-unavailable'/);
    // A re-export file must contain no logic of its own.
    expect(browser).not.toMatch(/function |=>|const [A-Z_]+ =/);
  });

  it('version equality is EXACT — never a >= comparison', () => {
    const contract = read(CONTRACT);
    expect(contract).toMatch(/v === PRIORITY_PROTOCOL_VERSION/);
    expect(contract).not.toMatch(/>=\s*PRIORITY_PROTOCOL_VERSION/);
  });

  it('the guard delegates to the decoder — one definition of a valid refusal', () => {
    expect(read(CONTRACT)).toMatch(/export function isPriorityRefusal[\s\S]{0,160}parsePriorityRefusal\(v\)\.ok/);
  });
});
