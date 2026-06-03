import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PlayerInvoicesPage from './PlayerInvoicesPage';

vi.mock('@/components/player/PlayerInvoicesTab', () => ({
  PlayerInvoicesTab: ({ profileId }: { profileId: string }) => (
    <div data-testid="player-invoices-tab">invoices-tab-{profileId}</div>
  ),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    profile: { id: 'profile-abc' },
    loading: false,
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const map: Record<string, string> = {
        'invoices.title': 'Invoices',
        'invoices.description': 'View and download invoices for your training sessions.',
      };
      return map[key] ?? fallback ?? key;
    },
  }),
}));

describe('PlayerInvoicesPage', () => {
  it('renders page header and PlayerInvoicesTab with profile id', () => {
    render(
      <MemoryRouter>
        <PlayerInvoicesPage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('page-player-invoices')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Invoices' })).toBeInTheDocument();
    expect(screen.getByText(/View and download invoices/)).toBeInTheDocument();
    expect(screen.getByTestId('player-invoices-tab')).toHaveTextContent('invoices-tab-profile-abc');
  });
});
