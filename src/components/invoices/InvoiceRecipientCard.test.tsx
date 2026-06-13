import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentProps as ReactComponentProps } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InvoiceRecipientCard } from './InvoiceRecipientCard';

const rpcMock = vi.fn();

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const map: Record<string, string> = {
        'invoiceEdit.recipient.title': 'Recipient',
        'invoiceEdit.recipient.name': 'Name',
        'invoiceEdit.recipient.email': 'Email',
        'invoiceEdit.recipient.type': 'Type',
        'invoiceEdit.recipient.registered': 'Registered Player',
        'invoiceEdit.recipient.guest': 'Guest Player',
        'invoiceEdit.recipient.manual': 'Manual Recipient',
        'invoiceEdit.recipient.openProfile': 'Open Player Profile',
        'invoiceEdit.recipient.openPlayersList': 'Open players list',
      };
      return map[key] ?? fallback ?? key;
    },
  }),
}));

function renderCard(props: ReactComponentProps<typeof InvoiceRecipientCard>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <InvoiceRecipientCard {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('InvoiceRecipientCard', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('shows registered player with email and academy profile link', async () => {
    rpcMock.mockResolvedValue({ data: 'player@example.com', error: null });

    renderCard({
      owner: 'academy',
      playerName: 'Jane Player',
      playerId: 'profile-uuid',
      guestPlayerId: null,
      invoiceId: 'inv-1',
    });

    expect(screen.getByText('Jane Player')).toBeInTheDocument();
    expect(screen.getByText('Registered Player')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'player@example.com' })).toHaveAttribute(
        'href',
        'mailto:player@example.com',
      );
    });
    expect(screen.getByRole('link', { name: 'Open Player Profile' })).toHaveAttribute(
      'href',
      '/app/academy/players/p_profile-uuid',
    );
  });

  it('shows guest with email and guest profile link', async () => {
    rpcMock.mockResolvedValue({ data: 'guest@example.com', error: null });

    renderCard({
      owner: 'academy',
      playerName: 'Guest Name',
      playerId: null,
      guestPlayerId: 'guest-uuid',
      invoiceId: 'inv-2',
    });

    expect(screen.getByText('Guest Player')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'guest@example.com' })).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: 'Open Player Profile' })).toHaveAttribute(
      'href',
      '/app/academy/players/g_guest-uuid',
    );
  });

  it('shows manual recipient without email or profile link', () => {
    renderCard({
      owner: 'academy',
      playerName: 'Walk-in Client',
      playerId: null,
      guestPlayerId: null,
    });

    expect(screen.getByText('Manual Recipient')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Player Profile' })).not.toBeInTheDocument();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('trainer links to player profile detail', async () => {
    rpcMock.mockResolvedValue({ data: 't@example.com', error: null });

    renderCard({
      owner: 'trainer',
      playerName: 'Trainer Player',
      playerId: 'profile-uuid',
      guestPlayerId: null,
      invoiceId: 'inv-3',
    });

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Open Player Profile' })).toHaveAttribute(
        'href',
        '/app/trainer/players/p_profile-uuid',
      );
    });
  });
});
