import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * EVERY TABLE AND COLUMN AN EDGE FUNCTION NAMES MUST EXIST.
 *
 * This generalises two bugs that shipped, both of the same shape and both invisible to their own
 * unit tests because the tests served an in-memory fake of whatever was asked for:
 *
 *   * `trainer-authority.ts` queried `club_trainers` — a table no migration creates. It failed
 *     closed on every call, silently revoking the capability it was written to preserve.
 *   * `notification-occurrence.ts` selected `availability_slots.updated_at` — a column that does
 *     not exist. PostgREST answers 42703, the helper returns null, and the caller 503s. Latent
 *     only because that branch has no in-repo invoker yet.
 *
 * A fake proves nothing about the schema. The generated types are the schema, so that is what a
 * `.from(...).select(...)` is checked against here.
 *
 * Deliberately narrow: it reads the STATIC `.from("x").select("a, b")` pairs it can see with
 * certainty, and skips anything dynamic. A guard that guessed would be turned off within a month.
 */

const ROOT = resolve(__dirname, '..', '..');
const TYPES = readFileSync(resolve(ROOT, 'src/integrations/supabase/types.ts'), 'utf8');

/** the public schema's Tables + Views blocks, as { table -> Set(columns) } */
function schemaFromTypes(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  // Row: { col: type ... } inside a `tablename: {` block
  const re = /^ {6}([a-z0-9_]+): \{\n {8}Row: \{\n([\s\S]*?)\n {8}\}/gm;
  for (const m of TYPES.matchAll(re)) {
    const cols = new Set<string>();
    for (const c of m[2].matchAll(/^\s{10}([a-z0-9_]+)(\?)?:/gm)) cols.add(c[1]);
    if (cols.size > 0) out.set(m[1], cols);
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.ts$/.test(p) && !/\.test\.ts$/.test(p)) acc.push(p);
  }
  return acc;
}

describe('edge functions only name tables and columns that exist', () => {
  const schema = schemaFromTypes();

  it('the generated types parsed into a usable schema', () => {
    expect(schema.size).toBeGreaterThan(50);
    expect(schema.get('bookings')?.has('updated_at')).toBe(true);
    // the exact column the second bug read — proving the guard can tell the difference
    expect(schema.get('availability_slots')?.has('updated_at')).toBe(false);
    expect(schema.has('club_trainers')).toBe(false);
  });

  it('no .from("table") in supabase/functions names a table the schema does not have', () => {
    const files = walk(resolve(ROOT, 'supabase/functions'));
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\.from\(\s*["'`]([a-z0-9_]+)["'`]\s*\)/g)) {
        const table = m[1];
        // storage buckets are not schema tables: `supabase.storage.from("avatars")`
        const before = src.slice(Math.max(0, m.index! - 40), m.index!);
        if (/storage\s*$/.test(before) || /storage\.\s*$/.test(before)) continue;
        if (!schema.has(table)) {
          offenders.push(`${f.replace(ROOT + '/', '')}: .from("${table}") — not in the generated schema`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no static .select("col, col") reads a column its table does not have', () => {
    const files = walk(resolve(ROOT, 'supabase/functions'));
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      // only the immediate `.from("t")….select("cols")` pair, and only when the select list is a
      // plain column list — embeds (`a:b(...)`), `*`, and anything computed are skipped
      for (const m of src.matchAll(/\.from\(\s*["'`]([a-z0-9_]+)["'`]\s*\)\s*\n?\s*\.select\(\s*["'`]([^"'`]+)["'`]/g)) {
        const [, table, list] = m;
        const cols = schema.get(table);
        if (!cols) continue;                       // covered by the table test above
        if (/[(*)]/.test(list)) continue;          // embed or star: out of scope, deliberately
        for (const raw of list.split(',')) {
          const col = raw.trim().split(':').pop()!.trim();
          if (!col || /\s/.test(col)) continue;
          if (!cols.has(col)) {
            offenders.push(`${f.replace(ROOT + '/', '')}: ${table}.${col} does not exist`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
