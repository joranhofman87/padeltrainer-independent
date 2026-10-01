// @vitest-environment node
//
// D7 RUNTIME — WIRING AND ABSENCE CONTROLS (E-8, E-10).
//
// Deleting something is a claim, and a claim that nothing enforces comes back. These are the
// enforced versions: the legacy member-open path is gone and stays gone, the new workers are
// registered everywhere a deploy reads, and the operator surface has exactly one call site.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Everything the retirement removed, by the exact identifiers a survivor would have to name. */
const RETIRED = [
  'notify-rebook-member-open',
  '_shared/rebook-member-open.ts',
  'claim_rebook_member_open_notice',
  'unclaim_rebook_member_open_notice',
  'append_rebook_member_open_notified',
  'rebook_cycles_needing_member_open_notice',
] as const;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vercel', 'coverage', 'playwright-report']);
const SKIP_EXT = /\.(png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|eot|otf|pdf|zip|gz|tgz|mp[34]|mov|lock|map)$/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.env')) continue;
    const abs = join(dir, entry);
    const rel = abs.slice(ROOT.length + 1);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (!SKIP_EXT.test(entry)) out.push(rel);
  }
  return out;
}

/**
 * Where a retired name may still legitimately appear. Every entry is a REASON, not a convenience:
 * an exclusion nobody can justify is how a live reference hides inside an absence control.
 */
const ALLOWED = [
  // (i) HISTORICAL MIGRATIONS. Immutable by contract — they are the record of what shipped, and
  //     rewriting them would be falsifying it. The retirement migration also names the four it
  //     drops, necessarily.
  { test: (p: string) => p.startsWith('supabase/migrations/'), why: 'migrations are immutable history' },
  // (ii) DOCUMENTATION. It describes the retirement, so it must be able to name what was retired.
  { test: (p: string) => p.startsWith('docs/'), why: 'the docs record the retirement' },
  // (iii) THE §2e FIXTURE STUBS and the historical-scope suites. Those `CREATE FUNCTION` stubs
  //     exist so historical migrations' own REVOKE/GRANT statements resolve when replayed in
  //     isolation; deleting them breaks the replay of files that are not allowed to change.
  { test: (p: string) => p.startsWith('src/test/'), why: 'fixture stubs + these controls' },
  // (iv) THE ROLLOUT EVIDENCE CAPTURE. A point-in-time read of production taken on 2026-08-01.
  //     It is evidence of what WAS true; editing it would destroy the thing it exists to be.
  { test: (p: string) => p.startsWith('scripts/rollout/notif-10ca3/evidence/'), why: 'point-in-time evidence' },
  // (v) THE CREDENTIAL REGISTRY. Its MANAGED_SQL notes describe which migration scheduled which
  //     job, including the retired one — that description is the lifecycle record Path B reads.
  { test: (p: string) => p === 'scripts/check-legacy-service-role-consumers.mjs', why: 'lifecycle registry notes' },
  // (vi) THE GENERATED SUPABASE TYPES. Regenerating them is deploy step 7, AFTER the migrations
  //     are applied — see the note in the test below, which pins this as a KNOWN residue rather
  //     than letting it pass silently.
  { test: (p: string) => p === 'src/integrations/supabase/types.ts', why: 'regenerated at deploy step 7' },
  // (vii) ONE COMMENT in bulk-rebook-cycle explaining why an inert settings key is still seeded.
  { test: (p: string) => p === 'supabase/functions/bulk-rebook-cycle/index.ts', why: 'explanatory comment only' },
] as const;

const allowedFor = (path: string) => ALLOWED.find((a) => a.test(path));

