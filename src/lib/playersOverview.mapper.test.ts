import { describe, it, expect } from 'vitest';
import { mapPlayersOverviewRow, type PlayersOverviewRow } from './playersOverview';

/** Build a players-overview row with the fields the mapper reads (the generated type has more). */
function makeRow(overrides: Partial<PlayersOverviewRow> = {}): PlayersOverviewRow {
  return {
    guest_player_id: 'g1',
    profile_id: null,
    full_name: 'Alice',
    email: 'a@x.nl',
    phone: '06',
    billing_business_name: null,
    skill_rating: 5,
    rating_system: 'level',
    has_trained: true,
    notes: 'public note',
    created_at: '2026-01-01',
    player_type: 'guest',
    location_names: ['Court A'],
    has_active_cyclus: true,
    source: 'web',
    birth_date: null,
    metadata_id: 'm1',
    tag_ids: ['t1'],
    academy_notes: 'coach note',
    has_overdue_payment: false,
    email_undeliverable: false,
    owner_trainer_id: 'tr1',
    trainer_ids: ['tr1'],
    location_ids: ['loc1'],
    ...overrides,
  } as unknown as PlayersOverviewRow;
}

describe('mapPlayersOverviewRow', () => {
  it('maps the common fields in trainer mode and leaves academy-only fields undefined', () => {
    const p = mapPlayersOverviewRow(makeRow());
    expect(p.id).toBe('g1');
    expect(p.full_name).toBe('Alice');
    expect(p.type).toBe('guest');
    expect(p.notes).toBe('public note');
    expect(p.internal_notes).toBe('coach note'); // sourced from academy_notes
    expect(p.tag_ids).toEqual(['t1']);
    expect(p.location_names).toEqual(['Court A']);
    expect(p.trainer_id).toBeUndefined();
    expect(p.trainer_name).toBeUndefined();
    expect(p.training_location_ids).toBeUndefined();
  });

  it('derives the id from the profile for registered players', () => {
    const p = mapPlayersOverviewRow(makeRow({ guest_player_id: null, profile_id: 'p9', player_type: 'registered' }));
    expect(p.id).toBe('reg-p9');
    expect(p.type).toBe('registered');
  });

  it('defaults internal_notes to empty string when academy_notes is null', () => {
    expect(mapPlayersOverviewRow(makeRow({ academy_notes: null })).internal_notes).toBe('');
  });

  it('populates academy fields + resolves a guest trainer name in academy mode', () => {
    const map = new Map([['tr1', 'Coach Bob']]);
    const p = mapPlayersOverviewRow(makeRow(), { trainerNames: { map, academyLabel: 'Academy' } });
    expect(p.trainer_id).toBe('tr1');
    expect(p.trainer_ids).toEqual(['tr1']);
    expect(p.trainer_name).toBe('Coach Bob');
    expect(p.training_location_ids).toEqual(['loc1']);
  });

  it('falls back to the Academy label for an unowned guest', () => {
    const p = mapPlayersOverviewRow(makeRow({ owner_trainer_id: null }), {
      trainerNames: { map: new Map(), academyLabel: 'Academy' },
    });
    expect(p.trainer_name).toBe('Academy');
  });

  it('resolves a registered player trainer name from the first trainer id', () => {
    const map = new Map([['trA', 'Coach A']]);
    const p = mapPlayersOverviewRow(
      // a PLAIN registered row carries no owner_trainer_id (that comes only from a guest side)
      makeRow({
        guest_player_id: null, profile_id: 'p1', player_type: 'registered',
        owner_trainer_id: null, trainer_ids: ['trA'],
      }),
      { trainerNames: { map, academyLabel: 'Academy' } },
    );
    expect(p.trainer_name).toBe('Coach A');
  });

  it('a MERGED registered row (guest side trainer-owned) shows the OWNING trainer, not trainer_ids[0]', () => {
    const map = new Map([['trOwner', 'Owner Coach'], ['trOther', 'Other Coach']]);
    const p = mapPlayersOverviewRow(
      makeRow({
        guest_player_id: 'g1', profile_id: 'p1', person_id: 'p1', player_type: 'registered',
        owner_trainer_id: 'trOwner', trainer_ids: ['trOther', 'trOwner'],
      }),
      { trainerNames: { map, academyLabel: 'Academy' } },
    );
    expect(p.trainer_name).toBe('Owner Coach');
  });

  it('shows an em dash when a trainer id is missing from the name map', () => {
    const p = mapPlayersOverviewRow(makeRow(), { trainerNames: { map: new Map(), academyLabel: 'Academy' } });
    expect(p.trainer_name).toBe('—');
  });
});
