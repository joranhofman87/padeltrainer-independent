import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const navigateMock = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    profile: { id: 'profile-1', full_name: 'Jan Player', skill_rating: 5 },
    loading: false,
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: [], isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));

vi.mock('@/components/player/RatingHistoryChart', () => ({
  RatingHistoryChart: () => null,
}));

vi.mock('@/components/waitingList', () => ({
  MyWaitingListEntries: () => null,
}));

vi.mock('@/components/dashboard/PendingAttendanceCard', () => ({
  PendingAttendanceCard: () => null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const map: Record<string, string> = {
        'dashboard.welcome': 'Welcome back, Jan!',
        'dashboard.subtitle': 'Your padel hub',
        'dashboard.quickActions.myBookings.title': 'My trainings',
        'dashboard.viewSchedule': 'Upcoming and past trainings',
        'dashboard.viewSchedule': 'View schedule',
        'nav.invoices': 'Invoices',
        'invoices.description': 'View invoices',
        'dashboard.quickActions.findTrainers.title': 'Find Trainers',
        'dashboard.browseAvailableTrainers': 'Browse',
        'dashboard.myProfile.title': 'My Profile',
        'dashboard.myProfile.description': 'Edit profile',
        'dashboard.upcomingBookings': 'Upcoming trainings',
        'dashboard.viewAll': 'View all',
        'dashboard.noUpcomingBookings': 'None',
        'dashboard.followedTrainers': 'Following',
        'dashboard.allTrainers': 'All',
        'dashboard.notFollowingYet': 'None yet',
        'dashboard.openSlots': 'Open slots',
        'dashboard.browse': 'Browse',
        'dashboard.openSlotsDescription': 'Desc',
        'dashboard.noOpenSlots': 'None',
        'dashboard.myClubs': 'Clubs',
        'dashboard.allClubs': 'All',
        'dashboard.noClubsYet': 'None',
      };
      return map[key] ?? fallback ?? key;
    },
  }),
}));

import PlayerDashboard from './PlayerDashboard';

describe('PlayerDashboard', () => {
  beforeEach(() => {
    navigateMock.mockClear();
  });

  it('renders dashboard with bookings and invoices shortcuts', () => {
    render(
      <MemoryRouter>
        <PlayerDashboard />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('page-player-dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-shortcut-bookings')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-shortcut-invoices')).toBeInTheDocument();
  });
});
