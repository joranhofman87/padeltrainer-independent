import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateRating,
  formatRatingWithSystem,
  COUNTRY_NAMES,
  type RatingSystemConfig,
} from './ratingSystems';

// Mock rating system configurations for testing
const mockKNLTBSystem: RatingSystemConfig = {
  id: 'test-knltb',
  code: 'knltb',
  name: 'KNLTB',
  country: 'NL',
  min_rating: 0.1,
  max_rating: 9.9,
  step: 0.1,
  lower_is_better: true,
  member_id_label: 'KNLTB Number',
  member_id_placeholder: '12345678',
  is_active: true,
  display_order: 1,
};

const mockPlaytomicSystem: RatingSystemConfig = {
  id: 'test-playtomic',
  code: 'playtomic',
  name: 'Playtomic',
  country: 'INT',
  min_rating: 0.1,
  max_rating: 6.0,
  step: 0.1,
  lower_is_better: false,
  member_id_label: null,
  member_id_placeholder: null,
  is_active: true,
  display_order: 10,
};

describe('validateRating', () => {
  describe('with KNLTB system (0.1-9.9)', () => {
    it('returns true for null rating', () => {
      expect(validateRating(null, mockKNLTBSystem)).toBe(true);
    });

    it('returns true for undefined rating', () => {
      expect(validateRating(undefined, mockKNLTBSystem)).toBe(true);
    });

    it('returns true for minimum valid rating', () => {
      expect(validateRating(0.1, mockKNLTBSystem)).toBe(true);
    });

    it('returns true for maximum valid rating', () => {
      expect(validateRating(9.9, mockKNLTBSystem)).toBe(true);
    });

    it('returns true for rating in middle of range', () => {
      expect(validateRating(5.0, mockKNLTBSystem)).toBe(true);
    });

    it('returns false for rating below minimum', () => {
      expect(validateRating(0.0, mockKNLTBSystem)).toBe(false);
    });

    it('returns false for rating above maximum', () => {
      expect(validateRating(10.0, mockKNLTBSystem)).toBe(false);
    });

    it('returns false for negative rating', () => {
      expect(validateRating(-1, mockKNLTBSystem)).toBe(false);
    });
  });

  describe('with Playtomic system (0.1-6.0)', () => {
    it('returns true for valid Playtomic rating', () => {
      expect(validateRating(4.5, mockPlaytomicSystem)).toBe(true);
    });

    it('returns false for rating above Playtomic max', () => {
      expect(validateRating(7.0, mockPlaytomicSystem)).toBe(false);
    });
  });
});

describe('formatRatingWithSystem', () => {
  it('formats KNLTB rating with 1 decimal place', () => {
    expect(formatRatingWithSystem(5.5691, 'KNLTB')).toBe('5.6 (KNLTB)');
  });

  it('formats KNLTB rating with trailing zero', () => {
    expect(formatRatingWithSystem(5.0, 'KNLTB')).toBe('5.0 (KNLTB)');
  });

  it('formats Playtomic rating with one decimal place', () => {
    expect(formatRatingWithSystem(5, 'Playtomic')).toBe('5.0 (Playtomic)');
  });

  it('returns dash for null rating', () => {
    expect(formatRatingWithSystem(null, 'KNLTB')).toBe('—');
  });

  it('returns dash for undefined rating', () => {
    expect(formatRatingWithSystem(undefined, 'KNLTB')).toBe('—');
  });
});

describe('COUNTRY_NAMES', () => {
  it('contains Netherlands mapping', () => {
    expect(COUNTRY_NAMES['NL']).toBe('Netherlands');
  });

  it('contains Belgium mapping', () => {
    expect(COUNTRY_NAMES['BE']).toBe('Belgium');
  });

  it('contains Spain mapping', () => {
    expect(COUNTRY_NAMES['ES']).toBe('Spain');
  });

  it('contains International mapping', () => {
    expect(COUNTRY_NAMES['INT']).toBe('International');
  });

  it('contains all expected countries', () => {
    const expectedCountries = ['NL', 'BE', 'ES', 'GB', 'DE', 'FR', 'IT', 'INT'];
    expectedCountries.forEach((code) => {
      expect(COUNTRY_NAMES[code]).toBeDefined();
    });
  });
});
