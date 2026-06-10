import { describe, it, expect } from 'vitest';
import {
  resolveAppBase,
  buildClaimUrl,
  resolveRecipient,
} from '../../supabase/functions/_shared/priority-claim-invite.ts';

describe('resolveAppBase', () => {
  it('uses PUBLIC_APP_URL when set (trimming trailing slash)', () => {
    expect(resolveAppBase('https://app.example.com/')).toBe('https://app.example.com');
  });

  it('falls back to padeltrainer.ai (never the stale lovable domain)', () => {
    expect(resolveAppBase(undefined)).toBe('https://padeltrainer.ai');
    expect(resolveAppBase('')).toBe('https://padeltrainer.ai');
    expect(resolveAppBase('   ')).toBe('https://padeltrainer.ai');
  });
});

describe('buildClaimUrl', () => {
  it('embeds the real token for a normal send', () => {
    expect(buildClaimUrl('https://padeltrainer.ai', 'secret-token', false)).toBe(
      'https://padeltrainer.ai/claim/secret-token',
    );
  });

  it('redacts the token for a test/preview send (no live token in inbox)', () => {
    const url = buildClaimUrl('https://padeltrainer.ai', 'secret-token', true);
    expect(url).toBe('https://padeltrainer.ai/claim/preview');
    expect(url).not.toContain('secret-token');
  });
});

describe('resolveRecipient', () => {
  it('real send goes to the claim player/guest email', () => {
    expect(
      resolveRecipient({
        isTest: false,
        callerEmail: 'manager@club.com',
        playerEmail: 'player@example.com',
        guestEmail: null,
      }),
    ).toBe('player@example.com');
    expect(
      resolveRecipient({ isTest: false, callerEmail: null, playerEmail: null, guestEmail: 'guest@example.com' }),
    ).toBe('guest@example.com');
  });

  it('test send always goes to the caller, never an attacker-chosen address', () => {
    expect(
      resolveRecipient({
        isTest: true,
        callerEmail: 'manager@club.com',
        playerEmail: 'victim@example.com',
        guestEmail: null,
      }),
    ).toBe('manager@club.com');
  });

  it('test send with no caller email yields no recipient', () => {
    expect(
      resolveRecipient({ isTest: true, callerEmail: null, playerEmail: 'x@y.com', guestEmail: null }),
    ).toBe(null);
  });
});
