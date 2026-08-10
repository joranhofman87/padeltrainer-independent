// @vitest-environment node
// The pin writer's malformed-input behaviour, driven through the REAL `--write-pin` command.
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
// It drives the real command rather than re-implementing its logic: a test that re-derived the
// merge would pass while the shipped writer crashed. That means it genuinely rewrites the repo's pin
// file, so restoration is the safety property this file owes the repo — see `restore()` below, the
// afterEach, and the final byte-for-byte assertion.
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PIN = join(process.cwd(), 'scripts/rollout/notif-10ca3/clone-safety/reviewed-migration-chain.json');
const SAN = join(process.cwd(), 'scripts/rollout/notif-10ca3/synth/sanitize-migrations.mjs');
const SRC = join(process.cwd(), 'supabase/migrations');

/** The real file's bytes, captured once and restored after every case. */
let ORIGINAL = '';
let outDir = '';

const restore = () => writeFileSync(PIN, ORIGINAL);

/** Run the shipped command. Returns stdout; throws with stderr attached if it exits non-zero. */
const writePin = (): string =>
  execFileSync('node', [SAN, SRC, outDir, '--write-pin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const readPin = () => JSON.parse(readFileSync(PIN, 'utf8'));

beforeAll(() => {
  ORIGINAL = readFileSync(PIN, 'utf8');
  outDir = mkdtempSync(join(tmpdir(), 'sanpin-'));
});

// Restore after EVERY case, including a failing one, so a mid-test failure cannot leave the repo's
// pin holding a fixture value.
afterEach(restore);

afterAll(() => {
  restore();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
  // the contract this file owes the repository: the worktree is exactly as it was found
  expect(readFileSync(PIN, 'utf8'), 'the real pin must be restored byte-for-byte').toBe(ORIGINAL);
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

  it('re-pinning the REAL pin is a no-op on its digest, count and review history', () => {
    // the round-trip that matters in practice: a reviewer re-pins and loses nothing
    const before = readPin();
    writePin();
    const after = readPin();
    expect(after.sha256).toBe(before.sha256);
    expect(after.files).toBe(before.files);
    expect(after.reviews).toEqual(before.reviews);
  });
});
