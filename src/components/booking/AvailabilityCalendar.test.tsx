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
  academy_profile_id: null,
  trainer_name: 'Coach Bo',
  trainer_slug: 'coach-bo',
  price_per_session: 20,
  total_price: null,
  extra_costs: [],
  max_participants: 4,
  allow_single_booking: true,
  whole_slot_booking: false,
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

  it('pre-selects the first available day and books its slot row inline (two-pane, no sheet)', async () => {
    useAvailabilityMock.mockReturnValue({ dayGroups: [{ dateKey: '2026-09-15', label: 'x', slots: [slot] }], loading: false });
    const onSelect = vi.fn();
    render(
      <AvailabilityCalendar owner={{ type: 'academy', academyId: 'a1' }} onSelect={onSelect} timezone="Europe/Amsterdam" />,
    );

    // The first available day is auto-selected → its slot row shows in the day panel (no sheet to open).
    const row = await screen.findByRole('listitem');
    expect(row.textContent).toContain('Coach Bo');

    // Tapping the row delegates to the booking flow.
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].id).toBe('slot-1');
  });
});
