import { describe, it, expect } from 'vitest';
import { addMinutes, addWeeks } from 'date-fns';
import { expandWeeklySessions, insertAvailabilitySlots, setSlotVisibility } from '@/lib/slots';

/**
 * Characterization tests for the slot-creation facade. `expandWeeklySessions`
 * pins the exact recurrence math the three bulk dialogs each implemented inline
 * (week 0 = base start, +7 days per week, end = start + duration), and
 * `insertAvailabilitySlots` pins the write shape.
 */
describe('expandWeeklySessions', () => {
  const base = new Date('2026-07-01T18:00:00.000Z'); // a Wednesday 18:00

  it('week 0 is the base start; each later week is +7 days', () => {
    const out = expandWeeklySessions(base, 60, 4);
    expect(out).toHaveLength(4);
    expect(out[0].start.getTime()).toBe(base.getTime());
    expect(out[1].start.getTime()).toBe(addWeeks(base, 1).getTime());
    expect(out[2].start.getTime()).toBe(addWeeks(base, 2).getTime());
    expect(out[3].start.getTime()).toBe(addWeeks(base, 3).getTime());
  });

  it('end = start + durationMinutes for every session', () => {
    const out = expandWeeklySessions(base, 90, 3);
    for (const s of out) {
      expect(s.end.getTime()).toBe(addMinutes(s.start, 90).getTime());
    }
  });

  it('one week → a single session', () => {
    const out = expandWeeklySessions(base, 45, 1);
    expect(out).toHaveLength(1);
    expect(out[0].start.getTime()).toBe(base.getTime());
    expect(out[0].end.getTime()).toBe(addMinutes(base, 45).getTime());
  });

  it('zero / negative weeks → empty', () => {
    expect(expandWeeklySessions(base, 60, 0)).toEqual([]);
    expect(expandWeeklySessions(base, 60, -2)).toEqual([]);
  });

  it('does not mutate the base date', () => {
    const before = base.getTime();
    expandWeeklySessions(base, 60, 5);
    expect(base.getTime()).toBe(before);
  });
});

function makeClient(opts: { error?: unknown; data?: unknown } = {}) {
  const calls = { table: null as string | null, rows: null as unknown, select: null as string | null };
  const client = {
    from(table: string) {
      calls.table = table;
      return {
        insert(rows: unknown) {
          calls.rows = rows;
          const settle = () => Promise.resolve({ error: opts.error ?? null });
          return {
            select(cols: string) {
              calls.select = cols;
              return Promise.resolve({ data: opts.data ?? null, error: opts.error ?? null });
            },
            then(onF: (v: { error: unknown }) => unknown, onR?: (e: unknown) => unknown) {
              return settle().then(onF, onR);
            },
          };
        },
      };
    },
  };
  return { client: client as never, calls };
}

describe('insertAvailabilitySlots', () => {
  it('inserts the given rows into availability_slots', async () => {
    const { client, calls } = makeClient();
    const rows = [{ trainer_id: 't', start_time: 'a' }, { trainer_id: 't', start_time: 'b' }];
    const res = await insertAvailabilitySlots(rows, client);
    expect(calls.table).toBe('availability_slots');
    expect(calls.rows).toEqual(rows);
    expect(calls.select).toBeNull(); // no returning → plain insert
    expect(res.error).toBeNull();
  });

  it('returns inserted rows when `returning` is given', async () => {
    const inserted = [{ id: '1', cyclus_id: 'c' }];
    const { client, calls } = makeClient({ data: inserted });
    const res = await insertAvailabilitySlots([{ trainer_id: 't' }], client, 'id, cyclus_id');
    expect(calls.select).toBe('id, cyclus_id');
    expect(res.data).toEqual(inserted);
    expect(res.error).toBeNull();
  });

  it('surfaces the insert error', async () => {
    const err = { message: 'boom' };
    const res = await insertAvailabilitySlots([{ trainer_id: 't' }], makeClient({ error: err }).client);
    expect(res.error).toBe(err);
  });
});

/** from('availability_slots').update({is_public}).in('id', ids) stub. */
function makeVisibilityClient(opts: { error?: unknown } = {}) {
  const calls = { table: null as string | null, update: null as unknown, inCol: null as string | null, inIds: null as string[] | null };
  const client = {
    from(table: string) {
      calls.table = table;
      return {
        update(data: unknown) {
          calls.update = data;
          return {
            in(col: string, ids: string[]) {
              calls.inCol = col;
              calls.inIds = ids;
              return Promise.resolve({ error: opts.error ?? null });
            },
          };
        },
      };
    },
  };
  return { client: client as never, calls };
}

describe('setSlotVisibility', () => {
  it('a single id updates is_public filtered by .in(id, [x])', async () => {
    const { client, calls } = makeVisibilityClient();
    const res = await setSlotVisibility('s1', true, client);
    expect(calls.table).toBe('availability_slots');
    expect(calls.update).toEqual({ is_public: true });
    expect(calls.inIds).toEqual(['s1']); // 1-element .in === .eq
    expect(res.error).toBeNull();
  });

  it('an array updates is_public for all ids with the given value', async () => {
    const { client, calls } = makeVisibilityClient();
    await setSlotVisibility(['a', 'b'], false, client);
    expect(calls.update).toEqual({ is_public: false });
    expect(calls.inIds).toEqual(['a', 'b']);
  });

  it('empty array is a no-op (no write)', async () => {
    const { client, calls } = makeVisibilityClient();
    const res = await setSlotVisibility([], true, client);
    expect(res.error).toBeNull();
    expect(calls.table).toBeNull();
  });

  it('surfaces the update error', async () => {
    const err = { message: 'denied' };
    const res = await setSlotVisibility('s1', true, makeVisibilityClient({ error: err }).client);
    expect(res.error).toBe(err);
  });
});
