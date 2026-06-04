import { describe, it, expect } from 'vitest';
import {
  getAcademyMollieUiState,
  getAcademyPaymentUnavailableReasonKey,
} from './academyMollieSettingsState';

describe('getAcademyMollieUiState', () => {
  it('not connected when connected is false', () => {
    expect(getAcademyMollieUiState({ connected: false, paymentReady: false })).toBe('not_connected');
  });

  it('payment_ready when connected and paymentReady', () => {
    expect(getAcademyMollieUiState({ connected: true, paymentReady: true })).toBe('payment_ready');
  });

  it('connected_not_ready when org linked but not payment-ready', () => {
    expect(getAcademyMollieUiState({ connected: true, paymentReady: false })).toBe(
      'connected_not_ready',
    );
  });
});

describe('getAcademyPaymentUnavailableReasonKey', () => {
  it('maps missing_access_token', () => {
    expect(getAcademyPaymentUnavailableReasonKey('missing_access_token')).toBe(
      'settings.paymentNotReadyMissingToken',
    );
  });
});
