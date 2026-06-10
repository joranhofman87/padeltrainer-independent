import { describe, it, expect } from 'vitest';
import { evaluateClubTrainerAccess } from '../../supabase/functions/_shared/club-trainer-access.ts';

const CLUB_LOCATION = 'loc-club-a';

describe('evaluateClubTrainerAccess', () => {
  it('allows a manager of the club to attach a trainer to the club location', () => {
    expect(
      evaluateClubTrainerAccess({
        managesClub: true,
        clubLocationId: CLUB_LOCATION,
        requestedLocationId: CLUB_LOCATION,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a caller who does not manage the target club (IDOR)', () => {
    expect(
      evaluateClubTrainerAccess({
        managesClub: false,
        clubLocationId: CLUB_LOCATION,
        requestedLocationId: CLUB_LOCATION,
      }),
    ).toEqual({ ok: false, reason: 'not_club_manager' });
  });

  it('rejects attaching to a location that does not belong to the club', () => {
    expect(
      evaluateClubTrainerAccess({
        managesClub: true,
        clubLocationId: CLUB_LOCATION,
        requestedLocationId: 'loc-club-b',
      }),
    ).toEqual({ ok: false, reason: 'location_mismatch' });
  });

  it('rejects when the club row / its location is missing', () => {
    expect(
      evaluateClubTrainerAccess({
        managesClub: true,
        clubLocationId: null,
        requestedLocationId: CLUB_LOCATION,
      }),
    ).toEqual({ ok: false, reason: 'location_mismatch' });
    expect(
      evaluateClubTrainerAccess({
        managesClub: true,
        clubLocationId: CLUB_LOCATION,
        requestedLocationId: undefined,
      }),
    ).toEqual({ ok: false, reason: 'location_mismatch' });
  });
});
