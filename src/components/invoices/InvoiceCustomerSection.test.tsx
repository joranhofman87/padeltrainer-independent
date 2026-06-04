import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InvoiceCustomerSection } from './InvoiceCustomerSection';
import type { InvoiceSelectablePlayer } from '@/lib/invoiceSelectablePlayers';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | { defaultValue?: string; name?: string }) => {
      if (typeof opts === 'string') return opts;
      if (key === 'invoiceForm.customer.linkedToPlayer' && opts && 'name' in opts && opts.name) {
        return `Linked to ${opts.name}`;
      }
      return (opts && typeof opts === 'object' && opts.defaultValue) || key;
    },
  }),
}));

vi.mock('@/components/trainer/GuestPlayerSlotCombobox', () => ({
  GuestPlayerSlotCombobox: ({
    onValueChange,
    'data-testid': testId,
  }: {
    onValueChange: (v: string) => void;
    'data-testid'?: string;
  }) => (
    <button type="button" data-testid={testId} onClick={() => onValueChange('p_profile-1')}>
      pick player
    </button>
  ),
}));

const samplePlayer: InvoiceSelectablePlayer = {
  comboboxId: 'p_profile-1',
  full_name: 'Jane Doe',
  email: 'jane@example.com',
  phone: '',
  type: 'registered',
  profileId: 'profile-1',
  guestPlayerId: null,
  billing_business_name: 'Acme',
  billing_address: 'Street 1\n1234 AB City',
  billing_btw_number: 'NL999',
};

describe('InvoiceCustomerSection', () => {
  it('shows linked indicator when a player is linked', () => {
    render(
      <InvoiceCustomerSection
        players={[samplePlayer]}
        playerLink={{
          profileId: 'profile-1',
          guestPlayerId: null,
          linkedDisplayName: 'Jane Doe',
        }}
        onPlayerLinkChange={vi.fn()}
        receiver={{
          playerName: 'Jane Doe',
          playerEmail: 'jane@example.com',
          playerBusinessName: 'Acme',
          playerStreet: 'Street 1',
          playerZipCode: '1234 AB',
          playerCity: 'City',
          playerBtwNumber: 'NL999',
        }}
        onReceiverChange={vi.fn()}
        oneTimeMode={false}
        onOneTimeModeChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('invoice-linked-player-indicator')).toHaveTextContent('Linked to Jane Doe');
  });

  it('hides search when opened from player profile', () => {
    render(
      <InvoiceCustomerSection
        players={[samplePlayer]}
        hidePlayerSearch
        playerLink={{
          profileId: 'profile-1',
          guestPlayerId: null,
          linkedDisplayName: 'Jane Doe',
        }}
        onPlayerLinkChange={vi.fn()}
        receiver={{
          playerName: 'Jane Doe',
          playerEmail: '',
          playerBusinessName: '',
          playerStreet: '',
          playerZipCode: '',
          playerCity: '',
          playerBtwNumber: '',
        }}
        onReceiverChange={vi.fn()}
        oneTimeMode={false}
        onOneTimeModeChange={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('invoice-customer-search')).not.toBeInTheDocument();
    expect(screen.getByTestId('invoice-linked-player-indicator')).toBeInTheDocument();
  });

  it('clears link when switching to one-time customer', () => {
    const onPlayerLinkChange = vi.fn();
    const onOneTimeModeChange = vi.fn();

    render(
      <InvoiceCustomerSection
        players={[samplePlayer]}
        playerLink={{
          profileId: 'profile-1',
          guestPlayerId: null,
          linkedDisplayName: 'Jane Doe',
        }}
        onPlayerLinkChange={onPlayerLinkChange}
        receiver={{
          playerName: 'Jane Doe',
          playerEmail: '',
          playerBusinessName: '',
          playerStreet: '',
          playerZipCode: '',
          playerCity: '',
          playerBtwNumber: '',
        }}
        onReceiverChange={vi.fn()}
        oneTimeMode={false}
        onOneTimeModeChange={onOneTimeModeChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Use one-time customer' }));
    expect(onPlayerLinkChange).toHaveBeenCalledWith({
      profileId: null,
      guestPlayerId: null,
      linkedDisplayName: null,
    });
    expect(onOneTimeModeChange).toHaveBeenCalledWith(true);
  });
});
