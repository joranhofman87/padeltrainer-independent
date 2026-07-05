// @vitest-environment node
// P2-1 regression: cycles_public view must NOT expose notify_admin_emails and must
// be a PLAIN-column view (no embed) so the frontend JS location-join is required.
//
// Loads the ACTUAL migration SQL via readFileSync (mirrors the other pglite tests) so
// it fails before the migration exists and catches drift between the shipped SQL and
// the tested logic. The migration also re-scopes the base anon policy and grants the
// view to anon/authenticated; those roles + the base cycles table are stubbed here so
// the full migration applies cleanly.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

function readMigration(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  return readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260706130300_p2_1_cycles_public_view.sql'),
    'utf8',
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    -- 'postgres' owner role for the ALTER VIEW ... OWNER TO postgres in the migration.
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
        CREATE ROLE postgres;
      END IF;
    END $$;

    CREATE TABLE public.cycles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_type text, owner_id uuid, name text, description text,
      start_date date, end_date date, enrollment_deadline timestamptz,
      is_always_open boolean DEFAULT false,
      settings jsonb DEFAULT '{}'::jsonb, status text, type text,
      location_id uuid, price_per_session numeric, total_price numeric,
      currency text DEFAULT 'EUR', terms text, price_table jsonb,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    ALTER TABLE public.cycles ENABLE ROW LEVEL SECURITY;
    -- The migration DROP/CREATEs this policy; create a placeholder so the DROP is a no-op-safe.
    CREATE POLICY "Anyone can view open cycles" ON public.cycles FOR SELECT USING (status = 'open');
  `);

  // Apply the REAL migration under test.
  await db.exec(readMigration());

  await db.query(
    `INSERT INTO public.cycles (owner_type, owner_id, name, status, type, terms, settings)
     VALUES ('academy', gen_random_uuid(), 'Open Cycle', 'open', 'registration', 'You agree to the rules', $1::jsonb)`,
    [JSON.stringify({
      lesson_types: ['group'],
      success_message: 'Thanks!',
      min_group_size: 2,           // training key the public BookLesson page needs
      split_payment: true,          // training key
      notify_admin_emails: 'boss@club.nl',      // PRIVATE — must be stripped
      notify_admin_on_submission: true,          // PRIVATE — must be stripped
    })],
  );
});

describe('cycles_public view (P2-1)', () => {
  it('strips the private notify keys but keeps form + training keys + terms', async () => {
    const r = await db.query<{ settings: Record<string, unknown>; terms: string }>(
      `SELECT settings, terms FROM public.cycles_public`,
    );
    const row = r.rows[0];
    expect(row.settings).not.toHaveProperty('notify_admin_emails');
    expect(row.settings).not.toHaveProperty('notify_admin_on_submission');
    expect(row.settings.lesson_types).toEqual(['group']);
    expect(row.settings.success_message).toBe('Thanks!');
    expect(row.settings.min_group_size).toBe(2);
    expect(row.settings.split_payment).toBe(true);
    expect(row.terms).toBe('You agree to the rules');
  });

  it('leaves the private key intact on the BASE table (leak is view-scoped, not deleted)', async () => {
    const r = await db.query<{ leak: string | null }>(
      `SELECT settings->>'notify_admin_emails' AS leak FROM public.cycles`,
    );
    expect(r.rows[0].leak).toBe('boss@club.nl');
  });

  it('the view only surfaces open cycles (predicate not widened)', async () => {
    await db.query(
      `INSERT INTO public.cycles (owner_type, owner_id, name, status, type)
       VALUES ('academy', gen_random_uuid(), 'Draft', 'draft', 'registration')`,
    );
    const r = await db.query<{ n: string }>(`SELECT count(*)::text n FROM public.cycles_public`);
    expect(Number(r.rows[0].n)).toBe(1);
  });

  it('is a PLAIN-column view: exposes location_id but NO joined location object', async () => {
    const r = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'cycles_public'`,
    );
    const cols = r.rows.map((x) => x.column_name);
    expect(cols).toContain('location_id');
    expect(cols).not.toContain('location'); // no embed — frontend joins locations in JS
  });
});
