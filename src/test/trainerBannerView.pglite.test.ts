// @vitest-environment node
// trainer_profiles.banner_url (migration 20260709100000): the column is added and
// trainer_profiles_safe re-exposes it while KEEPING the P-02 semantics — sensitive
// columns stay hidden and is_active_subscription still counts academy entitlement.
// Runs the REAL migration SQL (GRANT lines stripped — PGlite has no anon role).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const TP = '10000000-0000-0000-0000-000000000001';
const TP_COVERED = '10000000-0000-0000-0000-000000000002';
const ACADEMY = '20000000-0000-0000-0000-000000000001';

function readMigration(): string {
  return readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260709100000_trainer_banner_url.sql'),
    'utf8',
  )
    .split('\n')
    .filter((l) => !/^(REVOKE|GRANT)\b/.test(l))
    .join('\n');
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE trainer_profiles (
      id uuid PRIMARY KEY,
      user_id uuid,
      slug text,
      hourly_rate numeric,
      coaching_since_year integer,
      experience_years integer,
      certifications text[],
      specializations text[],
      is_verified boolean DEFAULT false,
      knltb_rating numeric,
      trainer_rating_system text,
      coaching_method text,
      favourite_quote text,
      video_url text,
      website_url text,
      social_instagram text,
      social_tiktok text,
      social_youtube text,
      social_linkedin text,
      preferred_min_rating numeric,
      preferred_max_rating numeric,
      preferred_rating_system text,
      is_public boolean DEFAULT false,
      slot_duration_minutes integer,
      schedule_weeks_ahead integer,
      require_booking_approval boolean,
      use_manual_invoicing boolean,
      waiting_list_enabled boolean,
      welcome_message text,
      general_terms text,
      subscription_status text,
      trial_ends_at timestamptz,
      iban text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE academy_profiles (id uuid PRIMARY KEY, subscription_status text, trial_ends_at timestamptz);
    CREATE TABLE academy_trainers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trainer_profile_id uuid,
      academy_profile_id uuid,
      status text
    );
  `);
  await db.exec(readMigration());

  await db.query(
    `INSERT INTO trainer_profiles (id, user_id, subscription_status, banner_url) VALUES
       ($1, gen_random_uuid(), 'inactive', 'https://x/banner.png'),
       ($2, gen_random_uuid(), 'inactive', NULL)`,
    [TP, TP_COVERED],
  );
  await db.query(`INSERT INTO academy_profiles (id, subscription_status) VALUES ($1, 'active')`, [ACADEMY]);
  await db.query(
    `INSERT INTO academy_trainers (trainer_profile_id, academy_profile_id, status) VALUES ($1, $2, 'active')`,
    [TP_COVERED, ACADEMY],
  );
});

describe('trainer_profiles_safe after 20260709100000 (real migration SQL)', () => {
  it('exposes banner_url', async () => {
    const { rows } = await db.query<{ banner_url: string | null }>(
      `SELECT banner_url FROM trainer_profiles_safe WHERE id = $1`,
      [TP],
    );
    expect(rows[0].banner_url).toBe('https://x/banner.png');
  });

  it('still hides sensitive columns (iban, raw subscription_status, trial_ends_at)', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'trainer_profiles_safe'`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain('banner_url');
    expect(cols).not.toContain('iban');
    expect(cols).not.toContain('subscription_status');
    expect(cols).not.toContain('trial_ends_at');
  });

  it('keeps the P-02 academy-entitlement computation intact', async () => {
    const { rows } = await db.query<{ id: string; is_active_subscription: boolean }>(
      `SELECT id, is_active_subscription FROM trainer_profiles_safe ORDER BY id`,
    );
    const byId = new Map(rows.map((r) => [r.id, r.is_active_subscription]));
    expect(byId.get(TP)).toBe(false); // no own sub, no academy
    expect(byId.get(TP_COVERED)).toBe(true); // covered by active academy
  });

  it('experience_years still derives from coaching_since_year', async () => {
    await db.query(`UPDATE trainer_profiles SET coaching_since_year = 2020, experience_years = 99 WHERE id = $1`, [TP]);
    const { rows } = await db.query<{ experience_years: number }>(
      `SELECT experience_years FROM trainer_profiles_safe WHERE id = $1`,
      [TP],
    );
    expect(rows[0].experience_years).toBe(new Date().getFullYear() - 2020);
  });
});
