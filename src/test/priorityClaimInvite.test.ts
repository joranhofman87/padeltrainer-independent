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
  it('embeds the real token for a normal send, language-prefixed (nl default)', () => {
    expect(buildClaimUrl('https://padeltrainer.ai', 'secret-token', false)).toBe(
      'https://padeltrainer.ai/nl/claim/secret-token',
    );
  });

  it('redacts the token for a test/preview send (no live token in inbox)', () => {
    const url = buildClaimUrl('https://padeltrainer.ai', 'secret-token', true);
    expect(url).toBe('https://padeltrainer.ai/nl/claim/preview');
    expect(url).not.toContain('secret-token');
  });

  it('honours an explicit language and clamps unsupported ones to nl', () => {
    expect(buildClaimUrl('https://padeltrainer.ai', 'tok', false, 'en')).toBe(
      'https://padeltrainer.ai/en/claim/tok',
    );
    expect(buildClaimUrl('https://padeltrainer.ai', 'tok', false, 'fr')).toBe(
      'https://padeltrainer.ai/nl/claim/tok',
    );
  });
});

describe('resolveRecipient — GUEST-FIRST (FAM-02), keyed on the row ids', () => {
  it('a pure profile goes to the profile email', () => {
    expect(
      resolveRecipient({
        isTest: false, callerEmail: 'manager@club.com',
        row: { player_id: 'P1', guest_player_id: null },
        playerEmail: 'player@example.com', guestEmail: null,
      }),
    ).toBe('player@example.com');
  });

  it('a pure guest goes to the guest email', () => {
    expect(
      resolveRecipient({
        isTest: false, callerEmail: null,
        row: { player_id: null, guest_player_id: 'G1' },
        playerEmail: null, guestEmail: 'guest@example.com',
      }),
    ).toBe('guest@example.com');
  });

  it('PROOF: a DUAL-KEY child with their OWN email is mailed at the CHILD, not the linked parent', () => {
    // The bug: `playerEmail || guestEmail` mailed the child at the parent's inbox. Guest-first
    // keys on the ids, so the child's own address wins.
    expect(
      resolveRecipient({
        isTest: false, callerEmail: null,
        row: { player_id: 'P1', guest_player_id: 'G1' },
        playerEmail: 'parent@example.com', guestEmail: 'child@example.com',
      }),
    ).toBe('child@example.com');
  });

  it('PROOF: the linked parent email is used ONLY when the dual-key guest has none of their own', () => {
    // guestEmail here is already effectiveGuestEmail(guest) = guest.email ?? linked_profile.email;
    // when that is null (no own address, no linked profile), fall back to the profile via player_id.
    expect(
      resolveRecipient({
        isTest: false, callerEmail: null,
        row: { player_id: 'P1', guest_player_id: 'G1' },
        playerEmail: 'parent@example.com', guestEmail: null,
      }),
    ).toBe('parent@example.com');
  });

  it('test send always goes to the caller, never an attacker-chosen address', () => {
    expect(
      resolveRecipient({
        isTest: true, callerEmail: 'manager@club.com',
        row: { player_id: 'P1', guest_player_id: 'G1' },
        playerEmail: 'victim@example.com', guestEmail: 'victim2@example.com',
      }),
    ).toBe('manager@club.com');
  });

  it('test send with no caller email yields no recipient', () => {
    expect(
      resolveRecipient({
        isTest: true, callerEmail: null,
        row: { player_id: 'P1', guest_player_id: null },
        playerEmail: 'x@y.com', guestEmail: null,
      }),
    ).toBe(null);
  });
});
