import { describe, it, expect } from 'vitest';
import { buildProfileNamePatch } from './signupUserProfileSync';

describe('buildProfileNamePatch', () => {
  it('includes structured names and full_name', () => {
    const patch = buildProfileNamePatch({
      firstName: 'Voor',
      lastName: 'Acther',
      fullName: 'Voor Acther',
    });
    expect(patch).toEqual({
      first_name: 'Voor',
      last_name: 'Acther',
      full_name: 'Voor Acther',
    });
  });

  it('does not include timezone on profiles', () => {
    const patch = buildProfileNamePatch({
      firstName: 'Jan',
      lastName: 'Jansen',
      fullName: 'Jan Jansen',
      phone: '+31612345678',
      language: 'nl',
      stripeCustomerId: 'cus_123',
    });
    expect(patch).not.toHaveProperty('timezone');
    expect(patch.phone).toBe('+31612345678');
    expect(patch.preferred_language).toBe('nl');
    expect(patch.stripe_customer_id).toBe('cus_123');
  });
});
