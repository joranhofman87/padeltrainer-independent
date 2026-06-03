import { describe, it, expect } from 'vitest';
import {
  computeTrainerProfileSetupComplete,
  computeTrainerPublishComplete,
} from './trainerSetupPlan';

describe('computeTrainerProfileSetupComplete', () => {
  it('returns false when slug would exist but bio is empty', () => {
    expect(
      computeTrainerProfileSetupComplete({
        fullName: 'Jane Coach',
        bio: '',
        hourlyRate: 50,
      }),
    ).toBe(false);
  });

  it('returns false when bio is too short', () => {
    expect(
      computeTrainerProfileSetupComplete({
        fullName: 'Jane Coach',
        bio: 'Short',
        hourlyRate: 50,
      }),
    ).toBe(false);
  });

  it('returns false when hourly rate is missing or zero', () => {
    expect(
      computeTrainerProfileSetupComplete({
        fullName: 'Jane Coach',
        bio: 'Padel trainer in Amsterdam with five years of experience.',
        hourlyRate: null,
      }),
    ).toBe(false);
    expect(
      computeTrainerProfileSetupComplete({
        fullName: 'Jane Coach',
        bio: 'Padel trainer in Amsterdam with five years of experience.',
        hourlyRate: 0,
      }),
    ).toBe(false);
  });

  it('returns true when full_name, bio (≥10), and hourly_rate > 0', () => {
    expect(
      computeTrainerProfileSetupComplete({
        fullName: 'Jane Coach',
        bio: 'Padel trainer in Amsterdam with five years of experience.',
        hourlyRate: 45,
      }),
    ).toBe(true);
  });
});

describe('computeTrainerPublishComplete', () => {
  it('returns true when slug exists and is_public is true', () => {
    expect(
      computeTrainerPublishComplete({
        slug: 'jane-coach',
        isPublic: true,
      }),
    ).toBe(true);
  });

  it('returns false when slug exists but is_public is false', () => {
    expect(
      computeTrainerPublishComplete({
        slug: 'jane-coach',
        isPublic: false,
      }),
    ).toBe(false);
  });

  it('returns false when is_public is true but slug is missing', () => {
    expect(
      computeTrainerPublishComplete({
        slug: null,
        isPublic: true,
      }),
    ).toBe(false);
  });
});
