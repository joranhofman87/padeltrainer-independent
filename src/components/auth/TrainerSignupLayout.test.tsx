import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TrainerSignupLayout } from './TrainerSignupLayout';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      if (key === 'trainerSignup.headline') return 'Grow your training business';
      return fallback ?? key;
    },
    i18n: { language: 'en' },
  }),
}));

describe('TrainerSignupLayout', () => {
  it('renders signup form before value panel in document order', () => {
    render(
      <MemoryRouter>
        <TrainerSignupLayout>
          <div data-testid="signup-form-card">Form</div>
        </TrainerSignupLayout>
      </MemoryRouter>,
    );

    const form = screen.getByTestId('signup-form-card');
    const headline = screen.getByText('Grow your training business');
    expect(form.compareDocumentPosition(headline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
