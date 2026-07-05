import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Public-booking audit P0-1: a logged-in player could self-INSERT a booking with
// payment_status='paid' (+ paid_at / mollie ids) → a confirmed seat that looks PAID
// without paying (the pay-first rule was React-only). The fix is a BEFORE INSERT trigger
// that FORCES the proof-of-online-payment columns safe on a player self-insert. This test
// locks its SHAPE so a future migration can't silently weaken it (drop a forced column,
// remove the service-role / staff pass-through, or flip BEFORE INSERT). Behavioural
// verification under a real player auth context is a PGlite-rehearsal follow-up (same
// convention as bookingFinancialGuard.test.ts).
const MIGRATION_FILE = '20260706130000_protect_booking_payment_on_player_insert.sql';

function readMigration(): string {
  const path = join(process.cwd(), 'supabase', 'migrations', MIGRATION_FILE);
  expect(existsSync(path), `migration file missing: ${path}`).toBe(true);
  return readFileSync(path, 'utf8');
}

describe('booking payment-insert guard — players cannot self-insert a paid booking', () => {
  const sql = readMigration();

  it('wires a BEFORE INSERT row trigger on public.bookings to the guard function', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.protect_booking_payment_on_player_insert()');
    expect(sql).toContain('BEFORE INSERT ON public.bookings');
    expect(sql).toContain('FOR EACH ROW');
    expect(sql).toContain('EXECUTE FUNCTION public.protect_booking_payment_on_player_insert()');
  });

  it('passes through service-role / unauthenticated server writes (auth.uid() IS NULL)', () => {
    expect(sql).toMatch(/IF auth\.uid\(\) IS NULL THEN\s*\n\s*RETURN NEW;\s*\n\s*END IF;/);
  });

  it('passes through staff acting on another player’s booking (player_id != caller)', () => {
    expect(sql).toContain('v_player_profile_id := public.get_profile_id_for_user(auth.uid());');
    expect(sql).toMatch(
      /IF v_player_profile_id IS NULL OR NEW\.player_id IS DISTINCT FROM v_player_profile_id THEN\s*\n\s*RETURN NEW;\s*\n\s*END IF;/,
    );
  });

  it('forces EVERY proof-of-online-payment column to a safe default on a player self-insert', () => {
    expect(sql).toContain("NEW.payment_status := 'pending';");
    expect(sql).toContain('NEW.paid_at := NULL;');
    expect(sql).toContain('NEW.mollie_payment_id := NULL;');
    expect(sql).toContain('NEW.mollie_transaction_id := NULL;');
  });

  it('runs SECURITY DEFINER with a pinned search_path (so auth.uid()/get_profile_id_for_user resolve)', () => {
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public');
  });

  it('does NOT force paid_externally (a legitimate manual-invoicing self-insert value)', () => {
    // paid_externally is the manual-cycle-aware P2 follow-up; forcing it here would break
    // legitimate manual-invoicing bookings.
    expect(sql).not.toContain('NEW.paid_externally :=');
  });
});
