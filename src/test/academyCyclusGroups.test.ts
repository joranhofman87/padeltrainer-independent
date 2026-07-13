import { describe, it, expect } from 'vitest';
import { format, parseISO } from 'date-fns';
import { enUS } from 'date-fns/locale';
import {
  mapCyclusGroupRow,
  isMissingCyclusGroupsRpc,
  type AcademyCyclusGroupRow,
} from '@/lib/academyCyclusGroups';

// Compute the expected locale strings with the SAME date-fns calls the mapper uses, so the test is
// timezone-independent (both render the same instant in the same local tz).
const dayTime = (startIso: string, endIso?: string) => {
  const start = parseISO(startIso);
  const s = `${format(start, 'EEEE', { locale: enUS })} ${format(start, 'HH:mm')}`;
  return endIso ? `${s} - ${format(parseISO(endIso), 'HH:mm')}` : s;
};
const dayLabel = (startIso: string) => {
  const start = parseISO(startIso);
  return `${format(start, 'EEEE', { locale: enUS })} ${format(start, 'HH:mm')}`;
};

const row = (over: Partial<AcademyCyclusGroupRow> = {}): AcademyCyclusGroupRow => ({
  cyclus_id: 'cy1',
  group_suffix: 't1',
  trainer_id: 't1',
  trainer_name: 'Trainer Tina',
  has_cycle_row: true,
  is_registration: false,
  cycle_name: 'Maandagtraining',
  cyclus_name_fallback: null,
  location_name: 'Court A',
  sessions: 2,
  max_booked: 3,
  player_names: ['Guus Guest', 'Pieter Profile'],
  player_count: 2,
  price_per_session: 30,
  max_participants: 4,
  first_slot_id: 's1',
  is_public: true,
  status: 'open',
  group_type: 'cyclus',
  kind: 'cyclus',
  period_start: '2026-06-01T18:00:00Z',
  period_end: '2026-06-08T18:00:00Z',
  payment_status_summary: 'has_unpaid',
  ...over,
});

describe('mapCyclusGroupRow', () => {
  it('non-registration slot-backed: cycle name, computed day_time, straight passthrough', () => {
    const g = mapCyclusGroupRow(row(), { s1: '2026-06-01T19:00:00Z' }, enUS);
    expect(g.group_key).toBe('cy1::t1');
    expect(g.cyclus_name).toBe('Maandagtraining');
    expect(g.day_time).toBe(dayTime('2026-06-01T18:00:00Z', '2026-06-01T19:00:00Z'));
    expect(g.trainer_id).toBe('t1');
    expect(g.trainer_name).toBe('Trainer Tina');
    expect(g.sessions).toBe(2);
    expect(g.has_slots).toBe(true);
    expect(g.type).toBe('cyclus');
    expect(g.payment_status_summary).toBe('has_unpaid');
    expect(g.player_names).toEqual(['Guus Guest', 'Pieter Profile']);
  });

  it('registration series: group_key keeps the full suffix; cyclus_name = "<day> <time> - <firstPlayer>"', () => {
    const g = mapCyclusGroupRow(
      row({
        cyclus_id: 'cy2',
        group_suffix: 't1::1::18:00-19:00',
        is_registration: true,
        cycle_name: 'Inschrijving',
        player_names: ['Pieter Profile', 'Anna'],
        first_slot_id: 's3',
      }),
      { s3: '2026-06-01T19:00:00Z' },
      enUS,
    );
    expect(g.group_key).toBe('cy2::t1::1::18:00-19:00');
    // firstPlayer is player_names[0] (RPC sort order), NOT the cycle name.
    expect(g.cyclus_name).toBe(`${dayLabel('2026-06-01T18:00:00Z')} - Pieter Profile`);
    expect(g.day_time).toBe(dayTime('2026-06-01T18:00:00Z', '2026-06-01T19:00:00Z'));
  });

  it('registration series with no players: label drops the trailing player', () => {
    const g = mapCyclusGroupRow(
      row({ is_registration: true, player_names: [], first_slot_id: 's3' }),
      { s3: '2026-06-01T19:00:00Z' },
      enUS,
    );
    expect(g.cyclus_name).toBe(dayLabel('2026-06-01T18:00:00Z'));
  });

  it('orphan group (no cycles row): cyclus_name falls back to the slot cyclus_name', () => {
    const g = mapCyclusGroupRow(
      row({ has_cycle_row: false, cycle_name: null, cyclus_name_fallback: 'Aaa-vroeg', status: 'active' }),
      { s1: '2026-06-01T19:00:00Z' },
      enUS,
    );
    expect(g.cyclus_name).toBe('Aaa-vroeg');
    expect(g.has_cycle_row).toBe(false);
    expect(g.status).toBe('active');
  });

  it('no-slot cycle: day_time is "—", has_slots false, name from cycle_name', () => {
    const g = mapCyclusGroupRow(
      row({ sessions: 0, first_slot_id: null, cycle_name: 'Lege cyclus' }),
      {},
      enUS,
    );
    expect(g.day_time).toBe('—');
    expect(g.has_slots).toBe(false);
    expect(g.cyclus_name).toBe('Lege cyclus');
  });

  it('null trainer_id / max_participants / player_names get the client defaults', () => {
    const g = mapCyclusGroupRow(
      row({ trainer_id: null, trainer_name: null, max_participants: null, player_names: null, group_suffix: '' }),
      { s1: '2026-06-01T19:00:00Z' },
      enUS,
    );
    expect(g.trainer_id).toBe('');
    expect(g.trainer_name).toBe('Unknown');
    expect(g.max_participants).toBe(4);
    expect(g.player_names).toEqual([]);
    expect(g.group_key).toBe('cy1::');
  });

  it('missing first-slot end falls back to day + start only', () => {
    const g = mapCyclusGroupRow(row(), {}, enUS); // no end in the map
    expect(g.day_time).toBe(dayLabel('2026-06-01T18:00:00Z'));
  });

  it('non-registration name precedence: cycle_name ?? fallback ?? cyclus_id', () => {
    expect(mapCyclusGroupRow(row({ cycle_name: null, cyclus_name_fallback: 'fb' }), {}, enUS).cyclus_name).toBe('fb');
    expect(mapCyclusGroupRow(row({ cycle_name: null, cyclus_name_fallback: null, cyclus_id: 'rawid' }), {}, enUS).cyclus_name).toBe('rawid');
  });
});

describe('isMissingCyclusGroupsRpc', () => {
  it('is true only for the not-deployed RPC codes', () => {
    expect(isMissingCyclusGroupsRpc({ code: 'PGRST202' })).toBe(true);
    expect(isMissingCyclusGroupsRpc({ code: '42883' })).toBe(true);
    expect(isMissingCyclusGroupsRpc({ code: '23505' })).toBe(false); // a real DB error → don't mask
    expect(isMissingCyclusGroupsRpc(null)).toBe(false);
    expect(isMissingCyclusGroupsRpc(new Error('boom'))).toBe(false);
  });
});
