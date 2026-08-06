import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Static pins for the trainer identity-authority boundary (A1-A7 F3 / OD-1).
 *
 * These live in vitest rather than beside the deno unit tests for a boring but load-bearing
 * reason: CI runs the edge suite as `deno test --no-check --allow-env --allow-net`, with no
 * `--allow-read`. A deno test that reads a source file passes locally and fails in CI — which is
 * exactly how it was first written. Static cross-file pins belong on the side of the fence that
 * is allowed to read files.
 */
const ROOT = resolve(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(resolve(ROOT, ...p), 'utf8');

describe('the shared-identity field matrix stays exhaustive', () => {
  it('every profiles field update-user writes is classified as global identity', () => {
    // the matrix is only as good as its list: a profile column added to update-user without being
    // classified would be writable by whoever the endpoint currently lets through.
    const authority = read('supabase/functions/_shared/trainer-authority.ts');
    const endpoint = read('supabase/functions/update-user/index.ts');
    const listed = [...authority.matchAll(/"([a-z_]+)",?\s*(?:\/\/|$)/gm)].map((m) => m[1]);
    const block = authority.slice(authority.indexOf('GLOBAL_IDENTITY_FIELDS'));
    const fields = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(fields.length, 'GLOBAL_IDENTITY_FIELDS should not be empty').toBeGreaterThan(0);
    expect(listed.length).toBeGreaterThan(0);

    const written = [...endpoint.matchAll(/updates\.([a-z_]+) = /g)].map((m) => m[1]);
    expect(written.length, 'update-user should still write profile fields').toBeGreaterThan(0);
    const unclassified = written.filter((f) => !fields.includes(f));
    expect(unclassified, `update-user writes ${unclassified.join(', ')} without classifying it`).toEqual([]);
  });
});