describe('E-10 — the legacy member-open path is gone, and enforced gone', () => {
  it('deletes the edge function, the shared helper and its test', () => {
    expect(existsSync(join(ROOT, 'supabase/functions/notify-rebook-member-open'))).toBe(false);
    expect(existsSync(join(ROOT, 'supabase/functions/_shared/rebook-member-open.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'supabase/functions/_shared/rebook-member-open.test.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'src/test/rebookMemberOpenNotice.pglite.test.ts'))).toBe(false);
  });

  it('leaves NO reference to any retired name outside the justified exclusions', () => {
    const offenders: string[] = [];
    for (const path of walk(ROOT)) {
      if (allowedFor(path)) continue;
      let body: string;
      try { body = read(path); } catch { continue; }
      for (const name of RETIRED) {
        if (body.includes(name)) offenders.push(`${path} names ${name}`);
      }
    }
    expect(offenders, 'a retired identifier survives outside the reviewed exclusions').toEqual([]);
  });

  it('CONTROL — the scan finds a retired name when one is really there', () => {
    // Without this the empty result above could mean the walk is broken rather than the tree clean.
    const anywhere = walk(ROOT).filter((p) => {
      try { return read(p).includes('claim_rebook_member_open_notice'); } catch { return false; }
    });
    expect(anywhere.length, 'the scan must be able to see the historical references').toBeGreaterThan(0);
    for (const p of anywhere) {
      expect(allowedFor(p), `${p} is found by the scan and must be justified`).toBeTruthy();
    }
  });

  it('the generated types still carry the four RPCs — a KNOWN residue, not an oversight', () => {
    // `src/integrations/supabase/types.ts` describes the schema PRODUCTION has, and production has
    // neither ABC-27 nor the retirement yet. Regenerating it now would make the committed types
    // describe a schema that exists nowhere. It is deploy step 7 — after the migrations apply —
    // and it is CI-verified by `migrations.yml`'s types-drift job, which does a full local
    // `db reset` and byte-compares. This test PINS the residue so it is a recorded decision rather
    // than something nobody noticed.
    const types = read('src/integrations/supabase/types.ts');
    for (const fn of RETIRED.slice(2)) expect(types, `${fn} is still in the generated types`).toContain(fn);
    // ...and the ABC-27 surface is absent from them for the same reason: it is not applied yet.
    expect(types).not.toContain('rebook_member_open_claim_batch');
    expect(types).not.toContain('rebook_round_preview_command_as_actor');
  });

  it('the cron inventory no longer attributes a job to the retired notifier', () => {
    const tsv = read('scripts/rollout/notif-10ca3/clone-safety/reviewed-cron-jobs.tsv');
    expect(tsv).not.toContain('notify-rebook-member-open');
    for (const job of ['rebook-member-open-worker', 'rebook-round-materializer', 'rebook-member-open-janitor']) {
      expect(tsv, `${job} must be in the reviewed cron inventory`).toContain(job);
      // Every new row must say it ships INACTIVE: the inventory is what a clone-safety operator
      // reads to decide what to quiesce, and an unlabelled armed-looking job is the wrong answer.
      const row = tsv.split('\n').find((l) => l.startsWith(job));
      expect(row, `${job} row`).toBeTruthy();
      expect(row!, `${job} must be recorded as shipping inactive`).toContain('SHIPS INACTIVE');
    }
  });
});

describe('D7 — the three new workers are registered everywhere a deploy reads', () => {
  const FUNCTIONS = ['rebook-member-open-worker', 'rebook-member-open-janitor', 'rebook-round-materializer'];

  it('each function exists and is verify_jwt = false in config.toml', () => {
    const toml = read('supabase/config.toml');
    for (const fn of FUNCTIONS) {
      expect(existsSync(join(ROOT, `supabase/functions/${fn}/index.ts`)), `${fn} entrypoint`).toBe(true);
      // A function ABSENT from config.toml inherits the platform default (verify_jwt = true) and
      // the gateway 401s the cron before the function ever runs.
      expect(toml, `${fn} must be in config.toml`).toContain(`[functions.${fn}]`);
      const block = toml.slice(toml.indexOf(`[functions.${fn}]`));
      expect(block.split('\n')[1].trim(), `${fn} verify_jwt`).toBe('verify_jwt = false');
    }
  });

  it('each function is in the edge-config guard and the legacy-key inventory', () => {
    const guard = read('scripts/check-edge-fn-config.mjs');
    const legacy = read('scripts/check-legacy-service-role-consumers.mjs');
    for (const fn of FUNCTIONS) {
      expect(guard, `${fn} must be in MUST_VERIFY_JWT_FALSE`).toContain(`'${fn}'`);
      expect(legacy, `${fn} must be a registered service-role consumer`)
        .toContain(`supabase/functions/${fn}/index.ts`);
    }
    // ...and the retired one is REMOVED from the inventory, which is mandatory rather than tidy:
    // the guard is fail-closed on registered-path existence, so a registered missing path fails.
    expect(legacy).not.toContain("'supabase/functions/notify-rebook-member-open/index.ts'");
  });
});

