// @vitest-environment node
// Bulk booking-mode + targeted-price facades (mutation-boundary P1-b extraction).
//
// setTargetedCyclePrice's tests are the CHARACTERIZATION of the overview page's previous
// inline handler (written against those exact semantics before the code moved): 500-chunk
// slot writes, bare per-cycle price write, invoice resync always, empty-input no-op.
//
// setCycleBookingMode's tests pin the critique-driven rules: cycle-wide dedupe,
// direction-aware skip-booked (only when ENABLING per-seat), orphan skip for single_only,
// future-only scope, resilient partial failure.
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Call = {
  table: string;
  op: 'select' | 'update';
  payload?: Record<string, unknown>;
  filters: Record<string, unknown>;
};

const calls: Call[] = [];
const fixtures: {
  cycles: { id: string; settings: Record<string, unknown> | null }[];
  slotsByCyclus: Record<string, { id: string }[]>;
  occupiedSlotIds: string[];
  failUpdateForCyclus: string | null;
} = { cycles: [], slotsByCyclus: {}, occupiedSlotIds: [], failUpdateForCyclus: null };

function makeChain(table: string) {
  const state: Call = { table, op: 'select', filters: {} };
  const resolve = () => {
    calls.push(state);
    if (state.op === 'select') {
      if (table === 'cycles') return { data: fixtures.cycles, error: null };
      if (table === 'availability_slots') {
        return { data: fixtures.slotsByCyclus[String(state.filters['eq:cyclus_id'])] ?? [], error: null };
      }
      if (table === 'bookings') {
        const ids = (state.filters['in:slot_id'] as string[]) ?? [];
        return { data: ids.filter((id) => fixtures.occupiedSlotIds.includes(id)).map((id) => ({ slot_id: id })), error: null };
      }
      return { data: [], error: null };
    }
    // update
    const inIds = (state.filters['in:id'] as string[] | undefined) ?? [];
    const eqId = state.filters['eq:id'] as string | undefined;
    if (
      fixtures.failUpdateForCyclus &&
      table === 'availability_slots' &&
      inIds.some((id) => id.startsWith(fixtures.failUpdateForCyclus!))
    ) {
      return { data: null, error: { message: 'update blew up' } };
    }
    void eqId;
    return { data: null, error: null };
  };
  const chain: Record<string, unknown> = {
    select: (_cols: string) => chain,
    update: (payload: Record<string, unknown>) => {
      state.op = 'update';
      state.payload = payload;
      return chain;
    },
    eq: (k: string, v: unknown) => {
      state.filters[`eq:${k}`] = v;
      return chain;
    },
    gte: (k: string, v: unknown) => {
      state.filters[`gte:${k}`] = v;
      return chain;
    },
    in: (k: string, v: unknown) => {
      state.filters[`in:${k}`] = v;
      return chain;
    },
    or: (expr: string) => {
      state.filters['or'] = expr;
      return chain;
    },
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(res, rej),
  };
  return chain;
}

vi.mock('@/lib/supabaseClient', () => ({
  supabase: { from: (table: string) => makeChain(table) },
}));

const syncMock = vi.fn(async (...args: unknown[]) => {
  void args;
});
vi.mock('@/lib/invoiceSync', () => ({
  syncInvoicesAfterPriceChange: (...args: unknown[]) => syncMock(...args),
}));

import { applyBookingModeToFutureSlots, setCycleBookingMode, setTargetedCyclePrice } from '@/lib/cycleBookingMode';

const updates = (table: string) => calls.filter((c) => c.table === table && c.op === 'update');
const selects = (table: string) => calls.filter((c) => c.table === table && c.op === 'select');

beforeEach(() => {
  calls.length = 0;
  syncMock.mockClear();
  fixtures.cycles = [];
  fixtures.slotsByCyclus = {};
  fixtures.occupiedSlotIds = [];
  fixtures.failUpdateForCyclus = null;
});

