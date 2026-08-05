import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * N3 M5 — the attribution matrix's drift pins (design-contract finding 2).
 *
 * `docs/NOTIFICATION_ATTRIBUTION_MATRIX.md` claims, per producer, exactly which tenant
 * attribution reaches `enqueue_notification` — and every cap surface leans on those claims
 * ("a cap on open_slots_player affects nothing today" is only true while notify-followers stays
 * trainer-only). A doc nothing enforces rots into a lie; these pins fail when a producer's
 * attribution changes, forcing the matrix (and the M6 surfaces reading it) to be updated in the
 * same change.
 */

const ROOT = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('attribution matrix pins', () => {
  it('row 1 — the booking RPC derives BOTH tenants from the booked slots, refusing incoherent sets', () => {
    const src = read('supabase/migrations/20260926100000_booking_notification_enqueue_rpc.sql');
    expect(src).toContain('JOIN public.availability_slots s ON s.id = b.slot_id');
    expect(src).toContain("RAISE EXCEPTION 'enqueue_booking_notification: booking set spans multiple academy scopes'");
    // both call sites supply both tenants
    const supplies = src.match(/p_tenant_academy_profile_id => v_academy/g) ?? [];
    expect(supplies.length).toBeGreaterThanOrEqual(2);
  });

  it('row 2 — booking-confirmation supplies academy + trainer', () => {
    const src = read('supabase/functions/_shared/booking-confirmation-email.ts');
    expect(src).toContain('p_tenant_academy_profile_id: academyProfileId');
    expect(src).toContain('p_tenant_trainer_id: trainerId');
  });

  it('row 3 — mollie staff fan-out supplies the per-recipient staff scope', () => {
    const src = read('supabase/functions/_shared/mollie-booking-paid-side-effects.ts');
    expect(src).toContain('p_tenant_academy_profile_id: scope.academy ?? null');
    expect(src).toContain('p_tenant_trainer_id: scope.trainer ?? null');
  });

  it('row 4 — open_slots_player is TRAINER-ONLY: no academy attribution exists to cap', () => {
    const src = read('supabase/functions/notify-followers/index.ts');
    expect(src).toContain('p_tenant_trainer_id: trainerId');
    // The claim every cap surface depends on: if someone adds academy attribution here, the
    // matrix row and the M6 "affects nothing today" copy are BOTH wrong — fail until updated.
    expect(src).not.toContain('p_tenant_academy_profile_id');
  });

  it('row 5 — review_received_trainer is trainer-only', () => {
    const src = read('supabase/migrations/20260913100000_notification_pilot_review_received.sql');
    expect(src).toContain('p_tenant_trainer_id   => NEW.trainer_id');
    expect(src).not.toContain('p_tenant_academy_profile_id');
  });

  it('the producer inventory is CLOSED: exactly these files call enqueue_notification', () => {
    // A new producer must join the matrix and these pins in the same change. This walks the two
    // trees that can hold callers and asserts the known set — a sixth caller fails here first.
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execSync(
      `grep -rl "enqueue_notification\\|enqueue_booking_notification" supabase/functions supabase/migrations`,
      { cwd: ROOT, encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      // resolver-definition migrations and N3's own files DEFINE or replay the function; tests aside
      .filter((f) => !/20260911|20260922|20261011100000|20261011110000|20261015100000|20261015120000|\.test\./.test(f))
      .sort();
    expect(out).toEqual([
      'supabase/functions/_shared/booking-confirmation-email.ts',
      'supabase/functions/_shared/mollie-booking-paid-side-effects.ts',
      'supabase/functions/_shared/open-slots-notify.ts',
      'supabase/functions/notify-followers/index.ts',
      'supabase/migrations/20260913100000_notification_pilot_review_received.sql',
      'supabase/migrations/20260926100000_booking_notification_enqueue_rpc.sql',
    ]);
  });

  it('the matrix document exists and states the rule', () => {
    const doc = read('docs/NOTIFICATION_ATTRIBUTION_MATRIX.md');
    expect(doc).toContain('iff the producer supplied `p_tenant_academy_profile_id`');
    expect(doc).toContain('NEVER infers an academy');
    expect(doc).toContain('affects nothing today');
  });
});
