import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OnboardingStep1Profile } from './OnboardingStep1Profile';

const mockMaybeSingle = vi.fn();
const mockUpdate = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle })),
          })),
          update: vi.fn(() => ({ eq: mockUpdate })),
        };
      }
      if (table === 'trainer_profiles') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({ data: { hourly_rate: null }, error: null }),
            })),
          })),
          update: vi.fn(() => ({ eq: mockUpdate })),
        };
      }
      return {};
    }),
  },
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, params?: { name?: string }) => {
      if (key === 'onboarding.step1.greeting' && params?.name) {
        return `Hi ${params.name}, let's set up your trainer profile.`;
      }
      if (key === 'onboarding.step1.greetingNoName') {
        return "Let's set up your trainer profile.";
      }
      const prefix = ns === 'onboarding' ? 'onboarding:' : '';
      return `${prefix}${key}`;
    },
    i18n: { language: 'en' },
  }),
}));

describe('OnboardingStep1Profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockResolvedValue({
      data: { first_name: 'Joran', last_name: 'Hofman', full_name: 'Joran Hofman', bio: '' },
      error: null,
    });
  });

  it('does not render name inputs', async () => {
    render(<OnboardingStep1Profile onNext={vi.fn()} />);
    await waitFor(() => {
      expect(document.getElementById('bio')).toBeInTheDocument();
    });
    expect(screen.queryByRole('textbox', { name: /name/i })).not.toBeInTheDocument();
    expect(document.getElementById('fullName')).toBeNull();
  });

  it('shows read-only greeting from profile first name', async () => {
    render(<OnboardingStep1Profile onNext={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Hi Joran, let's set up your trainer profile.")).toBeInTheDocument();
    });
  });

  it('requires bio and hourly rate before continue', async () => {
    render(<OnboardingStep1Profile onNext={vi.fn()} />);
    await waitFor(() => expect(document.getElementById('bio')).toBeInTheDocument());

    const continueBtn = screen.getByRole('button', { name: /continue/i });
    expect(continueBtn).toBeDisabled();

    fireEvent.change(document.getElementById('bio')!, {
      target: { value: 'Padel coach with ten years of club experience.' },
    });
    expect(continueBtn).toBeDisabled();

    fireEvent.change(document.getElementById('hourlyRate')!, { target: { value: '45' } });
    expect(continueBtn).not.toBeDisabled();
  });

  it('can continue without editing name', async () => {
    const onNext = vi.fn();
    render(<OnboardingStep1Profile onNext={onNext} />);
    await waitFor(() => expect(document.getElementById('bio')).toBeInTheDocument());

    fireEvent.change(document.getElementById('bio')!, {
      target: { value: 'Experienced padel trainer in Amsterdam.' },
    });
    fireEvent.change(document.getElementById('hourlyRate')!, { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(onNext).toHaveBeenCalled());
  });
});
