import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const map: Record<string, string> = {
        'intake.fullName': 'Full Name',
        'intake.email': 'Email',
        'intake.phone': 'Phone',
        'intake.lessonType': 'Lesson Type',
        'intake.submit': 'Submit Application',
        'intake.submitting': 'Submitting...',
        'intake.preferredDays': 'Preferred Days',
        'intake.notes': 'Notes',
        'intake.rating': 'Rating',
      };
      return map[key] || fallback || key;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null, error: null }),
          limit: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }),
  },
}));

vi.mock('@/lib/cycles', () => ({
  submitIntakeRequest: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('@/lib/email', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('@/lib/terms', () => ({
  getTermsForCycleOwner: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import CycleApplicationForm from './CycleApplicationForm';

const baseCycle = {
  id: 'cycle-1',
  name: 'Spring Training',
  description: 'Weekly padel',
  type: 'open_registration',
  status: 'published',
  owner_id: 'owner-1',
  owner_type: 'trainer',
  start_date: '2026-05-01',
  end_date: '2026-06-30',
  enrollment_deadline: null,
  location_id: null,
  total_price: 200,
  price_per_session: 25,
  price_table: null,
  terms: null,
  currency: 'EUR',
  settings: null,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
};

const renderForm = (props = {}) =>
  render(
    <CycleApplicationForm
      cycle={baseCycle as any}
      playerId="player-1"
      playerUserId="user-1"
      playerName="Jane Player"
      playerEmail="jane@test.com"
      playerPhone="+31612345678"
      playerRating={5.5}
      playerRatingSystem="knltb"
      {...props}
    />
  );

describe('CycleApplicationForm', () => {
  it('renders player name pre-filled', () => {
    renderForm();
    expect(screen.getByDisplayValue('Jane Player')).toBeInTheDocument();
  });

  it('renders player email pre-filled', () => {
    renderForm();
    expect(screen.getByDisplayValue('jane@test.com')).toBeInTheDocument();
  });

  it('renders player phone pre-filled', () => {
    renderForm();
    expect(screen.getByDisplayValue('+31612345678')).toBeInTheDocument();
  });

  it('renders a submit button', () => {
    renderForm();
    const submitBtn = screen.getByRole('button', { name: /submit/i });
    expect(submitBtn).toBeInTheDocument();
  });

  it('renders the preferred days section', () => {
    renderForm();
    expect(screen.getByText('Preferred Days')).toBeInTheDocument();
  });
});
