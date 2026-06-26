import { describe, it, expect } from 'vitest';
import { buildCycleEditPatch, slotEditBaselineFromSlot, type CycleEditBaseline } from '@/lib/cycleEditPatch';
import type { SlotEditFormSlot, SlotEditFormValues } from '@/components/slots/SlotEditForm';

const baseline: CycleEditBaseline = {
  startTime: '18:00',
  duration: 60,
  trainerId: 't1',
  locationId: 'loc1',
  maxParticipants: 4,
  ratingSystem: 'knltb',
  minRating: null,
  maxRating: null,
  cyclusName: 'Zomer',
  isMarkedFull: false,
};

// A full SlotEditFormValues equal to the baseline; override only what a test changes.
function mkValues(over: Partial<SlotEditFormValues> = {}): SlotEditFormValues {
  return {
    date: '2099-07-06',
    startTime: baseline.startTime,
    duration: baseline.duration,
    trainerId: baseline.trainerId,
    locationId: baseline.locationId,
    maxParticipants: baseline.maxParticipants,
    ratingSystem: baseline.ratingSystem,
    minRating: baseline.minRating,
    maxRating: baseline.maxRating,
    cyclusName: baseline.cyclusName,
    isMarkedFull: baseline.isMarkedFull,
    pricePerSession: '',
    totalPrice: '',
    splitPayment: false,
    pricesIncludeVat: true,
    extraCosts: [],
    ...over,
  };
}

describe('buildCycleEditPatch — only changed fields, time fields travel together', () => {
  it('no changes → empty patch', () => {
    expect(buildCycleEditPatch(mkValues(), baseline)).toEqual({});
  });

  it('start-time change → shift + duration together (both, even though duration is unchanged)', () => {
    expect(buildCycleEditPatch(mkValues({ startTime: '19:00' }), baseline)).toEqual({
      startShiftMinutes: 60,
      durationMinutes: 60,
    });
  });

  it('duration-only change → pure resize (startShiftMinutes 0)', () => {
    expect(buildCycleEditPatch(mkValues({ duration: 90 }), baseline)).toEqual({
      startShiftMinutes: 0,
      durationMinutes: 90,
    });
  });

  it('earlier start → negative shift', () => {
    expect(buildCycleEditPatch(mkValues({ startTime: '17:30' }), baseline)).toEqual({
      startShiftMinutes: -30,
      durationMinutes: 60,
    });
  });

  it('capacity change → maxParticipants only (no time fields)', () => {
    expect(buildCycleEditPatch(mkValues({ maxParticipants: 6 }), baseline)).toEqual({ maxParticipants: 6 });
  });

  it('trainer change → trainerId; clearing the trainer is a no-op (not sent)', () => {
    expect(buildCycleEditPatch(mkValues({ trainerId: 't2' }), baseline)).toEqual({ trainerId: 't2' });
    expect(buildCycleEditPatch(mkValues({ trainerId: '' }), baseline)).toEqual({});
  });

  it('location: clearing → null; setting → uuid', () => {
    expect(buildCycleEditPatch(mkValues({ locationId: 'none' }), baseline)).toEqual({ locationId: null });
    expect(buildCycleEditPatch(mkValues({ locationId: 'loc2' }), baseline)).toEqual({ locationId: 'loc2' });
  });

  it('mark private → isPublic false', () => {
    expect(buildCycleEditPatch(mkValues({ isMarkedFull: true }), baseline)).toEqual({ isPublic: false });
  });

  it('rating + cyclusName changes', () => {
    expect(buildCycleEditPatch(mkValues({ minRating: 3, maxRating: 5, cyclusName: 'Herfst' }), baseline)).toEqual({
      minRating: 3,
      maxRating: 5,
      cyclusName: 'Herfst',
    });
  });

  it('combined change set', () => {
    expect(
      buildCycleEditPatch(mkValues({ startTime: '19:30', maxParticipants: 6, cyclusName: 'Herfst' }), baseline),
    ).toEqual({ startShiftMinutes: 90, durationMinutes: 60, maxParticipants: 6, cyclusName: 'Herfst' });
  });
});

describe('slotEditBaselineFromSlot — mirrors SlotEditForm init (TZ-safe fields)', () => {
  const slot: SlotEditFormSlot = {
    start_time: '2099-07-06T18:00:00Z',
    end_time: '2099-07-06T19:00:00Z', // 60 min, TZ-independent
    trainer_id: 't1',
    location_id: 'loc1',
    max_participants: 4,
    rating_system: 'knltb',
    min_rating: null,
    max_rating: null,
    cyclus_id: 'cy1',
    cyclus_name: 'Zomer',
    is_public: true,
    price_per_session: 25,
    total_price: null,
    split_payment: false,
    prices_include_vat: true,
    extra_costs: [],
  };

  it('derives duration / trainer / location / capacity / public / name', () => {
    const b = slotEditBaselineFromSlot(slot);
    expect(b.duration).toBe(60);
    expect(b.trainerId).toBe('t1');
    expect(b.locationId).toBe('loc1');
    expect(b.maxParticipants).toBe(4);
    expect(b.isMarkedFull).toBe(false); // !is_public
    expect(b.cyclusName).toBe('Zomer');
    expect(b.ratingSystem).toBe('knltb');
  });

  it('null location → "none"; null name → ""', () => {
    const b = slotEditBaselineFromSlot({ ...slot, location_id: null, cyclus_name: null, is_public: false });
    expect(b.locationId).toBe('none');
    expect(b.cyclusName).toBe('');
    expect(b.isMarkedFull).toBe(true);
  });
});
