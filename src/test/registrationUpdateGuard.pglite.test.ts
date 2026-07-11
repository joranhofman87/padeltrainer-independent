// @vitest-environment node
// Audit Batch 1 (V4): update_registration_with_cycle is SECURITY DEFINER + GRANTed to authenticated,
// so a direct call bypasses the client edit-routing gate. Runs the REAL migration SQL (PGlite):
//   • it REFUSES to adopt a plain training cyclus (no overlay, type='cyclus');
//   • it allows a legacy typed registration and a post-split registration (type='cyclus' + overlay);
//   • editing MERGES the whitelisted form keys onto cycles.settings — never wiping booking/rebook state.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const C_CYCLUS = '30000000-0000-0000-0000-000000000001'; // training cyclus, no overlay → blocked
const C_LEGACY = '30000000-0000-0000-0000-000000000002'; // legacy type='registration', no overlay → ok
const C_SPLIT = '30000000-0000-0000-0000-000000000003';  // type='cyclus' + overlay → ok
const C_MERGE = '30000000-0000-0000-0000-000000000004';  // settings-merge case
const C_DELETE = '30000000-0000-0000-0000-000000000005'; // delete-cascades-overlay case

const call = async (cycleId: string, settings: Record<string, unknown> | null) =>
  db.query(
    `SELECT public.update_registration_with_cycle(
       $1::uuid, 'registration', 'Name', NULL, NULL, NULL, NULL, 'open',
       NULL, NULL, NULL, NULL, $2::jsonb, NULL, NULL)`,
    [cycleId, settings == null ? null : JSON.stringify(settings)],
  );
const cycleSettings = async (id: string): Promise<Record<string, unknown>> =>
  (await db.query<{ settings: Record<string, unknown> }>(`SELECT settings FROM public.cycles WHERE id = $1`, [id])).rows[0].settings;
const overlayCount = async (id: string): Promise<number> =>
  Number((await db.query<{ n: string }>(`SELECT count(*) n FROM public.registrations WHERE source_cycle_id = $1`, [id])).rows[0].n);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE TABLE public.cycles (
      id uuid PRIMARY KEY, owner_type text, owner_id uuid, type text, settings jsonb,
      name text, description text, start_date date, end_date date, enrollment_deadline timestamptz,
      is_always_open boolean, status text, location_id uuid, currency text, terms text, updated_at timestamptz);
    CREATE TABLE public.registrations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_cycle_id uuid UNIQUE, owner_type text, owner_id uuid,
      format text, name text, description text, start_date date, end_date date, enrollment_deadline timestamptz,
      status text, total_price numeric, currency text, price_table jsonb, location_id uuid, settings jsonb,
      created_at timestamptz DEFAULT now(), updated_at timestamptz);

    -- Bypass the ownership auth (unchanged by V4); the real _registration_form_settings whitelist.
    CREATE FUNCTION public._registration_owner_authorized(p_owner_type text, p_owner_id uuid)
      RETURNS boolean LANGUAGE sql AS $fn$ SELECT true $fn$;
    CREATE FUNCTION public._registration_form_settings(p_settings jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
      SELECT COALESCE((SELECT jsonb_object_agg(k, p_settings->k)
        FROM unnest(ARRAY['lesson_types','custom_lesson_types','show_preferred_trainer','show_price_indication',
          'cyclus_options','duration_options','available_duration_minutes','price_columns','prices_include_vat',
          'success_message','confirmation_email_text','payment_methods','rating_system','default_duration_minutes',
          'available_days','max_participants','notify_admin_on_submission','notify_admin_emails','pricing_note']) AS k
        WHERE p_settings ? k), '{}'::jsonb) $fn$;

    INSERT INTO public.cycles (id, owner_type, owner_id, type, settings) VALUES
      ('${C_CYCLUS}', 'academy', gen_random_uuid(), 'cyclus', '{}'::jsonb),
      ('${C_LEGACY}', 'academy', gen_random_uuid(), 'registration', '{}'::jsonb),
      ('${C_SPLIT}',  'academy', gen_random_uuid(), 'cyclus', '{}'::jsonb),
      ('${C_MERGE}',  'academy', gen_random_uuid(), 'registration', '{"rebook_state":{"round":1},"split_payment":true}'::jsonb),
      ('${C_DELETE}', 'academy', gen_random_uuid(), 'cyclus', '{}'::jsonb);
    -- C_SPLIT + C_DELETE already have an overlay (post-split registration born type='cyclus').
    INSERT INTO public.registrations (source_cycle_id, owner_type, owner_id, format, name, status) VALUES
      ('${C_SPLIT}',  'academy', (SELECT owner_id FROM public.cycles WHERE id='${C_SPLIT}'),  'registration', 'Existing', 'open'),
      ('${C_DELETE}', 'academy', (SELECT owner_id FROM public.cycles WHERE id='${C_DELETE}'), 'registration', 'ToDelete', 'open');
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260811100000_registration_update_guard_and_settings_merge.sql'), 'utf8'));
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260811110000_registration_overlay_fk_cascade.sql'), 'utf8'));
});

describe('update_registration_with_cycle — type/overlay guard (audit Batch 1 V4)', () => {
  it('REFUSES to adopt a plain training cyclus (no overlay, type=cyclus)', async () => {
    await expect(call(C_CYCLUS, { lesson_types: ['x'] })).rejects.toThrow(/not_a_registration_cycle/);
    expect(await overlayCount(C_CYCLUS)).toBe(0); // no overlay minted
  });

  it('allows a LEGACY typed registration cycle (no overlay yet)', async () => {
    await call(C_LEGACY, { lesson_types: ['x'] });
    expect(await overlayCount(C_LEGACY)).toBe(1); // overlay adopted
  });

  it('allows a POST-SPLIT registration (type=cyclus WITH an overlay)', async () => {
    await call(C_SPLIT, { lesson_types: ['y'] });
    expect(await overlayCount(C_SPLIT)).toBe(1); // still one overlay (updated, not duplicated)
  });
});

describe('update_registration_with_cycle — settings MERGE, not replace (audit Batch 1 V4)', () => {
  it('preserves booking/rebook state and applies only the whitelisted form keys', async () => {
    await call(C_MERGE, { lesson_types: ['padel'], max_participants: 4, not_a_form_key: 'ignored' });
    const s = await cycleSettings(C_MERGE);
    expect(s.rebook_state).toEqual({ round: 1 }); // preserved (was full-wiped before)
    expect(s.split_payment).toBe(true);           // preserved
    expect(s.lesson_types).toEqual(['padel']);    // form key applied
    expect(s.max_participants).toBe(4);           // form key applied
    expect(s.not_a_form_key).toBeUndefined();     // non-whitelisted key never reaches the cycle
  });
});

describe('deleting a split registration cascades its overlay (audit Batch 1 §3.1 delete)', () => {
  it('DELETE the cycle shell now succeeds and removes the 1:1 overlay (was blocked by RESTRICT)', async () => {
    expect(await overlayCount(C_DELETE)).toBe(1);
    // deleteCycle() deletes the cycles row directly; the overlay FK is now ON DELETE CASCADE.
    await db.query(`DELETE FROM public.cycles WHERE id = $1`, [C_DELETE]);
    expect(await overlayCount(C_DELETE)).toBe(0); // overlay cascade-deleted, no foreign_key_violation
  });
});
