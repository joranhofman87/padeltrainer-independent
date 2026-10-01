// @vitest-environment node
// The pin writer's malformed-input behaviour, driven through the REAL `--write-pin` command —
// against an ISOLATED COPY of it, never the repository's own pin.
//
// `scripts/rollout/notif-10ca3/synth/sanitize-migrations.mjs --write-pin` rewrites the reviewed-chain
// pin, and it must carry an existing `reviews[]` array through: that array is where a reviewer
// records WHAT they read in the migration diff and why a sanitized clone is still outbound-inert, and
// `--write-pin` is the command they run at the END of doing that review. Silently dropping it there
// would delete the reasoning at the exact moment it was produced.
//
// The first version of that carry-forward was unsafe. `JSON.parse('null')` SUCCEEDS, so a pin file
// containing `null` — or an array, or a bare scalar — sailed past the try/catch and then threw on
// property access. This file pins every shape.
//
// WHY A COPY, AND NOT afterEach RESTORATION. The first version of this test wrote fixtures into the
// repository's real pin and restored it in hooks. That is not safe for a reviewed security artifact:
// in-process cleanup does not survive a SIGKILL, a forced timeout or a worker crash, an interruption
// mid-write can truncate the file, and the unit project runs test files in parallel so a concurrent
// run could have its work overwritten by a stale restore. Cleanup hooks cannot make mutating a shared
// artifact safe.
//
// `PIN_FILE` is derived from the script's OWN location (`../clone-safety/` relative to
// `synth/sanitize-migrations.mjs`), and the script imports nothing but node builtins. So copying it
// into a temp tree with the same relative layout runs the byte-identical shipped code against a
// throwaway pin. The real artifact is never opened for writing at all — which this file also asserts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REAL_PIN = join(process.cwd(), 'scripts/rollout/notif-10ca3/clone-safety/reviewed-migration-chain.json');
const REAL_SAN = join(process.cwd(), 'scripts/rollout/notif-10ca3/synth/sanitize-migrations.mjs');
const SRC = join(process.cwd(), 'supabase/migrations');

let root = '';
let SAN = '';      // the copied script
let PIN = '';      // the copied script's pin, which is what --write-pin rewrites
let outDir = '';
/** The real artifact's bytes, held only to prove at the end that nothing touched it. */
let REAL_BEFORE: Buffer | undefined;

const writePin = (): string =>
  execFileSync('node', [SAN, SRC, outDir, '--write-pin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const readPin = () => JSON.parse(readFileSync(PIN, 'utf8'));

beforeAll(() => {
  REAL_BEFORE = readFileSync(REAL_PIN);
  root = mkdtempSync(join(tmpdir(), 'sanpin-'));
  mkdirSync(join(root, 'synth'));
  mkdirSync(join(root, 'clone-safety'));
  SAN = join(root, 'synth', 'sanitize-migrations.mjs');
  PIN = join(root, 'clone-safety', 'reviewed-migration-chain.json');
  outDir = join(root, 'out');
  // the SHIPPED script, copied verbatim — this tests the real code, not a re-implementation
  copyFileSync(REAL_SAN, SAN);
  copyFileSync(REAL_PIN, PIN);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  // The contract this file owes the repository: it never wrote to the reviewed pin. Compared as
  // BUFFERS, so this is a genuine byte comparison rather than a utf8-decoded one.
  if (REAL_BEFORE) {
    expect(readFileSync(REAL_PIN).equals(REAL_BEFORE), 'the REAL pin must be untouched').toBe(true);
  }
});

describe('sanitize-migrations --write-pin: malformed pin files must not crash the writer', () => {
  // `JSON.parse` accepts all four of these, or throws — either way the writer must survive and
  // produce a valid pin, because this is the command a reviewer runs to RECORD a completed review.
  for (const [label, contents] of [
    ['null (JSON.parse succeeds, then property access used to throw)', 'null'],
    ['an array', '[]'],
    ['a bare scalar', '"x"'],
    ['syntactically invalid JSON', '{bad json'],
  ] as const) {
    it(`re-pins cleanly when the existing pin is ${label}`, () => {
      writeFileSync(PIN, contents);
      const out = writePin();
      expect(out).toMatch(/^PINNED sha256=[0-9a-f]{64} files=\d+$/m);

      const pin = readPin();
      expect(pin.sha256, 'a well-formed digest is still written').toMatch(/^[0-9a-f]{64}$/);
      expect(pin.files).toBeGreaterThan(0);
      // nothing salvageable was in the file, so no review history is invented
      expect(pin.reviews).toBeUndefined();
    });
  }

  it('drops a non-array `reviews` rather than preserving it', () => {
    // A truthy non-array would otherwise be carried through verbatim and corrupt the very record
    // the carry-forward exists to protect. Losing junk is correct; propagating it is not.
    writeFileSync(PIN, JSON.stringify({ sha256: 'x'.repeat(64), files: 1, reviews: { not: 'an array' } }));
    writePin();
    expect(readPin().reviews).toBeUndefined();
  });

  it('PRESERVES a valid reviews array — the property the carry-forward exists for', () => {
    const marker = { from: { files: 1 }, note: 'regression-fixture' };
    writeFileSync(PIN, JSON.stringify({ sha256: 'y'.repeat(64), files: 1, reviews: [marker] }));
    writePin();

    const pin = readPin();
    expect(Array.isArray(pin.reviews)).toBe(true);
    expect(pin.reviews).toHaveLength(1);
    expect(pin.reviews[0]).toEqual(marker);
    // ...and the digest/count are freshly computed, not inherited from the fixture
    expect(pin.sha256).not.toBe('y'.repeat(64));
    expect(pin.files).toBeGreaterThan(1);
  });

  it('re-pinning an unchanged pin is a no-op on its digest, count and review history', () => {
    // the round-trip that matters in practice: a reviewer re-pins and loses nothing. The fixture is
    // a copy of the real pin, so this exercises the actual shipped record.
    copyFileSync(REAL_PIN, PIN);
    const before = readPin();
    writePin();
    const after = readPin();
    expect(after.sha256).toBe(before.sha256);
    expect(after.files).toBe(before.files);
    expect(after.reviews).toEqual(before.reviews);
  });
});