describe('setCycleBookingMode', () => {
  it('single_only: merges settings (single ON, cyclus OFF) and flips only unbooked future slots', async () => {
    fixtures.cycles = [{ id: 'cy1', settings: { split_payment: true } }];
    fixtures.slotsByCyclus = { cy1: [{ id: 'cy1-s1' }, { id: 'cy1-s2' }, { id: 'cy1-s3' }] };
    fixtures.occupiedSlotIds = ['cy1-s2'];

    const res = await setCycleBookingMode([{ cyclusId: 'cy1', hasCycleRow: true, name: 'Ma 12:00' }], 'single_only');

    expect(res).toMatchObject({ succeeded: 1, failed: [], skippedBookedSlots: 1, skippedOrphans: 0 });
    // settings: existing keys preserved, both flags written
    const settingsWrite = updates('cycles')[0];
    expect(settingsWrite.payload).toEqual({
      settings: { split_payment: true, allow_single_booking: true, allow_cyclus_booking: false, whole_slot_booking: false },
    });
    // slots: the booked one excluded (phantom-seat guard), future-only select
    const slotWrite = updates('availability_slots')[0];
    expect(slotWrite.payload).toEqual({ allow_single_booking: true, whole_slot_booking: false });
    expect(slotWrite.filters['in:id']).toEqual(['cy1-s1', 'cy1-s3']);
    expect(selects('availability_slots')[0].filters['gte:start_time']).toBeDefined();
  });

  it('cyclus_only: flips BOOKED slots too (safe direction) and never queries bookings', async () => {
    fixtures.cycles = [{ id: 'cy1', settings: null }];
    fixtures.slotsByCyclus = { cy1: [{ id: 'cy1-s1' }, { id: 'cy1-s2' }] };
    fixtures.occupiedSlotIds = ['cy1-s1']; // must be ignored — disabling per-seat is safe

    const res = await setCycleBookingMode([{ cyclusId: 'cy1', hasCycleRow: true, name: 'Ma' }], 'cyclus_only');

    expect(res).toMatchObject({ succeeded: 1, skippedBookedSlots: 0 });
    expect(selects('bookings')).toHaveLength(0);
    expect(updates('availability_slots')[0].filters['in:id']).toEqual(['cy1-s1', 'cy1-s2']);
    expect(updates('cycles')[0].payload).toEqual({
      settings: { allow_single_booking: false, allow_cyclus_booking: true, whole_slot_booking: false },
    });
  });

  it('both: enables both flags, still skipping booked slots for the per-seat flip', async () => {
    fixtures.cycles = [{ id: 'cy1', settings: {} }];
    fixtures.slotsByCyclus = { cy1: [{ id: 'cy1-s1' }, { id: 'cy1-s2' }] };
    fixtures.occupiedSlotIds = ['cy1-s1'];

    const res = await setCycleBookingMode([{ cyclusId: 'cy1', hasCycleRow: true, name: 'Ma' }], 'both');

    expect(res.skippedBookedSlots).toBe(1);
    expect(updates('cycles')[0].payload).toEqual({
      settings: { allow_single_booking: true, allow_cyclus_booking: true, whole_slot_booking: false },
    });
    expect(updates('availability_slots')[0].filters['in:id']).toEqual(['cy1-s2']);
  });

  it('orphan + single_only is SKIPPED whole (the series checkout cannot be blocked without a cycles row)', async () => {
    fixtures.slotsByCyclus = { orphan1: [{ id: 'orphan1-s1' }] };

    const res = await setCycleBookingMode([{ cyclusId: 'orphan1', hasCycleRow: false, name: 'Wees' }], 'single_only');

    expect(res).toMatchObject({ succeeded: 0, skippedOrphans: 1 });
    expect(updates('cycles')).toHaveLength(0);
    expect(updates('availability_slots')).toHaveLength(0);
  });

  it('orphan + cyclus_only: flips the slots, writes no settings', async () => {
    fixtures.slotsByCyclus = { orphan1: [{ id: 'orphan1-s1' }] };

    const res = await setCycleBookingMode([{ cyclusId: 'orphan1', hasCycleRow: false, name: 'Wees' }], 'cyclus_only');

    expect(res.succeeded).toBe(1);
    expect(updates('cycles')).toHaveLength(0);
    expect(updates('availability_slots')[0].payload).toEqual({ allow_single_booking: false, whole_slot_booking: false });
  });

  it('dedupes multi-trainer groups of one cycle into ONE cycle-wide application', async () => {
    fixtures.cycles = [{ id: 'cy1', settings: {} }];
    fixtures.slotsByCyclus = { cy1: [{ id: 'cy1-s1' }] };

    const res = await setCycleBookingMode(
      [
        { cyclusId: 'cy1', hasCycleRow: true, name: 'Trainer A' },
        { cyclusId: 'cy1', hasCycleRow: true, name: 'Trainer B' },
      ],
      'both',
    );

    expect(res.succeeded).toBe(1);
    expect(updates('cycles')).toHaveLength(1);
  });

  it('one cycle failing never aborts the rest (players-bulk resilience)', async () => {
    fixtures.cycles = [
      { id: 'cy1', settings: {} },
      { id: 'cy2', settings: {} },
    ];
    fixtures.slotsByCyclus = { cy1: [{ id: 'cy1-s1' }], cy2: [{ id: 'cy2-s1' }] };
    fixtures.failUpdateForCyclus = 'cy1';

    const res = await setCycleBookingMode(
      [
        { cyclusId: 'cy1', hasCycleRow: true, name: 'Kapot' },
        { cyclusId: 'cy2', hasCycleRow: true, name: 'Heel' },
      ],
      'cyclus_only',
    );

    expect(res.succeeded).toBe(1);
    expect(res.failed).toEqual([{ name: 'Kapot', reason: 'update blew up' }]);
  });
});

