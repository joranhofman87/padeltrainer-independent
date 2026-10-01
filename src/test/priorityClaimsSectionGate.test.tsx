import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * THE UI GATE ON THE SEND ACTIONS — `APPROVE_D7_RUNTIME_FINAL_CONVERGENCE_V1`, D3.
 *
 * The server refuses to enqueue an invitation whose cycle is not open, and refuses one whose
 * priority window has closed. A button offered in either state is a promise the system cannot
 * keep: before the enqueue refused, it wrote a row that could only ever be held, and stamped
 * `invited_at` so the claim read as handled.
 *
 * No database test can see this — the gate is render logic — and no realpg fixture reaches it.
 * These cases are the evidence for that half of the contract:
 *
 *   1. an OPEN cycle inside its window offers both send actions;
 *   2. a CLOSED cycle offers neither, while RELEASE survives (closing a round does not stop a
 *      manager letting a place go);
 *   3. a session naming a cycle that does not exist is NOT an open cycle — the same id-keyed rule
 *      the enqueue applies, because `availability_slots_cyclus_id_fkey` is NOT VALID and orphans
 *      exist;
 *   4. a deadline that cannot be READ fails CLOSED, rather than reading as "no deadline".
 */

const claimsMock = vi.fn();
const slotRow = vi.fn();

vi.mock('@/lib/priorityClaims', () => ({
  getPriorityClaimsForSlot: (...a: unknown[]) => claimsMock(...a),
  declineClaimAsManager: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      const vars = (typeof def === 'string' ? opts : def) ?? {};
      const template = typeof def === 'string'
        ? def
        : String((def as Record<string, unknown> | undefined)?.defaultValue ?? key);
      return template.replace(/\{\{(\w+)\}\}/g, (_m, n) => String(vars[n] ?? ''));
    },
  }),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => slotRow() }) }),
    }),
    functions: { invoke: vi.fn().mockResolvedValue({ data: { queued: 1 }, error: null }) },
  },
}));

import PriorityClaimsSection from '@/components/cycles/PriorityClaimsSection';

const openInAWeek = {
  data: {
    priority_window_ends_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    cyclus_id: 'cyc-1',
    cycles: { status: 'open' },
  },
  error: null,
};

beforeEach(() => {
  claimsMock.mockReset().mockResolvedValue([
    { id: 'c1', status: 'pending', profiles: { full_name: 'Ann', email: 'ann@example.test' }, guest_players: null },
  ]);
  slotRow.mockReset().mockResolvedValue(openInAWeek);
});

const renderSection = async () => {
  render(<PriorityClaimsSection slotId="slot-1" />);
  await waitFor(() => expect(claimsMock).toHaveBeenCalled());
};

describe('PriorityClaimsSection · the send actions are gated exactly as the server is', () => {
  it('an OPEN cycle inside its window offers both send actions', async () => {
    await renderSection();
    await waitFor(() => expect(screen.getByText('Invite')).toBeTruthy());
    expect(screen.getByText('Send invites')).toBeTruthy();
  });

  it('a CLOSED cycle offers neither — but Release survives', async () => {
    slotRow.mockResolvedValue({
      data: { ...openInAWeek.data, cycles: { status: 'closed' } }, error: null,
    });
    await renderSection();
    await waitFor(() => expect(screen.getByText('Release')).toBeTruthy());
    expect(screen.queryByText('Invite'), 'the enqueue would refuse this').toBeNull();
    expect(screen.queryByText('Send invites')).toBeNull();
  });

  it('a session naming a cycle that does not exist is not an open cycle', async () => {
    // status NULL with a non-null id: the orphan shape the NOT VALID foreign key leaves behind.
    slotRow.mockResolvedValue({
      data: { ...openInAWeek.data, cycles: null }, error: null,
    });
    await renderSection();
    await waitFor(() => expect(screen.getByText('Release')).toBeTruthy());
    expect(screen.queryByText('Invite'), 'an unestablishable cycle is not open').toBeNull();
  });

  it('a session with NO cycle at all is a different, legitimate shape', async () => {
    slotRow.mockResolvedValue({
      data: { ...openInAWeek.data, cyclus_id: null, cycles: null }, error: null,
    });
    await renderSection();
    await waitFor(() => expect(screen.getByText('Invite')).toBeTruthy());
  });

  it('a deadline that cannot be READ fails CLOSED', async () => {
    slotRow.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await renderSection();
    await waitFor(() => expect(screen.getByText('Release')).toBeTruthy());
    expect(screen.queryByText('Invite'), 'an unknown deadline is not an absent one').toBeNull();
    expect(screen.queryByText('Send invites')).toBeNull();
  });
});
