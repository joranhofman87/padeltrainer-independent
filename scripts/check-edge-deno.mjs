#!/usr/bin/env node
/**
 * Type-check ratchet for the Deno edge functions — the type gate that `deno test --no-check`
 * in .github/workflows/test.yml deliberately skips.
 *
 * The edge functions (~96 supabase/functions/<name>/index.ts) run as plain JS at deploy time
 * (types stripped), and CI only ever RAN their _shared unit tests with --no-check. So a mistyped
 * or un-imported NAME in an edge fn — including the money-critical mollie-webhook — shipped as a
 * runtime ReferenceError with a green build (e.g. backfill-invoices already references undefined
 * `supabaseUrl`/`supabaseServiceKey`). This gate runs a REAL `deno check` on every function and,
 * because that surface is perma-red with a known pre-existing error set, ratchets on NEW errors
 * only — exactly like scripts/check-tsc-baseline.mjs and the eslint-suppressions gate.
 *
 *   - check each function's index.ts on its own (a single merged graph dies on the first npm:
 *     resolution quirk; per-file mirrors how each function actually deploys)
 *   - `--node-modules-dir=manual` so the 14 functions that import `npm:` specifiers resolve against
 *     the node_modules that `npm ci` populated (the deno-only edge-tests job can't do this)
 *   - signature each error as `file|code|message`, with abs paths + version-pinned dep segments
 *     normalized out so a signature is stable across machines/CI and across dependency bumps
 *   - count occurrences per signature; FAIL if any signature exceeds the committed baseline
 *   - note (non-fatal) signatures that dropped below baseline — fixed errors you can prune
 *
 * Regenerate after intentionally changing the error set:  node scripts/check-edge-deno.mjs --update
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FUNCTIONS_DIR = join(ROOT, 'supabase', 'functions');
const BASELINE = join(dirname(fileURLToPath(import.meta.url)), 'edge-deno.baseline.json');

// Deno error header:  "TS2304 [ERROR]: Cannot find name 'supabaseUrl'."
const ERR_RE = /^(TS\d+) \[ERROR\]: (.+)$/;
// The error's own location is the FIRST indented "at file://...:line:col" line after the header.
// (subsequent `at` lines are "the expected type comes from..." context — ignore them).
const AT_RE = /^\s+at (file:\/\/\S+?):(\d+):(\d+)$/;
// Later `at` lines that are context, not the primary anchor, still start with "at file://" —
// we stop collecting at the first anchor, so no extra guard is needed.

// Deno embeds machine-specific absolute paths (file:///Users/tom/... locally vs /home/runner/...
// on CI) AND version-pinned dependency path segments (node_modules/.deno/@supabase+supabase-js@2.110.0,
// https://esm.sh/@supabase/supabase-js@2.57.2) inside both anchor paths and message text. All of
// those drift per-checkout or on a dependency bump, so a raw signature is non-portable. Strip the
// repo-root/file:// prefix and collapse any @1.2.3 / supabase-js@<ver> to a stable placeholder.
const normalize = (s) =>
  s
    .split(`file://${ROOT}/`).join('')
    .split(`${ROOT}/`).join('')
    .split(`file://${ROOT}`).join('')
    .split(ROOT).join('')
    .replace(/@(\d+\.\d+\.\d+)(?=[\/"'\)])/g, '@VER')
    .replace(/supabase-js@\d[\w.\-]*/g, 'supabase-js@VER');

function functionEntrypoints() {
  return readdirSync(FUNCTIONS_DIR)
    .filter((d) => d !== '_shared')
    .map((d) => join(FUNCTIONS_DIR, d, 'index.ts'))
    .filter((p) => existsSync(p) && statSync(p).isFile())
    .sort();
}

