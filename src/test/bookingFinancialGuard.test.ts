import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// B2 (rebook go-live audit, task #55): a logged-in player must not be able to
// PATCH their own booking's money columns to mark themselves paid. The guard is
// a BEFORE UPDATE trigger; this test locks its SHAPE so a future migration can't
// silently weaken it (drop a protected column, remove the service-role / staff
// pass-through, or change the error contract). Behavioural verification (the
// trigger actually raising under a player auth context) is a PGlite rehearsal
// follow-up; this static guard runs in CI on every change.
const MIGRATION_FILE = '20260624120000_protect_booking_financial_columns_for_players.sql';

function readMigration(): string {
  const path = join(process.cwd(), 'supabase', 'migrations', MIGRATION_FILE);
  expect(existsSync(path), `migration file missing: ${path}`).toBe(true);
  return readFileSync(path, 'utf8');
}

describe('booking financial-column guard — players cannot change their own booking payment fields', () => {
  const sql = readMigration();

  it('wires a BEFORE UPDATE row trigger on public.bookings to the guard function', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.protect_booking_financial_columns_for_players()');
    expect(sql).toContain('BEFORE UPDATE ON public.bookings');
    expect(sql).toContain('FOR EACH ROW');
    expect(sql).toContain('EXECUTE FUNCTION public.protect_booking_financial_columns_for_players()');
  });

  it('passes through service-role / unauthenticated server writes (auth.uid() IS NULL)', () => {
    // Bind RETURN NEW to the EXACT NULL-auth guard (no intervening statements),
    // so inserting a condition before it would break this assertion.
    expect(sql).toMatch(/IF auth\.uid\(\) IS NULL THEN\s*\n\s*RETURN NEW;\s*\n\s*END IF;/);
  });

  it('passes through staff acting on another player’s booking (player_id != caller)', () => {
    expect(sql).toContain('v_player_profile_id := public.get_profile_id_for_user(auth.uid());');
    // RETURN NEW must be tied to the exact "not my booking" condition.
    expect(sql).toMatch(
      /IF v_player_profile_id IS NULL OR NEW\.player_id IS DISTINCT FROM v_player_profile_id THEN\s*\n\s*RETURN NEW;\s*\n\s*END IF;/
    );
  });

  it('blocks the booking-owner from changing EVERY financial / payment column', () => {
    const protectedColumns = [
      'payment_status',
      'paid_at',
      'paid_externally',
      'payment_amount',
      'original_amount',
      'discount_amount',
      'discount_reason',
      'mollie_payment_id',
      'mollie_transaction_id',
    ];
    for (const col of protectedColumns) {
      expect(sql, `guard must still cover ${col}`).toContain(`NEW.${col} IS DISTINCT FROM OLD.${col}`);
    }
  });

  it('raises a stable, typed error when a player touches a protected column', () => {
    expect(sql).toContain("RAISE EXCEPTION 'players_may_not_change_booking_payment_fields'");
    expect(sql).toContain("USING ERRCODE = 'check_violation'");
  });
});
