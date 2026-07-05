import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AvailabilityPicker } from './AvailabilityPicker';
import { usePublicAvailability } from '@/hooks/usePublicAvailability';
import type { PublicSlot } from '@/lib/publicAvailability';
import type { PublicDayGroup } from '@/lib/publicAvailability';

vi.mock('@/hooks/usePublicAvailability', () => ({ usePublicAvailability: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k, i18n: { language: 'nl-NL' } }),
}));

const mockHook = vi.mocked(usePublicAvailability);

const slot = (id: string, start: string, over: Partial<PublicSlot> = {}): PublicSlot => ({
  id,
  start_time: start,
  end_time: new Date(new Date(start).getTime() + 3_600_000).toISOString(),
  cyclus_id: null,
  cyclus_name: null,
  court_type: null,
  location_name: null,
  trainer_id: null,
  academy_profile_id: null,
  trainer_name: 'Coach Jansen',
  trainer_slug: 'coach',
  price_per_session: 20,
  total_price: null,
  extra_costs: [],
  max_participants: 4,
  allow_single_booking: true,
  spots_left: 3,
  split_payment: false,
  ...over,
});

function setup(slots: PublicSlot[], loading = false) {
  // The hook groups browser-local; the picker re-groups by owner tz. One group is enough here.
  const dayGroups: PublicDayGroup[] = slots.length ? [{ date: new Date(slots[0].start_time), slots }] : [];
  mockHook.mockReturnValue({ dayGroups, loading });
}

const AMS = 'Europe/Amsterdam';

describe('AvailabilityPicker', () => {
  beforeEach(() => mockHook.mockReset());

  it('renders the picker with the first day selected + owner-tz times', () => {
    setup([slot('a', '2026-06-01T09:00:00Z')]); // 11:00 Amsterdam (summer +2)
    render(<AvailabilityPicker owner={{ type: 'academy', academyId: 'a1' }} onSelect={vi.fn()} timezone={AMS} />);
    expect(screen.getByText('Boek een training')).toBeInTheDocument();
    expect(screen.getByText(/11:00/)).toBeInTheDocument(); // NOT 09:00 (browser/UTC) — combined "11:00–12:00" label
    expect(screen.getByText('Coach Jansen')).toBeInTheDocument();
  });

  it('selecting another day shows that day’s slots', () => {
    setup([slot('a', '2026-06-01T09:00:00Z'), slot('b', '2026-06-02T14:00:00Z')]);
    render(<AvailabilityPicker owner={{ type: 'trainer', trainerId: 't1' }} onSelect={vi.fn()} timezone={AMS} />);
    expect(screen.getByText(/11:00/)).toBeInTheDocument(); // day 1 default
    expect(screen.queryByText(/16:00/)).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('tab')[1]); // day 2
    expect(screen.getByText(/16:00/)).toBeInTheDocument(); // 14:00 UTC → 16:00 Ams
  });

  it('clicking a slot calls onSelect with it', () => {
    const onSelect = vi.fn();
    const s = slot('a', '2026-06-01T09:00:00Z');
    setup([s]);
    render(<AvailabilityPicker owner={{ type: 'academy', academyId: 'a1' }} onSelect={onSelect} timezone={AMS} />);
    fireEvent.click(screen.getByRole('listitem'));
    expect(onSelect).toHaveBeenCalledWith(s);
  });

  it('renders nothing when there is no availability', () => {
    setup([]);
    const { container } = render(
      <AvailabilityPicker owner={{ type: 'academy', academyId: 'a1' }} onSelect={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a skeleton card while loading', () => {
    setup([], true);
    const { container } = render(
      <AvailabilityPicker owner={{ type: 'academy', academyId: 'a1' }} onSelect={vi.fn()} />,
    );
    expect(container).not.toBeEmptyDOMElement();
    expect(screen.queryByText('Boek een training')).not.toBeInTheDocument();
  });
});
