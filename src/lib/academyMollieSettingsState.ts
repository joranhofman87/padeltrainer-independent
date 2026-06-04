import type { AcademyConnectStatus } from '@/lib/academyPayments';

export type AcademyMollieUiState = 'not_connected' | 'payment_ready' | 'connected_not_ready';

export function getAcademyMollieUiState(
  status: Pick<AcademyConnectStatus, 'connected' | 'paymentReady'> | null | undefined,
): AcademyMollieUiState {
  if (!status?.connected) return 'not_connected';
  if (status.paymentReady) return 'payment_ready';
  return 'connected_not_ready';
}

/** i18n key under academy namespace (settings.*). */
export function getAcademyPaymentUnavailableReasonKey(
  reason: string | null | undefined,
): string {
  switch (reason) {
    case 'missing_access_token':
      return 'settings.paymentNotReadyMissingToken';
    case 'onboarding_incomplete':
      return 'settings.paymentNotReadyOnboarding';
    case 'charges_disabled':
      return 'settings.paymentNotReadyCharges';
    default:
      return 'settings.paymentNotReadyGeneric';
  }
}
