import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the bookings query chain: from('bookings').select('slot_id').in('slot_id', …).in('status', …)
const statusInMock = vi.fn();
const slotInMock = vi.fn(() => ({ in: statusInMock }));
const selectMock = vi.fn(() => ({ in: slotInMock }));
const fromMock = vi.fn(() => ({ select: selectMock }));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: { from: (...args: unknown[]) => fromMock(...args) },
}));

import { findBookedSlotIds, filterDeletableSlotIds } from '@/lib/slotDeleteGuard';

describe('slotDeleteGuard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty and does not query for empty input', async () => {
    expect(await findBookedSlotIds([])).toEqual(new Set());
    expect(await filterDeletableSlotIds([])).toEqual([]);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('finds the slot ids that have an active booking', async () => {
    statusInMock.mockResolvedValueOnce({ data: [{ slot_id: 'b' }], error: null });
    const booked = await findBookedSlotIds(['a', 'b']);
    expect(booked).toEqual(new Set(['b']));
    expect(fromMock).toHaveBeenCalledWith('bookings');
    // Filters to the canonical occupying statuses (incl. pending_approval).
    expect(statusInMock).toHaveBeenCalledWith('status', ['confirmed', 'pending', 'pending_approval']);
  });

  it('excludes booked slots from the deletable set', async () => {
    statusInMock.mockResolvedValueOnce({ data: [{ slot_id: 'b' }], error: null });
    expect(await filterDeletableSlotIds(['a', 'b', 'c'])).toEqual(['a', 'c']);
  });

  it('throws on a query error rather than silently allowing a delete', async () => {
    statusInMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await expect(findBookedSlotIds(['a'])).rejects.toBeTruthy();
  });
});
