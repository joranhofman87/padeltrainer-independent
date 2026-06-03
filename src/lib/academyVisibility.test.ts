import { describe, it, expect } from 'vitest';
import { canShareAcademyPublicly, getAcademyPreviewUrl } from './academyVisibility';

describe('canShareAcademyPublicly', () => {
  it.each([
    { is_public: false, subscription_status: 'inactive', expected: false },
    { is_public: true, subscription_status: 'inactive', expected: false },
    { is_public: false, subscription_status: 'active', expected: false },
    { is_public: true, subscription_status: 'active', expected: true },
    { is_public: true, subscription_status: 'trialing', expected: false },
    { is_public: true, subscription_status: null, expected: false },
  ])(
    'is_public=$is_public subscription_status=$subscription_status → $expected',
    ({ is_public, subscription_status, expected }) => {
      expect(canShareAcademyPublicly({ is_public, subscription_status })).toBe(expected);
    },
  );
});

describe('getAcademyPreviewUrl', () => {
  it('builds marketing academy URL with preview query', () => {
    const url = getAcademyPreviewUrl('padel-pro', 'en');
    expect(url).toBe('https://padeltrainer.ai/en/academies/padel-pro?preview=true');
  });

  it('defaults language to nl for unsupported lang codes', () => {
    const url = getAcademyPreviewUrl('padel-pro', 'de');
    expect(url).toBe('https://padeltrainer.ai/nl/academies/padel-pro?preview=true');
  });
});
