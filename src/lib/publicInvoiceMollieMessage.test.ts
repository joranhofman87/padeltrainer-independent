import { describe, it, expect } from 'vitest';
import { getOnlinePaymentUnavailableMessageKey } from './publicInvoiceMollieMessage';

describe('getOnlinePaymentUnavailableMessageKey', () => {
  it('uses academy message for academy recipient', () => {
    expect(getOnlinePaymentUnavailableMessageKey('academy')).toBe(
      'invoice.onlinePaymentUnavailableAcademy',
    );
  });

  it('uses trainer message for trainer recipient', () => {
    expect(getOnlinePaymentUnavailableMessageKey('trainer')).toBe(
      'invoice.onlinePaymentUnavailableTrainer',
    );
  });

  it('defaults to academy when recipient unknown', () => {
    expect(getOnlinePaymentUnavailableMessageKey(null)).toBe(
      'invoice.onlinePaymentUnavailableAcademy',
    );
  });
});
