import { describe, it, expect } from 'vitest';
import { isAppRoute, needsAuthProfileBootstrap } from './appBootstrap';

describe('appBootstrap', () => {
  it('detects app routes', () => {
    expect(isAppRoute('/app/academy/calendar')).toBe(true);
    expect(isAppRoute('/en/pricing')).toBe(false);
  });

  it('does not gate public app routes', () => {
    expect(needsAuthProfileBootstrap('/app/auth')).toBe(false);
    expect(needsAuthProfileBootstrap('/app/signup/trainer')).toBe(false);
    expect(needsAuthProfileBootstrap('/app/onboarding/trainer')).toBe(false);
    expect(needsAuthProfileBootstrap('/app/book/trainer-1')).toBe(false);
  });

  it('gates protected app routes', () => {
    expect(needsAuthProfileBootstrap('/app/academy')).toBe(true);
    expect(needsAuthProfileBootstrap('/app/academy/settings')).toBe(true);
    expect(needsAuthProfileBootstrap('/app/trainer/calendar')).toBe(true);
    expect(needsAuthProfileBootstrap('/app/player')).toBe(true);
  });
});
