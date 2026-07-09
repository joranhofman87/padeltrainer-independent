import { describe, it, expect } from 'vitest';
import { planCycleExtension, buildRosterCopyRows, type ExtensionSlotInput, type TemplateRosterBooking } from '@/lib/cycleExtension';
import { SlotPlanError } from '@/lib/slotPlan';

describe('buildRosterCopyRows', () => {
  const tmpl = (over: Partial<TemplateRosterBooking> = {}): TemplateRosterBooking => ({
    player_id: null, guest_player_id: null, payment_amount: 20, original_amount: 20,
    discount_amount: 0, discount_reason: null, notes: null, status: 'confirmed', ...over,
  });

  it('copies a template roster onto the new slot but resets payment to UNPAID', () => {
    // A PAID guest on the template → attached to the new session, but NOT marked paid (new session).
    const rows = buildRosterCopyRows('new-slot', [tmpl({ guest_player_id: 'g1', payment_amount: 10 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slot_id: 'new-slot',
      guest_player_id: 'g1',
      player_id: null,
      status: 'confirmed',
      payment_status: 'pending',   // never inherit the template's paid state
      paid_externally: false,
      payment_amount: 10,          // but keep the exact per-slot amount (identical slot ⇒ same price)
    });
  });

  it('preserves the registered player identity + discount, and the enrolment status', () => {
    const rows = buildRosterCopyRows('s2', [
      tmpl({ player_id: 'p1', status: 'pending_approval', payment_amount: 15, original_amount: 20, discount_amount: 5, discount_reason: 'sibling' }),
    ]);
    expect(rows[0]).toMatchObject({
      player_id: 'p1', guest_player_id: null, status: 'pending_approval',
      payment_amount: 15, original_amount: 20, discount_amount: 5, discount_reason: 'sibling',
      payment_status: 'pending', paid_externally: false,
    });
  });

  it('copies every roster member and defaults a missing discount to 0', () => {
    const rows = buildRosterCopyRows('s3', [
      tmpl({ guest_player_id: 'g1', discount_amount: null }),
      tmpl({ player_id: 'p2' }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].discount_amount).toBe(0);
  });

  it('an empty template roster produces no rows', () => {
    expect(buildRosterCopyRows('s4', [])).toEqual([]);
  });

  it('paid mode marks the new bookings paid externally with a paid_at (no invoice will be raised)', () => {
    const rows = buildRosterCopyRows('s5', [tmpl({ guest_player_id: 'g1', payment_amount: 20 })], {
      paid: true, paidAtIso: '2027-01-01T00:00:00.000Z',
    });
    expect(rows[0]).toMatchObject({
      payment_status: 'paid', paid_externally: true, paid_at: '2027-01-01T00:00:00.000Z', payment_amount: 20,
    });
  });

  it('default (no opts) stays openstaand: pending + unpaid', () => {
    const rows = buildRosterCopyRows('s6', [tmpl({ player_id: 'p1' })]);
    expect(rows[0]).toMatchObject({ payment_status: 'pending', paid_externally: false, paid_at: null });
  });
});

const TZ = 'Europe/Amsterdam';
const slot = (id: string, startISO: string, durationMin = 60): ExtensionSlotInput => ({
  id,
  start_time: startISO,
  end_time: new Date(new Date(startISO).getTime() + durationMin * 60_000).toISOString(),
});

/** Re-derive a UTC instant's local HH:mm + ISO weekday in TZ, to assert the projection. */
function local(iso: string) {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso))) p[part.type] = part.value;
  return { weekday: p.weekday, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

describe('planCycleExtension', () => {
  it('extends a weekly Monday cycle to a later Monday — one new session per week', () => {
    // 2026-01-05 is a Monday; 18:00 Amsterdam (winter, UTC+1) = 17:00 UTC.
    const res = planCycleExtension([slot('s1', '2026-01-05T17:00:00.000Z')], '2026-01-26', TZ);
    expect(res.map((r) => r.start_time)).toEqual([
      '2026-01-12T17:00:00.000Z',
      '2026-01-19T17:00:00.000Z',
      '2026-01-26T17:00:00.000Z',
    ]);
    expect(res.every((r) => r.templateId === 's1')).toBe(true);
    expect(res.every((r) => local(r.start_time).weekday === 'Mon' && local(r.start_time).time === '18:00')).toBe(true);
    // duration preserved (1h)
    expect(res.every((r) => new Date(r.end_time).getTime() - new Date(r.start_time).getTime() === 3_600_000)).toBe(true);
  });

  it('DST: a session keeps its LOCAL time across the autumn switch (UTC hour shifts)', () => {
    // 2026-10-19 Mon 18:00 CEST (UTC+2) = 16:00 UTC. DST ends 2026-10-25; 2026-10-26 is winter (UTC+1).
    const res = planCycleExtension([slot('s1', '2026-10-19T16:00:00.000Z')], '2026-10-26', TZ);
    expect(res).toHaveLength(1);
    // Next Monday must stay 18:00 LOCAL → 17:00 UTC (not 16:00).
    expect(res[0].start_time).toBe('2026-10-26T17:00:00.000Z');
    expect(local(res[0].start_time)).toEqual({ weekday: 'Mon', time: '18:00' });
  });

  it('replicates EVERY weekday in the final week (Mon + Wed)', () => {
    const res = planCycleExtension(
      [slot('mon', '2026-01-05T17:00:00.000Z'), slot('wed', '2026-01-07T18:00:00.000Z')],
      '2026-01-19',
      TZ,
    );
    // Mon → Jan 12, 19 ; Wed → Jan 14 (Jan 21 is past the end).
    expect(res.map((r) => r.start_time)).toEqual([
      '2026-01-12T17:00:00.000Z',
      '2026-01-14T18:00:00.000Z',
      '2026-01-19T17:00:00.000Z',
    ]);
  });

  it('replicates parallel courts (two slots at the same instant → two each week)', () => {
    const res = planCycleExtension(
      [slot('courtA', '2026-01-05T17:00:00.000Z'), slot('courtB', '2026-01-05T17:00:00.000Z')],
      '2026-01-12',
      TZ,
    );
    expect(res).toHaveLength(2);
    expect(res.every((r) => r.start_time === '2026-01-12T17:00:00.000Z')).toBe(true);
    expect(res.map((r) => r.templateId).sort()).toEqual(['courtA', 'courtB']);
  });

  it('is a no-op when the target is the current end (or earlier — that is the trim path)', () => {
    expect(planCycleExtension([slot('s1', '2026-01-05T17:00:00.000Z')], '2026-01-05', TZ)).toEqual([]);
    expect(planCycleExtension([slot('s1', '2026-01-19T17:00:00.000Z')], '2026-01-05', TZ)).toEqual([]);
  });

  it('skips dates that already have a slot (safe to re-run / partial extension)', () => {
    // Already extended through Jan 12; extending to Jan 19 only adds Jan 19.
    const res = planCycleExtension(
      [slot('s1', '2026-01-05T17:00:00.000Z'), slot('s2', '2026-01-12T17:00:00.000Z')],
      '2026-01-19',
      TZ,
    );
    expect(res.map((r) => r.start_time)).toEqual(['2026-01-19T17:00:00.000Z']);
    expect(res[0].templateId).toBe('s2'); // projected from the final-week slot
  });

  it('throws on a malformed end date and on empty input returns []', () => {
    expect(() => planCycleExtension([slot('s1', '2026-01-05T17:00:00.000Z')], '26-01-2026', TZ)).toThrow(SlotPlanError);
    expect(planCycleExtension([], '2026-01-26', TZ)).toEqual([]);
  });

  it('caps runaway extensions (> 500 sessions throws)', () => {
    // ~11 years of weekly sessions ≫ 500.
    expect(() => planCycleExtension([slot('s1', '2026-01-05T17:00:00.000Z')], '2037-01-05', TZ)).toThrow(/500/);
  });
});
