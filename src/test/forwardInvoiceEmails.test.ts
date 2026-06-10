import { describe, it, expect } from 'vitest';
import {
  dedupeForwardEmails,
  normalizeForwardEmails,
  resolveForwardRecipients,
} from '../../supabase/functions/_shared/forward-invoice-emails.ts';

describe('normalizeForwardEmails', () => {
  it('lowercases and trims', () => {
    expect(normalizeForwardEmails(['  Foo@Bar.COM  '])).toEqual(['foo@bar.com']);
  });
});

describe('resolveForwardRecipients', () => {
  const academyEmails = [
    'joranhofman87+boekhoudcctest@gmail.com',
    '10130.3195@to-zenvoices.com',
  ];
  const trainerEmails = ['trainer@example.com'];

  it('academy invoice prefers academy emails before trainer fallback', () => {
    const result = resolveForwardRecipients({
      academyProfileId: 'academy-1',
      academyForwardEmails: academyEmails,
      trainerForwardEmails: null,
    });
    expect(result.source).toBe('academy');
    expect(result.emails).toEqual(academyEmails.map((e) => e.toLowerCase()));
  });

  it('academy invoice merges and dedupes academy + trainer emails', () => {
    const result = resolveForwardRecipients({
      academyProfileId: 'academy-1',
      academyForwardEmails: academyEmails,
      trainerForwardEmails: [...trainerEmails, academyEmails[0]],
    });
    expect(result.source).toBe('merged');
    expect(result.emails).toHaveLength(3);
    expect(result.emails).toContain('trainer@example.com');
  });

  it('academy invoice falls back to trainer when academy list empty', () => {
    const result = resolveForwardRecipients({
      academyProfileId: 'academy-1',
      academyForwardEmails: [],
      trainerForwardEmails: trainerEmails,
    });
    expect(result.source).toBe('trainer');
    expect(result.emails).toEqual(['trainer@example.com']);
  });

  it('trainer-only invoice uses trainer emails', () => {
    const result = resolveForwardRecipients({
      academyProfileId: null,
      academyForwardEmails: academyEmails,
      trainerForwardEmails: trainerEmails,
    });
    expect(result.source).toBe('trainer');
    expect(result.emails).toEqual(['trainer@example.com']);
  });

  it('returns none when no emails configured', () => {
    const result = resolveForwardRecipients({
      academyProfileId: 'academy-1',
      academyForwardEmails: null,
      trainerForwardEmails: null,
    });
    expect(result.source).toBe('none');
    expect(result.emails).toEqual([]);
  });
});

describe('dedupeForwardEmails', () => {
  it('removes duplicates', () => {
    expect(dedupeForwardEmails(['a@b.com', 'a@b.com', 'c@d.com'])).toEqual(['a@b.com', 'c@d.com']);
  });
});
