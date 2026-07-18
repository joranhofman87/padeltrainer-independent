import { describe, expect, it } from 'vitest';
import {
  buildPseudonymousTrackingEmail,
  buildPersonTrackingId,
  sanitizeAnalyticsSearch,
  sanitizeTrackingProperties,
} from './trackingPrivacy';

describe('trackingPrivacy', () => {
  it('namespaces person UIDs before they are sent as distinct IDs', () => {
    expect(buildPersonTrackingId('p1')).toBe('person:p1');
    expect(buildPersonTrackingId('person:p1')).toBe('person:p1');
  });

  it('builds non-deliverable pseudonymous aliases for tools that require an email field', () => {
    expect(buildPseudonymousTrackingEmail('p1')).toBe('person-p1@uid.padeltrainer.invalid');
  });

  it('drops PII and unsafe identifiers from tracking properties', () => {
    expect(sanitizeTrackingProperties({
      role: 'player',
      email: 'player@example.com',
      userId: 'auth-user-id',
      playerName: 'Ada',
      trainer_slug: 'trainer-name',
      booking_id: 'b1',
      url: 'https://padeltrainer.ai/pay/secret',
    })).toEqual({
      role: 'player',
      booking_id: 'b1',
    });
  });

  it('keeps only allowlisted, non-personal query params', () => {
    expect(sanitizeAnalyticsSearch(
      '?utm_source=newsletter&source=paid_invoice&email=a@example.com&redirect=/pay/secret&free_text=hello',
    )).toBe('?utm_source=newsletter&source=paid_invoice');
  });
});
