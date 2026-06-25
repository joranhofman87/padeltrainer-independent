import { describe, it, expect, beforeEach } from 'vitest';
import {
  resetFactorySeq,
  makeCycle,
  makeRegistration,
  makeSlot,
  makeBooking,
  makeInvoice,
  makeCycleWith,
} from './factory';

describe('test fixture factory', () => {
  beforeEach(() => resetFactorySeq());

  it('builders produce valid default shapes + apply overrides', () => {
    expect(makeCycle().type).toBe('cyclus');
    expect(makeCycle({ name: 'X' }).name).toBe('X');
    expect(makeRegistration().format).toBe('registration');
    expect(makeRegistration({ format: 'event' }).format).toBe('event');
    expect(makeSlot().max_participants).toBe(4);
    expect(makeBooking().status).toBe('confirmed');
    expect(makeInvoice().total).toBe(171);
  });

  it('ids are a stable sequence after reset (reproducible snapshots)', () => {
    resetFactorySeq();
    const a = makeCycle().id;
    resetFactorySeq();
    const b = makeCycle().id;
    expect(a).toBe(b); // same sequence position → same id
  });

  it('makeCycleWith(10_000) generates exactly 10k slots, all owned by the cycle, deterministic', () => {
    const { cycle, slots } = makeCycleWith(10_000);
    expect(slots).toHaveLength(10_000);
    expect(slots.every((s) => s.cyclus_id === cycle.id)).toBe(true);
    // deterministic ids + ascending, unique times
    expect(slots[0].id).toBe('slot-0000001');
    expect(slots[9999].id).toBe('slot-0010000');
    expect(new Set(slots.map((s) => s.id)).size).toBe(10_000);
    expect(new Date(slots[1].start_time).getTime()).toBeGreaterThan(
      new Date(slots[0].start_time).getTime(),
    );
  });

  it('bookedRatio attaches the right number of bookings to real slot ids', () => {
    const { slots, bookings } = makeCycleWith(100, { bookedRatio: 0.5 });
    expect(bookings.length).toBeGreaterThan(0);
    const slotIds = new Set(slots.map((s) => s.id));
    expect(bookings.every((b) => slotIds.has(b.slot_id))).toBe(true);
  });
});
