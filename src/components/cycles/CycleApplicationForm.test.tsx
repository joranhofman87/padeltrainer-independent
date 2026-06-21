import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';

// Polyfill ResizeObserver for radix-ui
beforeAll(() => {
  (window as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrParams?: string | Record<string, unknown>) => {
      if (typeof fallbackOrParams === 'string') return fallbackOrParams;
      const map: Record<string, string> = {
        'application.form.firstName': 'First name',
        'application.form.lastName': 'Last name',
        'application.form.firstNameMin': 'First name required',
        'application.form.lastNameMin': 'Last name required',
        'application.form.nameMin': 'Name required',
        'application.form.emailInvalid': 'Invalid email',
        'application.form.birthDateRequired': 'Birth date required',
        'application.form.lessonTypeRequired': 'Select lesson type',
        'application.form.experienceRequired': 'Experience required',
        'application.form.consentRequired': 'Consent required',
        'application.form.noAvailability': 'Select availability',
        'application.form.phoneOptional': 'optional',
        'application.form.validation.phoneInvalid': 'Please enter a valid Dutch phone number',
        'application.form.validation.phoneRequired': 'Phone number is required',
        'application.form.personalInfo': 'Personal Information',
        'application.form.email': 'Email',
        'application.form.phone': 'Phone',
        'application.form.birthDate': 'Date of birth',
        'application.form.rating': 'Current Rating',
        'application.form.lessonType': 'Lesson Type',
        'application.form.availabilityLabel': 'Availability',
        'application.form.consent': 'Consent',
        'application.form.notes': 'Experience',
        'application.form.submit': 'Submit Application',
        'application.form.lessonTypes.group4': 'Group (4 players)',
        'application.form.preferredDuration': 'Preferred Duration',
        'application.form.sessionsPerWeek': 'Sessions per week',
        'application.form.timesPerWeek': 'per week',
        'application.form.preferredTrainer': 'Preferred Trainer (optional)',
        'application.form.noPreference': 'No preference',
        'application.form.location': 'Preferred Location',
        'application.form.availability': 'Your Availability',
        'application.form.availabilityHelp': 'Select availability',
        'application.form.additional': 'More information',
        'application.form.notesPlaceholder': 'Experience placeholder',
        'application.form.ratingLabel': 'Current Rating',
        'application.form.ratingSystem': 'Rating System',
        'application.form.preferences': 'Training Preferences',
        'application.form.days.monday': 'Monday',
        'application.form.days.tuesday': 'Tuesday',
        'application.form.days.wednesday': 'Wednesday',
        'application.form.days.thursday': 'Thursday',
        'application.form.days.friday': 'Friday',
        'application.form.days.saturday': 'Saturday',
        'application.form.days.sunday': 'Sunday',
        'application.form.startTime': 'From',
        'application.form.endTime': 'To',
        'application.form.addTimeBlock': 'Add another time',
        'application.form.availableRange': 'Available',
        'application.form.sessionsPerWeekHelp': 'Sessions help',
        'application.form.groupNotes': 'Group notes',
        'application.form.groupNotesPlaceholder': 'Group notes placeholder',
        'application.title': 'Apply for Training',
        'application.subtitle': 'Submit your application',
        'common:cancel': 'Cancel',
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
  it('renders first and last name pre-filled from player name', () => {
    renderForm();
    expect(screen.getByDisplayValue('Jane')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Player')).toBeInTheDocument();
  });

  it('prefills structured profile names over legacy full_name', () => {
    render(
      <CycleApplicationForm
        cycle={baseCycle as any}
        playerId="player-1"
        playerUserId="user-1"
        playerName="Wrong Legacy"
        playerFirstName="Alex"
        playerLastName="Morgan"
        playerEmail="alex@test.com"
      />
    );
    expect(screen.getByDisplayValue('Alex')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Morgan')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Wrong Legacy')).not.toBeInTheDocument();
  });

  it('renders first and last name fields side by side on larger viewports', () => {
    renderForm();
    const firstInput = screen.getByDisplayValue('Jane');
    const grid = firstInput.closest('.grid');
    expect(grid).toHaveClass('sm:grid-cols-2');
  });

  it('renders player email pre-filled', () => {
    renderForm();
    expect(screen.getByDisplayValue('jane@test.com')).toBeInTheDocument();
  });

  it('renders player phone pre-filled', () => {
    renderForm();
    expect(screen.getByDisplayValue('+31612345678')).toBeInTheDocument();
  });

  it('marks phone as required (no "optional" tag) on registration forms', () => {
    renderForm();
    expect(screen.queryByText(/optional/i)).not.toBeInTheDocument();
  });

  it('keeps phone optional on event forms', () => {
    renderForm({ cycle: { ...baseCycle, type: 'event' } });
    expect(screen.getByText(/optional/i)).toBeInTheDocument();
  });

  it('renders a submit button', () => {
    renderForm();
    const submitBtn = screen.getByRole('button', { name: /submit|aanmeld|inschrijv/i });
    expect(submitBtn).toBeInTheDocument();
  });
});
