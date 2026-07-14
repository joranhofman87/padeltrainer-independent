// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Registration decoupling Phase 2d+2f — applies the REAL migrations (2a then 2d/2f) against a
// faithful mini-schema and proves the destructive shell cleanup is safe:
//  - an UNPLANNED form's shell (0 slots/0 bookings) is deleted; its intakes survive with cycle_id
//    NULL + registration_id intact; its invoice survives, repointed to registration_id;
//  - a PLANNED form's shell (has a slot) is NOT deleted;
//  - after cutover, an intake needs a valid registration_id (cycle_id may be NULL).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const mig = (name: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', name), 'utf8');
const MIG_2A = mig('20260823100000_registration_decouple_2a_intake_registration_link.sql');
const MIG_2D2F = mig('20260823120000_registration_decouple_2d2f_submit_and_shell_cleanup.sql');

// Form A — UNPLANNED (shell deleted). Form B — PLANNED (shell kept).
const CA = '10000000-0000-0000-0000-00000000000a';
const CB = '10000000-0000-0000-0000-00000000000b';
const RA = '20000000-0000-0000-0000-00000000000a';
const RB = '20000000-0000-0000-0000-00000000000b';

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.cycles (id uuid PRIMARY KEY, type text NOT NULL DEFAULT 'cyclus');
    CREATE TABLE public.registrations (
      id uuid PRIMARY KEY,
      source_cycle_id uuid CONSTRAINT registrations_source_cycle_id_fkey REFERENCES public.cycles(id)
    );
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, cyclus_id uuid REFERENCES public.cycles(id) ON DELETE SET NULL);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY, slot_id uuid REFERENCES public.availability_slots(id));
    CREATE TABLE public.invoices (id uuid PRIMARY KEY, cycle_id uuid REFERENCES public.cycles(id) ON DELETE SET NULL, status text);
    CREATE TABLE public.intake_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cycle_id uuid NOT NULL REFERENCES public.cycles(id) ON DELETE CASCADE,
      registration_id uuid REFERENCES public.registrations(id) ON DELETE SET NULL,
      player_id uuid,
      full_name text
    );
    -- The old guard 2d replaces (so CREATE OR REPLACE in 2d finds a function to replace).
    CREATE FUNCTION public.enforce_intake_target_is_registration() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
    CREATE TRIGGER trg_intake_target_is_registration BEFORE INSERT ON public.intake_requests
      FOR EACH ROW EXECUTE FUNCTION public.enforce_intake_target_is_registration();

    INSERT INTO public.cycles (id) VALUES ('${CA}'), ('${CB}');
    INSERT INTO public.registrations (id, source_cycle_id) VALUES ('${RA}', '${CA}'), ('${RB}', '${CB}');
    -- Form A: one intake (registration_id NULL — a "straggler" the 2a backfill must fix) + one invoice.
    INSERT INTO public.intake_requests (id, cycle_id, registration_id, full_name)
      VALUES ('30000000-0000-0000-0000-0000000000a1', '${CA}', NULL, 'applicant A');
    INSERT INTO public.invoices (id, cycle_id, status) VALUES ('40000000-0000-0000-0000-0000000000a1', '${CA}', 'paid');
    -- Form B: PLANNED — has a slot on its shell.
    INSERT INTO public.availability_slots (id, cyclus_id) VALUES ('50000000-0000-0000-0000-0000000000b1', '${CB}');
    INSERT INTO public.intake_requests (id, cycle_id, registration_id, full_name)
      VALUES ('30000000-0000-0000-0000-0000000000b1', '${CB}', NULL, 'applicant B');
  `);
  await db.exec(MIG_2A);
  await db.exec(MIG_2D2F);
});

describe('Phase 2d+2f: shell cleanup safety', () => {
  it("deletes the UNPLANNED form's shell", async () => {
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.cycles WHERE id = '${CA}'`);
    expect(rows[0].n).toBe(0);
  });

  it("keeps the PLANNED form's shell", async () => {
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.cycles WHERE id = '${CB}'`);
    expect(rows[0].n).toBe(1);
  });

  it("preserves the unplanned form's applicant (cycle_id NULL, registration_id intact)", async () => {
    const { rows } = await db.query<{ cycle_id: string | null; registration_id: string }>(
      `SELECT cycle_id, registration_id FROM public.intake_requests WHERE id = '30000000-0000-0000-0000-0000000000a1'`,
    );
    expect(rows).toHaveLength(1); // NOT cascade-deleted with the shell
    expect(rows[0].cycle_id).toBeNull();
    expect(rows[0].registration_id).toBe(RA);
  });

  it("preserves the invoice, repointed to registration_id", async () => {
    const { rows } = await db.query<{ cycle_id: string | null; registration_id: string | null; status: string }>(
      `SELECT cycle_id, registration_id, status FROM public.invoices WHERE id = '40000000-0000-0000-0000-0000000000a1'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('paid');
    expect(rows[0].cycle_id).toBeNull();
    expect(rows[0].registration_id).toBe(RA);
  });

  it('keeps source_cycle_id as a legacy-URL alias even after the shell is deleted', async () => {
    const { rows } = await db.query<{ id: string; source_cycle_id: string | null }>(
      `SELECT id, source_cycle_id FROM public.registrations ORDER BY id`,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.source_cycle_id]));
    // Alias value survives the shell delete (FK dropped) so old /register/:sourceCycleId links resolve.
    expect(byId[RA]).toBe(CA);
    expect(byId[RB]).toBe(CB);
  });
});

describe('Phase 2d: intake guard keys on registration_id', () => {
  it('accepts an intake with a valid registration_id and NULL cycle_id (the new model)', async () => {
    const { rows } = await db.query<{ registration_id: string; cycle_id: string | null }>(
      `INSERT INTO public.intake_requests (registration_id, cycle_id, full_name)
       VALUES ('${RA}', NULL, 'planned-later') RETURNING registration_id, cycle_id`,
    );
    expect(rows[0].registration_id).toBe(RA);
    expect(rows[0].cycle_id).toBeNull();
  });

  it('rejects an intake whose registration_id does not exist', async () => {
    let failed = false;
    try {
      await db.query(
        `INSERT INTO public.intake_requests (registration_id, cycle_id, full_name)
         VALUES ('99999999-9999-9999-9999-999999999999', NULL, 'bad')`,
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
