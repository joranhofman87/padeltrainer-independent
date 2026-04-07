import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrParams?: string | Record<string, unknown>) => {
      if (typeof fallbackOrParams === 'string') return fallbackOrParams;
      const map: Record<string, string> = {
        'intake.fullName': 'Full Name',
        'intake.email': 'Email',
        'intake.phone': 'Phone',
        'intake.submit': 'Submit Application',
        'intake.preferredDays': 'Preferred Days',
        'intake.notes': 'Notes',
        'application.form.nameMin': 'Name required',
        'application.form.emailInvalid': 'Invalid email',
        'application.form.birthDateRequired': 'Birth date required',
        'application.form.lessonTypeRequired': 'Select lesson type',
        'application.form.experienceRequired': 'Experience required',
        'application.form.consentRequired': 'Consent required',
        'application.form.noAvailability': 'Select availability',
      };
      return map[key] || key;
    },
    i18n: { language: 'en' },
  }),
}));

const mockChain = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  order: vi.fn().mockResolvedValue({ data: [{ code: 'knltb', name: 'KNLTB' }], error: null }),
  single: vi.fn().mockResolvedValue({ data: null, error: null }),
  limit: vi.fn().mockResolvedValue({ data: [], error: null }),
};

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: () => mockChain,
  },
}));

vi.mock('@/lib/cycles', () => ({
  submitIntakeRequest: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('@/lib/email', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('@/lib/terms', () => ({
  getTermsForCycleOwner: vi.fn().mockResolvedValue({ terms: null }),
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
  settings: { default_duration_minutes: 60, available_duration_minutes: [60] },
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
    const submitBtn = screen.getByRole('button', { name: /submit|aanmeld|inschrijv/i });
    expect(submitBtn).toBeInTheDocument();
  });
});
