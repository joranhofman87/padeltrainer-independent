import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AvailabilityCalendar } from './AvailabilityCalendar';
import type { PublicSlot } from '@/lib/publicAvailability';

const useAvailabilityMock = vi.fn();
vi.mock('@/hooks/usePublicAvailability', () => ({
  usePublicAvailability: () => useAvailabilityMock(),
}));

// Return inline defaults, interpolating {{amount}}-style vars.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, dflt?: string, opts?: Record<string, unknown>) => {
      const base = typeof dflt === 'string' ? dflt : _k;
      return opts ? base.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(opts[k] ?? '')) : base;
    },
    i18n: { language: 'nl' },
  }),
}));

const slot: PublicSlot = {
  id: 'slot-1',
  start_time: '2026-09-15T16:00:00Z',
  end_time: '2026-09-15T17:00:00Z',
  cyclus_id: null,
  cyclus_name: null,
  court_type: null,
  location_name: 'Court 1',
  trainer_id: 'tr-1',
  trainer_name: 'Coach Bo',
  trainer_slug: 'coach-bo',
  price_per_session: 20,
  total_price: null,
  extra_costs: [],
  max_participants: 4,
  allow_single_booking: true,
  spots_left: 3,
  split_payment: false,
};

beforeEach(() => useAvailabilityMock.mockReset());

describe('AvailabilityCalendar', () => {
  it('renders nothing when there is no availability', () => {
    useAvailabilityMock.mockReturnValue({ dayGroups: [], loading: false });
    const { container } = render(
      <AvailabilityCalendar owner={{ type: 'academy', academyId: 'a1' }} onSelect={() => {}} timezone="Europe/Amsterdam" />,
    );
    expect(container.textContent).toBe('');
  });

  it('shows the month grid, and a day tap opens a sheet whose slot row books', () => {
    useAvailabilityMock.mockReturnValue({ dayGroups: [{ dateKey: '2026-09-15', label: 'x', slots: [slot] }], loading: false });
    const onSelect = vi.fn();
    render(
      <AvailabilityCalendar owner={{ type: 'academy', academyId: 'a1' }} onSelect={onSelect} timezone="Europe/Amsterdam" />,
    );

    // Month grid rendered (the slot day cell carries a "session" count).
    const dayCell = screen.getAllByRole('button').find((b) => /session/i.test(b.textContent || ''));
    expect(dayCell).toBeTruthy();

    // Tapping the day opens the day sheet with the slot as a row.
    fireEvent.click(dayCell!);
    const row = screen.getByRole('listitem');
    expect(row.textContent).toContain('Coach Bo');

    // Tapping the row delegates to the booking flow.
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].id).toBe('slot-1');
  });
});
