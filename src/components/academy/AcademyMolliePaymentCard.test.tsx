import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AcademyMolliePaymentCard } from './AcademyMolliePaymentCard';
import type { AcademyConnectStatus } from '@/lib/academyPayments';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const map: Record<string, string> = {
        'settings.mollieConnect': 'Payment Setup',
        'settings.notConnected': 'Not Connected',
        'settings.connectMollie': 'Connect Payment Account',
        'settings.paymentNotReadyTitle': 'Online payments not ready',
        'settings.paymentNotReadyDescription': 'Mollie is connected, but online payments are not ready.',
        'settings.paymentNotReadyMissingToken': 'Missing authorization token. Reconnect Mollie.',
        'settings.reconnectMollie': 'Reconnect Mollie',
        'settings.refreshStatus': 'Refresh Status',
        'settings.disconnectMollie': 'Disconnect',
        'settings.disconnectMollieTitle': 'Disconnect Mollie?',
        'settings.disconnectMollieDescription': 'Disconnect description',
        'settings.paymentReady': 'Ready for online payments',
        'settings.paymentsEnabled': 'Payments Enabled',
        'settings.payoutsEnabled': 'Payouts Enabled',
        'settings.mollieDashboard': 'Payment Dashboard',
        'settings.sessionRequiredTitle': 'Sign in required',
        'settings.sessionRequiredDescription':
          'Please log in again to manage payment settings.',
        'common.cancel': 'Cancel',
      };
      return map[key] ?? fallback ?? key;
    },
  }),
}));

const baseReady: AcademyConnectStatus = {
  connected: true,
  paymentReady: true,
  paymentUnavailableReason: null,
  hasAccessToken: true,
  hasRefreshToken: true,
  chargesEnabled: true,
  payoutsEnabled: true,
  onboardingComplete: true,
  balance: {
    available: [{ amount: 10, currency: 'EUR' }],
    pending: [{ amount: 0, currency: 'EUR' }],
  },
};

describe('AcademyMolliePaymentCard', () => {
  it('shows Connect when not connected', () => {
    render(
      <AcademyMolliePaymentCard
        connectStatus={{
          connected: false,
          paymentReady: false,
          hasAccessToken: false,
          hasRefreshToken: false,
          chargesEnabled: false,
          payoutsEnabled: false,
          onboardingComplete: false,
        }}
        checkingStatus={false}
        connectLoading={false}
        onConnect={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Connect Payment Account/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reconnect Mollie/i })).not.toBeInTheDocument();
  });

  it('shows Reconnect and Disconnect for broken connection', () => {
    render(
      <AcademyMolliePaymentCard
        connectStatus={{
          connected: true,
          paymentReady: false,
          paymentUnavailableReason: 'missing_access_token',
          hasAccessToken: false,
          hasRefreshToken: false,
          chargesEnabled: true,
          payoutsEnabled: true,
          onboardingComplete: true,
          mollieOrganizationId: 'org_19475084',
        }}
        checkingStatus={false}
        connectLoading={false}
        onConnect={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );
    expect(screen.getByText('Online payments not ready')).toBeInTheDocument();
    expect(screen.getByText(/Missing authorization token/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reconnect Mollie/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Disconnect$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay/i })).not.toBeInTheDocument();
  });

  it('shows dashboard and disconnect when payment-ready', () => {
    render(
      <AcademyMolliePaymentCard
        connectStatus={baseReady}
        checkingStatus={false}
        connectLoading={false}
        onConnect={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );
    expect(screen.getByText('Ready for online payments')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Payment Dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Disconnect$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reconnect Mollie/i })).not.toBeInTheDocument();
  });

  it('shows session required message and disables actions when sessionMissing', () => {
    render(
      <AcademyMolliePaymentCard
        connectStatus={null}
        checkingStatus={false}
        connectLoading={false}
        sessionMissing
        onConnect={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Please log in again to manage payment settings.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect Payment Account/i })).not.toBeInTheDocument();
  });

  it('calls onConnect when Reconnect is clicked', () => {
    const onConnect = vi.fn();
    render(
      <AcademyMolliePaymentCard
        connectStatus={{
          connected: true,
          paymentReady: false,
          paymentUnavailableReason: 'missing_access_token',
          hasAccessToken: false,
          hasRefreshToken: false,
          chargesEnabled: true,
          payoutsEnabled: true,
          onboardingComplete: true,
        }}
        checkingStatus={false}
        connectLoading={false}
        onConnect={onConnect}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Reconnect Mollie/i }));
    expect(onConnect).toHaveBeenCalled();
  });
});