describe('E-8 — the operator surface has exactly one call site, and passes no actor', () => {
  const WRAPPERS = [
    'rebook_round_preview_command_as_actor',
    'rebook_round_apply_command_as_actor',
    'rebook_round_apply_lifecycle_command_as_actor',
    'rebook_round_command_status_as_actor',
    'rebook_round_command_lookup_by_review_as_actor',
  ];
  const srcFiles = () => walk(join(ROOT, 'src')).filter((p) => /\.(ts|tsx)$/.test(p));

  it('only the driver names an operator wrapper anywhere in src/', () => {
    const offenders: string[] = [];
    for (const path of srcFiles()) {
      // TEST FILES ANYWHERE, not only under `src/test/`. A co-located `*.test.ts` naming a
      // wrapper is a fixture describing the protocol, never a second call site — and the
      // scan is a substring match, so it cannot tell the difference by itself.
      if (path === 'src/lib/rebookRoundDriver.ts' || path.startsWith('src/test/')
          || /\.test\.tsx?$/.test(path)) continue;
      const body = read(path);
      for (const w of WRAPPERS) if (body.includes(w)) offenders.push(`${path} names ${w}`);
    }
    // ONE CALL SITE IS THE POINT. Five surfaces reachable from five components is five places for
    // the protocol to be got subtly wrong, and the retry identity is the part that must not be.
    expect(offenders, 'the operator surface must be reached through the driver only').toEqual([]);
  });

  it('the driver owns exactly ONE apply call site', () => {
    const driver = read('src/lib/rebookRoundDriver.ts');
    const applies = driver.match(/rebook_round_apply_command_as_actor/g) ?? [];
    // The type import and the RPC name would both match a bare scan, so the CALL is matched.
    const calls = driver.match(/rpc\(\s*'rebook_round_apply_command_as_actor'/g) ?? [];
    expect(calls, 'exactly one apply call site').toHaveLength(1);
    expect(applies.length).toBeGreaterThanOrEqual(1);
  });

  it('the driver passes NO actor identifier on any hop', () => {
    const driver = read('src/lib/rebookRoundDriver.ts');
    // The wrapper derives the actor from the JWT. A `p_actor`-shaped argument would be a
    // caller-chosen identity, and the pair fence would be checking a claim against itself.
    expect(driver).not.toMatch(/p_actor/);
    expect(driver).not.toMatch(/p_user_id/);
    expect(driver).not.toMatch(/actor_user_id/);
  });

  it('the driver performs no client-side permission check standing in for the wrapper fence', () => {
    // COMMENTS ARE STRIPPED. STRING AND TEMPLATE LITERALS ARE NOT. The driver's header EXPLAINS
    // the `academy_managers` pair fence, and a bare substring scan would read that explanation as
    // the very thing it warns against — a check that fails on its own documentation teaches people
    // to delete the documentation. A comment cannot execute, so removing comments is sound.
    //
    // A LITERAL CAN. `supabase.from('academy_managers')` is a real client-side permission read
    // whose only trace is a string; erasing literals along with comments deleted exactly the
    // construct this test exists to find, and left a check that could not fail. Literals are
    // therefore recognised — so a `//` inside one cannot eat the code after it — and then kept.
    //
    // ONE PASS, NOT THREE. Stripping block comments, then line comments, then literals lets an
    // earlier rule eat into a construct it does not own — a `//` inside a string literal, or a `/*`
    // inside one — which desynchronises everything after it. A single alternation lets whichever
    // construct STARTS first consume its own extent, and each arm decides what to return.
    const executable = read('src/lib/rebookRoundDriver.ts').replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
      (m) => (m.startsWith('/') ? ' ' : m),
    );
    for (const forbidden of ['academy_managers', 'isManager', 'hasRole', 'user_roles']) {
      expect(executable, `the driver must not decide authorization itself (${forbidden})`)
        .not.toContain(forbidden);
    }
    // ...and the header really does still explain the fence, so the strip above is not hiding a
    // contract that quietly disappeared.
    expect(read('src/lib/rebookRoundDriver.ts')).toContain('academy_managers');
  });

  it('the driver reaches PostgREST directly and never an edge function', () => {
    const driver = read('src/lib/rebookRoundDriver.ts');
    // `requireUser` returns a SERVICE-ROLE client on every path, so inside an edge function
    // `auth.uid()` is NULL and every wrapper answers its closed `refused` row. The operator surface
    // is physically unusable through an edge function.
    expect(driver).not.toMatch(/functions\.invoke/);
    expect(driver).not.toContain('bulk-rebook-cycle');
  });

  it('THE WIZARDS ARE CUT OVER: one typed path, no legacy producer anywhere in it', () => {
    // THIS PIN IS INVERTED, NOT DELETED. It used to assert the opposite — that neither wizard named
    // a D7 wrapper and that both were still on the legacy create path — because pointing them at
    // wrappers that did not exist in production would have broken round creation for every academy
    // between the merge and the migration. The wrappers exist now, so the pin states the new truth
    // and a REGRESSION to the edge producer is a failure rather than a silence.
    for (const wizard of [
      'src/components/cycles/AcademyNewRoundWizard.tsx',
      'src/components/cycles/RebookCohortWizard.tsx',
    ]) {
      const body = read(wizard);
      // Still through the ONE shared boundary — a wizard talking to the database directly would be
      // a second producer with its own idea of the operator's selection.
      expect(body, `${wizard} uses the shared orchestration`).toContain("from '@/lib/rebookInviteSend'");
      expect(body).toContain('createAndDrainRebookRound');
      expect(body).toContain('previewRebookRound');
      // …and NOT past it. No wizard may name a typed wrapper, the retired producer, or an RPC.
      for (const w of WRAPPERS) {
        expect(body, `${wizard} must not call ${w} directly`).not.toContain(w);
      }
      // CALL SHAPES, NOT MENTIONS. A pin that counted the string would fail for a comment
      // explaining the retirement while missing a call hidden in a one-liner — the same trap the
      // notification producer inventory records. What is forbidden is INVOKING the retired
      // producer, or naming an RPC at all.
      for (const forbidden of ["invoke('bulk-rebook-cycle'", 'invoke("bulk-rebook-cycle"']) {
        expect(body, `${wizard} must not invoke the retired producer`).not.toContain(forbidden);
      }
      expect(body, `${wizard} must not call an RPC directly`).not.toMatch(/\.rpc\(\s*['"]rebook_round/);
      // THE SESSION FACTS ARE REFS, NOT BODY FIELDS. A digest folded into the memoized body would
      // change the revision on every server answer and invalidate the review it just produced; a
      // re-minted round uuid would make a retry a different round rather than a replay.
      expect(body, `${wizard} keeps the round uuid stable`).toContain('roundIdRef');
      expect(body, `${wizard} keeps the selection digest out of the body`).toContain('selectionDigestRef');
      expect(body, `${wizard} carries the reviewed artefacts to the send`).toContain('reviewedRef');
    }

    // The retired producer is INVOKED nowhere in the browser's path to a round. Both files talk
    // about it — they explain why it is gone — and a pin that could not tell prose from a call
    // would have to choose between being wrong about one or blind to the other.
    for (const lib of [
      'src/lib/rebookInviteSend.ts',
      'src/lib/rebookSelectionDriver.ts',
    ]) {
      const body = read(lib);
      for (const forbidden of ["invoke('bulk-rebook-cycle'", 'invoke("bulk-rebook-cycle"']) {
        expect(body, `${lib} must not invoke the retired producer`).not.toContain(forbidden);
      }
    }
    // …and the driver reaches exactly the two typed surfaces, never a third.
    const driver = read('src/lib/rebookSelectionDriver.ts');
    const rpcNames = [...new Set([...driver.matchAll(/rpc\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]))].sort();
    expect(rpcNames, 'exactly the two selection surfaces').toEqual([
      'rebook_round_selection_apply_as_actor',
      'rebook_round_selection_preview_as_actor',
    ]);
  });
});

describe('D7 — the worker core cannot reach a generic notification mutator', () => {
  const CORE = 'supabase/functions/_shared/rebook-member-open-worker-core.ts';

  it('names none of the forbidden generic disposal paths', () => {
    const src = read(CORE);
    // Each of these is a REAL hazard, not a style rule: `checkChannelKillOrRelease` calls
    // `release_notification_claims_on_kill`, a generic mutator this worker holds no grant for, and
    // the correct D7 kill behaviour is already `pre_dispatch_resolve` returning `deferred`.
    for (const forbidden of [
      'checkChannelKillOrRelease', 'release_notification_claims_on_kill',
      'record_notification_send_result', 'defer_notification_outbox_row',
      'claim_notification_outbox_batch', 'enqueue_notification',
    ]) {
      expect(src, `the worker core must not name ${forbidden}`).not.toContain(`"${forbidden}"`);
      expect(src, `the worker core must not name ${forbidden}`).not.toContain(`'${forbidden}'`);
    }
    // No `fetch` of its own: the single provider call is the injected boundary's, and the ceiling
    // of exactly one call per authorized generation lives there.
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });

  it('declares every closed row-fault label it can actually throw', async () => {
    const src = read(CORE);
    const thrown = [...src.matchAll(/new RowFault\("([a-z_]+)"\)/g)].map((m) => m[1]);
    expect(thrown.length, 'the scan must find the throw sites').toBeGreaterThan(0);
    const { ROW_FAULT_LABELS } = await import(
      '../../supabase/functions/_shared/rebook-member-open-worker-core.ts');
    for (const label of thrown) {
      expect(ROW_FAULT_LABELS as readonly string[], `${label} is thrown but not declared`)
        .toContain(label);
    }
    // ...and no declared label is unreachable, which would be a vocabulary that overstates itself.
    expect(new Set(thrown).size).toBe((ROW_FAULT_LABELS as readonly string[]).length);
  });

  it('the dispatcher entry reads no request body — no client identifier can reach it', () => {
    const entry = read('supabase/functions/_shared/rebook-member-open-worker-entry.ts');
    for (const bodyRead of ['req.json()', 'req.text()', 'req.clone()', 'req.body']) {
      expect(entry, `the entry must not read the request body (${bodyRead})`).not.toContain(bodyRead);
    }
    for (const core of [
      'supabase/functions/_shared/rebook-member-open-janitor-core.ts',
      'supabase/functions/_shared/rebook-round-materializer-core.ts',
    ]) {
      const src = read(core);
      for (const bodyRead of ['req.json()', 'req.text()', 'req.clone()', 'req.body']) {
        expect(src, `${core} must not read the request body`).not.toContain(bodyRead);
      }
    }
  });

  it('the send flag gates the WHOLE dispatcher, and the other two functions never read it', () => {
    const entry = read('supabase/functions/_shared/rebook-member-open-worker-entry.ts');
    expect(entry).toContain('REBOOK_MEMBER_OPEN_SEND_ENABLED');
    // Gating only the provider call would still claim rows, burn lease generations and leave them
    // leased — strictly worse than a clean no-op.
    expect(entry).toMatch(/!==\s*"true"/);
    for (const other of [
      'supabase/functions/_shared/rebook-member-open-janitor-core.ts',
      'supabase/functions/_shared/rebook-round-materializer-core.ts',
    ]) {
      // An inert janitor turns a stale lease into a PERMANENT wedge; an inert materializer would
      // stop the queue a controlled activation needs to inspect.
      expect(read(other), `${other} must not be behind the send flag`)
        .not.toContain('REBOOK_MEMBER_OPEN_SEND_ENABLED');
    }
  });
});
