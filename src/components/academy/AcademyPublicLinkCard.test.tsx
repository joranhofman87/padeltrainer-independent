import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AcademyPublicLinkCard } from './AcademyPublicLinkCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/components/profile/ShareableProfileLink', () => ({
  ShareableProfileLink: () => <div data-testid="shareable-profile-link" />,
}));

const baseAcademy = {
  slug: 'padel-pro',
  is_public: false,
  subscription_status: 'inactive' as string | null,
};

describe('AcademyPublicLinkCard', () => {
  it('renders locked preview state when academy is not publicly shareable', () => {
    render(
      <MemoryRouter>
        <AcademyPublicLinkCard academy={baseAcademy} lang="en" />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('shareable-profile-link')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview academy page' })).toBeInTheDocument();
    expect(screen.getByText('Upgrade to share publicly')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Public academy pages are available after upgrading.')).toBeDisabled();
  });

  it('renders ShareableProfileLink when academy is public and subscription active', () => {
    render(
      <MemoryRouter>
        <AcademyPublicLinkCard
          academy={{ ...baseAcademy, is_public: true, subscription_status: 'active' }}
          lang="en"
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('shareable-profile-link')).toBeInTheDocument();
    expect(screen.queryByText('Upgrade to share publicly')).not.toBeInTheDocument();
  });
});