describe('applyBookingModeToFutureSlots (the slot half — shared with CycleForm saves)', () => {
  it('enable: skips actively-booked future slots, flips the rest, reports both counts', async () => {
    fixtures.slotsByCyclus = { cy1: [{ id: 'cy1-s1' }, { id: 'cy1-s2' }, { id: 'cy1-s3' }] };
    fixtures.occupiedSlotIds = ['cy1-s3'];

    const res = await applyBookingModeToFutureSlots('cy1', { allowSingle: true, wholeSlot: false });

    expect(res).toEqual({ flipped: 2, skippedBooked: 1 });
    const write = updates('availability_slots')[0];
    expect(write.payload).toEqual({ allow_single_booking: true, whole_slot_booking: false });
    expect(write.filters['in:id']).toEqual(['cy1-s1', 'cy1-s2']);
    expect(selects('availability_slots')[0].filters['gte:start_time']).toBeDefined();
  });

  it('disable: flips booked slots too and never queries bookings (safe direction)', async () => {
    fixtures.slotsByCyclus = { cy1: [{ id: 'cy1-s1' }, { id: 'cy1-s2' }] };
    fixtures.occupiedSlotIds = ['cy1-s1'];

    const res = await applyBookingModeToFutureSlots('cy1', { allowSingle: false, wholeSlot: false });

    expect(res).toEqual({ flipped: 2, skippedBooked: 0 });
    expect(selects('bookings')).toHaveLength(0);
    expect(updates('availability_slots')[0].filters['in:id']).toEqual(['cy1-s1', 'cy1-s2']);
  });

  it('no future slots → no writes, zero counts', async () => {
    fixtures.slotsByCyclus = { cy1: [] };
    const res = await applyBookingModeToFutureSlots('cy1', { allowSingle: true, wholeSlot: false });
    expect(res).toEqual({ flipped: 0, skippedBooked: 0 });
    expect(updates('availability_slots')).toHaveLength(0);
  });
});

