import { describe, it, expect } from 'vitest';
import {
  aggregatePlayerTrainingLocations,
  validatePreferredLocationId,
  type TrainingBookingRow,
} from './academyPlayerTrainingLocations';

const ACADEMY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const LOC_A = '11111111-1111-4111-8111-111111111111';
const LOC_B = '22222222-2222-4222-8222-222222222222';
const LOC_OTHER = '33333333-3333-4333-8333-333333333333';
const TRAINER_1 = '44444444-4444-4444-8444-444444444444';

const academyLocationIds = new Set([LOC_A, LOC_B]);
const academyTrainerIds = new Set([TRAINER_1]);

function row(overrides: Partial<TrainingBookingRow>): TrainingBookingRow {
  return {
    booking_id: 'b1',
    booking_status: 'confirmed',
    slot_id: 's1',
    slot_trainer_id: TRAINER_1,
    slot_academy_profile_id: ACADEMY_ID,
    location_id: LOC_A,
    location_name: 'Club A',
    start_time: '2026-01-01T10:00:00Z',
    profiles_location: 'Arbitrary free text club',
    ...overrides,
  };
}

describe('academyPlayerTrainingLocations', () => {
  it('returns only rows with real location_id from locations', () => {
    const result = aggregatePlayerTrainingLocations(
      [
        row({ location_id: LOC_A, location_name: 'Club A' }),
        row({ booking_id: 'b2', location_id: null, location_name: 'Ghost Club' }),
        row({ booking_id: 'b3', location_id: 'not-a-uuid', location_name: 'Typed Club' }),
      ],
      { academyProfileId: ACADEMY_ID, academyLocationIds, academyTrainerIds },
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      location_id: LOC_A,
      location_name: 'Club A',
      session_count: 1,
    });
  });

  it('ignores profiles.location free text completely', () => {
    const result = aggregatePlayerTrainingLocations(
      [
        row({
          location_id: null,
          location_name: null,
          profiles_location: 'Should never appear',
        }),
      ],
      { academyProfileId: ACADEMY_ID, academyLocationIds, academyTrainerIds },
    );

    expect(result).toEqual([]);
  });

  it('excludes locations outside academy_locations', () => {
    const result = aggregatePlayerTrainingLocations(
      [row({ location_id: LOC_OTHER, location_name: 'Outside Academy' })],
      { academyProfileId: ACADEMY_ID, academyLocationIds, academyTrainerIds },
    );

    expect(result).toEqual([]);
  });

  it('excludes slots outside academy trainer/academy scope', () => {
    const result = aggregatePlayerTrainingLocations(
      [
        row({
          slot_trainer_id: '99999999-9999-4999-8999-999999999999',
          slot_academy_profile_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        }),
      ],
      { academyProfileId: ACADEMY_ID, academyLocationIds, academyTrainerIds },
    );

    expect(result).toEqual([]);
  });

  it('aggregates session counts per location_id', () => {
    const result = aggregatePlayerTrainingLocations(
      [
        row({ booking_id: 'b1', location_id: LOC_A, location_name: 'Club A' }),
        row({ booking_id: 'b2', location_id: LOC_A, location_name: 'Club A' }),
        row({ booking_id: 'b3', location_id: LOC_B, location_name: 'Club B' }),
      ],
      { academyProfileId: ACADEMY_ID, academyLocationIds, academyTrainerIds },
    );

    expect(result).toEqual([
      expect.objectContaining({ location_id: LOC_A, session_count: 2 }),
      expect.objectContaining({ location_id: LOC_B, session_count: 1 }),
    ]);
  });

  it('rejects free-text preferred location ids', () => {
    expect(() =>
      validatePreferredLocationId('Padel Club Amsterdam', academyLocationIds),
    ).toThrow('freeTextLocationNotAllowed');
  });

  it('rejects location ids not linked to academy', () => {
    expect(() => validatePreferredLocationId(LOC_OTHER, academyLocationIds)).toThrow(
      'locationNotInAcademy',
    );
  });

  it('accepts valid academy location ids', () => {
    expect(validatePreferredLocationId(LOC_A, academyLocationIds)).toBe(LOC_A);
    expect(validatePreferredLocationId('', academyLocationIds)).toBeNull();
  });
});
