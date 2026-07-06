// @vitest-environment node
// Regression: profiles.skill_rating updates aborted app-wide because the
// DIVERGENCE-6 sync trigger (20260613200000) stamps source='profile' while the
// player_rating_history CHECK (20260117133442) only allowed manual/knltb_scrape.
// Runs the REAL trigger migration against the ORIGINAL check to reproduce, then
// the REAL fix migration (20260710100000) to prove rating edits work again.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const P1 = '10000000-0000-0000-0000-000000000001';

const readMigration = (name: string) =>
  readFileSync(join(process.cwd(), 'supabase', 'migrations', name), 'utf8')
    .split('\n')
    .filter((l) => !/^(REVOKE|GRANT)\b/.test(l))
    .join('\n');

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE profiles (
      id uuid PRIMARY KEY,
      user_id uuid,
      skill_rating numeric,
      rating_system text
    );
    -- The ORIGINAL table shape (20260117133442): the narrow CHECK under test.
    CREATE TABLE player_rating_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      profile_id uuid NOT NULL,
      rating numeric NOT NULL,
      rating_system text NOT NULL,
      source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'knltb_scrape')),
      scraped_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  // The REAL sync-trigger migration (its one-time reconcile matches zero rows here,
  // exactly like in prod at apply time — which is why the bug shipped latently).
  await db.exec(readMigration('20260613200000_skill_rating_history_sync.sql'));
  await db.query(`INSERT INTO profiles (id, user_id, skill_rating, rating_system) VALUES ($1, gen_random_uuid(), 6.5, 'knltb')`, [P1]);
});

describe('player_rating_history source check (real migration SQL)', () => {
  it('reproduces the bug: a rating change is refused under the original CHECK', async () => {
    let msg = '';
    await db
      .query(`UPDATE profiles SET skill_rating = 7.0 WHERE id = $1`, [P1])
      .catch((e: { message?: string }) => {
        msg = String(e.message ?? e);
      });
    expect(msg).toContain('player_rating_history_source_check');
  });

  it('fix migration: rating changes work and append a history row (source=profile)', async () => {
    await db.exec(readMigration('20260710100000_fix_rating_history_source_check.sql'));
    await db.query(`UPDATE profiles SET skill_rating = 7.0 WHERE id = $1`, [P1]);
    const { rows } = await db.query<{ rating: string; source: string }>(
      `SELECT rating, source FROM player_rating_history WHERE profile_id = $1 ORDER BY scraped_at DESC LIMIT 1`,
      [P1],
    );
    expect(rows[0].source).toBe('profile');
    expect(Number(rows[0].rating)).toBe(7.0);
  });

  it('keeps the guardrail: an unknown source is still refused', async () => {
    let msg = '';
    await db
      .query(`INSERT INTO player_rating_history (profile_id, rating, rating_system, source) VALUES ($1, 5, 'knltb', 'bogus')`, [P1])
      .catch((e: { message?: string }) => {
        msg = String(e.message ?? e);
      });
    expect(msg).toContain('player_rating_history_source_check');
  });

  it('existing writers stay valid: manual and knltb_scrape inserts pass', async () => {
    await db.query(
      `INSERT INTO player_rating_history (profile_id, rating, rating_system, source) VALUES ($1, 5, 'knltb', 'manual'), ($1, 5.5, 'knltb', 'knltb_scrape')`,
      [P1],
    );
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM player_rating_history WHERE profile_id = $1`,
      [P1],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(3);
  });
});