describe('single_only_whole_slot (whole court per booking)', () => {
  it('writes settings {single:false, cyclus:false, whole_slot:true} and stamps both slot flags', async () => {
    fixtures.cycles = [{ id: 'cy1', settings: { split_payment: false } }];
    fixtures.slotsByCyclus = { cy1: [{ id: 'cy1-s1' }, { id: 'cy1-s2' }] };
    fixtures.occupiedSlotIds = ['cy1-s1']; // must be IGNORED: allow_single stays false (safe direction)

    const res = await setCycleBookingMode(
      [{ cyclusId: 'cy1', hasCycleRow: true, name: 'Zomertraining' }],
      'single_only_whole_slot',
    );

    expect(res).toMatchObject({ succeeded: 1, skippedBookedSlots: 0 });
    expect(selects('bookings')).toHaveLength(0); // never treated as per-seat enable
    expect(updates('cycles')[0].payload).toEqual({
      settings: { split_payment: false, allow_single_booking: false, allow_cyclus_booking: false, whole_slot_booking: true },
    });
    const slotWrite = updates('availability_slots')[0];
    expect(slotWrite.payload).toEqual({ allow_single_booking: false, whole_slot_booking: true });
    expect(slotWrite.filters['in:id']).toEqual(['cy1-s1', 'cy1-s2']);
  });

  it('orphan groups are skipped for the whole-slot mode too (series checkout cannot be blocked)', async () => {
    fixtures.slotsByCyclus = { orphan1: [{ id: 'orphan1-s1' }] };
    const res = await setCycleBookingMode(
      [{ cyclusId: 'orphan1', hasCycleRow: false, name: 'Wees' }],
      'single_only_whole_slot',
    );
    expect(res).toMatchObject({ succeeded: 0, skippedOrphans: 1 });
    expect(updates('availability_slots')).toHaveLength(0);
  });
});

describe('setTargetedCyclePrice (characterization of the previous inline page handler)', () => {
  it('writes slots in 500-chunks, bare per-cycle price, then ALWAYS resyncs invoices', async () => {
    const slotIds = Array.from({ length: 501 }, (_, i) => `s${i}`);

    const res = await setTargetedCyclePrice(slotIds, ['cy1', 'cy2'], 19.13);

    expect(res.updatedSlots).toBe(501);
    const slotWrites = updates('availability_slots');
    expect(slotWrites).toHaveLength(2); // 500 + 1
    expect((slotWrites[0].filters['in:id'] as string[]).length).toBe(500);
    expect(slotWrites[0].payload).toEqual({ price_per_session: 19.13 });
    // bare price write per real cycle — nothing else touched (no updated_at, no settings)
    const cycleWrites = updates('cycles');
    expect(cycleWrites).toHaveLength(2);
    expect(cycleWrites[0].payload).toEqual({ price_per_session: 19.13 });
    // invoice resync bundled, exactly once, with the full slot set (default statuses)
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncMock).toHaveBeenCalledWith(slotIds);
  });

  it('empty slotIds → no writes at all, no resync (the page early-return)', async () => {
    const res = await setTargetedCyclePrice([], ['cy1'], 10);
    expect(res.updatedSlots).toBe(0);
    expect(calls).toHaveLength(0);
    expect(syncMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deriveCycleBookingMode — the read-side mirror of the write mapping above.
// ---------------------------------------------------------------------------
import { deriveCycleBookingMode } from '@/lib/cycleBookingMode';

describe('deriveCycleBookingMode', () => {
  it('round-trips all four write modes', () => {
    expect(deriveCycleBookingMode({ allowSingle: true, wholeSlot: false, allowCyclus: true })).toBe('both');
    expect(deriveCycleBookingMode({ allowSingle: true, wholeSlot: false, allowCyclus: false })).toBe('single_only');
    expect(deriveCycleBookingMode({ allowSingle: false, wholeSlot: true, allowCyclus: false })).toBe('single_only_whole_slot');
    expect(deriveCycleBookingMode({ allowSingle: false, wholeSlot: false, allowCyclus: true })).toBe('cyclus_only');
  });

  it("classifies the fully-closed combination as 'none'", () => {
    expect(deriveCycleBookingMode({ allowSingle: false, wholeSlot: false, allowCyclus: false })).toBe('none');
  });

  it('allowSingle wins over a stray wholeSlot flag (per-seat sale is what players get)', () => {
    expect(deriveCycleBookingMode({ allowSingle: true, wholeSlot: true, allowCyclus: false })).toBe('single_only');
  });
});
