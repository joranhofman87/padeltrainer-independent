import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// The user-facing half of the booking cutoff.
//
// The point Codex raised, and the thing these pins protect: this is the FIRST disabled state
// either list has ever had. A greyed-out card alone reads as "full" — a different situation with
// a different remedy (wait for a cancellation vs. ring the trainer). So every closed card must
// carry a NAMED reason, and must not be selectable.
//
// All of this is advisory. The server refuses independently using the database clock; these
// tests are about not inviting a player into a form that will be rejected.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      const o = (typeof opts === 'string' ? { defaultValue: opts } : opts) ?? {};
      const template = (o.defaultValue as string) ?? key;
      return String(template).replace(/\{\{(\w+)\}\}/g, (_m, n) => String(o[n] ?? ''));
    },
  }),
}));
vi.mock('@/lib/format', () => ({ formatDate: (d: string) => String(d).slice(0, 10) }));
vi.mock('@/lib/pricing', () => ({ formatPrice: (n: number) => `€${n}` }));

import { SlotList } from '@/components/booking/SlotList';
import { CycleBundleList } from '@/components/booking/CycleBundleList';

const slot = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  start_time: '2026-08-01T10:00:00.000Z',
  end_time: '2026-08-01T11:00:00.000Z',
  max_participants: 4,
  spotsLeft: 2,
  price_per_session: 20,
  ...over,
});

describe('SlotList — a slot inside the cutoff', () => {
  it('is NOT selectable', () => {
    const onSelect = vi.fn();
    render(
      <SlotList
        slots={[slot('s1')]}
        selectedSlotId={null}
        hasCycles={false}
        getSlotPrice={() => 20}
        onSelect={onSelect}
        getBookingClosedLabel={() => 'Booking closed 48 hours before start'}
      />,
    );
    fireEvent.click(screen.getByTestId('slot-card-s1'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('says WHY — not merely greyed out', () => {
    // the distinction that matters: "closed" is not "full", and the player can act on one
    render(
      <SlotList
        slots={[slot('s1')]}
        selectedSlotId={null}
        hasCycles={false}
        getSlotPrice={() => 20}
        onSelect={vi.fn()}
        getBookingClosedLabel={() => 'Booking closed 48 hours before start'}
      />,
    );
    expect(screen.getByTestId('slot-closed-s1')).toHaveTextContent('Booking closed 48 hours before start');
    expect(screen.getByTestId('slot-card-s1')).toHaveAttribute('aria-disabled', 'true');
  });

  it('leaves an OPEN slot fully selectable and unlabelled', () => {
    const onSelect = vi.fn();
    render(
      <SlotList
        slots={[slot('s1')]}
        selectedSlotId={null}
        hasCycles={false}
        getSlotPrice={() => 20}
        onSelect={onSelect}
        getBookingClosedLabel={() => null}
      />,
    );
    fireEvent.click(screen.getByTestId('slot-card-s1'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('slot-closed-s1')).toBeNull();
    expect(screen.getByTestId('slot-card-s1')).not.toHaveAttribute('aria-disabled');
  });

  it('closes only the late slots, leaving the rest bookable', () => {
    const onSelect = vi.fn();
    render(
      <SlotList
        slots={[slot('late'), slot('ok')]}
        selectedSlotId={null}
        hasCycles={false}
        getSlotPrice={() => 20}
        onSelect={onSelect}
        getBookingClosedLabel={(s) => (s.id === 'late' ? 'Booking closed 48 hours before start' : null)}
      />,
    );
    fireEvent.click(screen.getByTestId('slot-card-late'));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('slot-card-ok'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('shows a FULL slot as 0 spots left, not as empty', () => {
    // Pre-existing bug found by LOOKING at the rendered page: spotsLeft === 0 is falsy, so
    // `slot.spotsLeft || max` fell through and advertised a full session as completely open.
    // It matters here because "full" and "booking closed" must read differently — a player
    // seeing "4/4 spots left" on a full slot cannot tell either state apart from an open one.
    render(
      <SlotList
        slots={[slot('full', { spotsLeft: 0 })]}
        selectedSlotId={null}
        hasCycles={false}
        getSlotPrice={() => 20}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId('slot-card-full')).toHaveTextContent('0/4');
    expect(screen.getByTestId('slot-card-full')).not.toHaveTextContent('4/4');
  });

  it('with no label callback at all, behaves exactly as before', () => {
    // the prop is optional, so every existing caller keeps working untouched
    const onSelect = vi.fn();
    render(
      <SlotList slots={[slot('s1')]} selectedSlotId={null} hasCycles={false} getSlotPrice={() => 20} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByTestId('slot-card-s1'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('CycleBundleList — a series with one late session', () => {
  type Bundles = React.ComponentProps<typeof CycleBundleList>['bundles'];
  // Cast once, structurally — not `any`: this file should not spend the repo's suppression
  // budget, and the shape below is exactly what the component reads.
  const bundles = (id: string) => ([{
    cyclus_id: id,
    cyclus_name: 'Herfstreeks',
    slots: [slot('a'), slot('b')],
    totalPrice: 120,
    location: null,
  }] as unknown as Bundles);

  it('blocks the WHOLE series, and says why', () => {
    // matches the server: any one session inside its cutoff refuses the purchase, rather than
    // quietly selling the sessions that are still open
    const onSelect = vi.fn();
    render(
      <CycleBundleList
        bundles={bundles('c1')}
        selectedCyclusId={null}
        onSelect={onSelect}
        getBookingClosedLabel={() => 'A session in this series starts too soon to book'}
      />,
    );
    fireEvent.click(screen.getByTestId('cycle-card-c1'));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByTestId('cycle-closed-c1')).toHaveTextContent('starts too soon');
    expect(screen.getByTestId('cycle-card-c1')).toHaveAttribute('aria-disabled', 'true');
  });

  it('leaves an open series selectable', () => {
    const onSelect = vi.fn();
    render(
      <CycleBundleList bundles={bundles('c1')} selectedCyclusId={null} onSelect={onSelect} getBookingClosedLabel={() => null} />,
    );
    fireEvent.click(screen.getByTestId('cycle-card-c1'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('cycle-closed-c1')).toBeNull();
  });
});