// A `deno check` failure that is NOT a type error — an unresolvable specifier, a bundle error, a
// missing `deno` binary — produces no `TS#### [ERROR]:` line at all. Counting only those lines
// therefore reads such a file as having ZERO errors, and the ratchet (which fails only ABOVE the
// baseline) stays green while the file is not being checked at all.
//
// That is not hypothetical. Pinning `npm:@supabase/supabase-js@2.57.2` while `package.json`
// installs 2.90.1 made `deno check --node-modules-dir=manual` fail with
// `error: Could not find a matching package …` for 14 entrypoints. The gate reported "no new type
// errors" — a false green — and the count even went DOWN, which read as an improvement. This gate
// exists to catch un-imported names shipping as runtime ReferenceErrors; failing open is the one
// thing it must not do.
const HARD_FAIL_RE = /^error: (.+)$/;

function collectErrorCounts() {
  const counts = {};
  const hardFailures = [];
  for (const entry of functionEntrypoints()) {
    let out = '';
    try {
      // deno check exits non-zero on type errors; diagnostics go to stdout/stderr.
      out = execSync(`deno check --node-modules-dir=manual "${entry}"`, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (e) {
      out = `${e.stdout || ''}${e.stderr || ''}`;
    }
    const lines = out.split('\n');
    // Fail CLOSED on anything that stopped deno from type-checking this entrypoint.
    for (const line of lines) {
      const hard = HARD_FAIL_RE.exec(line.trim());
      if (hard && !/^Type checking failed/.test(hard[1])) {
        hardFailures.push(`${normalize(entry)}: ${hard[1]}`);
      }
    }
    for (let i = 0; i < lines.length; i++) {
      const m = ERR_RE.exec(lines[i]);
      if (!m) continue;
      let file = '(unknown)';
      for (let j = i + 1; j < lines.length; j++) {
        if (ERR_RE.test(lines[j])) break; // next error header — this one had no anchor
        const a = AT_RE.exec(lines[j]);
        if (a) { file = normalize(a[1]); break; }
      }
      const sig = `${file}|${m[1]}|${normalize(m[2])}`;
      counts[sig] = (counts[sig] || 0) + 1;
    }
  }
  if (hardFailures.length > 0) {
    console.error(`\n❌ edge functions (deno check) — ${hardFailures.length} entrypoint(s) could not be CHECKED AT ALL:\n`);
    for (const f of hardFailures) console.error(`  ${f}`);
    console.error(`\nThese are not type errors — deno never got far enough to produce any. A file that`);
    console.error(`cannot be checked silently contributes ZERO errors, so the ratchet would read this as`);
    console.error(`an improvement. Fix the resolution failure; do not regenerate the baseline over it.`);
    process.exit(1);
  }
  return counts;
}

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const current = collectErrorCounts();

if (process.argv.includes('--update')) {
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`Wrote ${BASELINE}: ${Object.keys(sorted).length} signatures, ${sum(sorted)} errors.`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('No edge-deno baseline. Generate it with:  node scripts/check-edge-deno.mjs --update');
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

const newErrors = [];
for (const [sig, n] of Object.entries(current)) {
  const allowed = baseline[sig] || 0;
  if (n > allowed) newErrors.push(`  +${n - allowed}  ${sig.replaceAll('|', '  ')}`);
}
const resolved = Object.entries(baseline).filter(([sig, n]) => (current[sig] || 0) < n);

if (newErrors.length) {
  console.error(`\n❌ edge functions (deno check) — ${newErrors.length} NEW type-error signature(s) (baseline ${sum(baseline)}, now ${sum(current)}):\n`);
  console.error(newErrors.join('\n'));
  console.error('\nFix them. If a new error is genuinely intentional, run `node scripts/check-edge-deno.mjs --update` and commit the baseline.');
  process.exit(1);
}
console.log(`✅ edge functions — no new type errors (${sum(current)} pre-existing, baseline ${sum(baseline)}).`);
if (resolved.length) {
  console.log(`\nℹ️  ${resolved.length} baseline signature(s) appear fixed — run \`--update\` to shrink the baseline (optional):`);
  console.log(resolved.slice(0, 8).map(([sig]) => `  - ${sig.split('|')[0]}`).join('\n'));
}
