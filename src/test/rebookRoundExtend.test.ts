// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mapRoundCyclesToPrefill, type RoundCycleRow } from '@/lib/rebookRoundExtend';

const ROUND = 'round-1';

const row = (overrides: Partial<RoundCycleRow> = {}): RoundCycleRow => ({
  id: 'cycle-a',
  name: 'Najaar 26 — Do 18:00',
  start_date: '2026-08-24',
  end_date: '2026-12-06',
  location_id: 'loc-1',
  settings: {
    rebook_round_id: ROUND,
    rebook_round_label: 'Najaar 26',
    rebook_payment_mode: 'upfront',
    rebook_strict_mollie: true,
    rebook_auto_reminder: true,
    rebook_session_price: 73,
    rebook_holidays: [{ name: 'Herfstvakantie', from: '2026-10-19', to: '2026-10-25' }],
    rebook_invitation_message: 'Beste {first_name},',
    rebook_invitation_subject: 'Blijf je erbij?',
    rebook_reminder_message: 'Nog niet bevestigd…',
    rebook_reminder_subject: 'Herinnering',
    rebook_rules: '<p>Regels</p>',
    rebook_claim_info: 'Zo werkt het bij ons.',
    rebook_source_cyclus_id: 'src-1',
  },
  ...overrides,
});

describe('mapRoundCyclesToPrefill', () => {
  it('returns null for an unknown round (no cycles)', () => {
    expect(mapRoundCyclesToPrefill(ROUND, [])).toBeNull();
  });

  it('folds the round settings into an editable prefill', () => {
    const p = mapRoundCyclesToPrefill(ROUND, [row()]);
    expect(p).toMatchObject({
      roundId: ROUND,
      label: 'Najaar 26',
      anyCycleId: 'cycle-a',
      startDate: '2026-08-24',
      endDate: '2026-12-06',
      sessionPrice: '73',
      paymentMode: 'upfront',
      strictMollie: true,
      autoReminder: true,
      invitationMessage: 'Beste {first_name},',
      invitationSubject: 'Blijf je erbij?',
      reminderMessage: 'Nog niet bevestigd…',
      reminderSubject: 'Herinnering',
      rebookRules: '<p>Regels</p>',
      claimInfo: 'Zo werkt het bij ons.',
      locationIds: ['loc-1'],
      sourceCyclusIds: ['src-1'],
      cycleIds: ['cycle-a'],
    });
    expect(p?.holidays).toEqual([{ name: 'Herfstvakantie', from: '2026-10-19', to: '2026-10-25' }]);
  });

  it('dedupes locations and source cycles across the round cycles', () => {
    const p = mapRoundCyclesToPrefill(ROUND, [
      row(),
      row({ id: 'cycle-b', name: 'Najaar 26 — Do 19:00', settings: { ...row().settings, rebook_source_cyclus_id: 'src-2' } }),
      row({ id: 'cycle-c', name: 'Najaar 26 — Ma 18:00', location_id: 'loc-2' }),
    ]);
    expect(p?.locationIds.sort()).toEqual(['loc-1', 'loc-2']);
    expect(p?.sourceCyclusIds.sort()).toEqual(['src-1', 'src-2']);
  });

  it('falls back to the first cycle name when the label is missing, and defaults the toggles', () => {
    const p = mapRoundCyclesToPrefill(ROUND, [
      row({ settings: { rebook_round_id: ROUND, rebook_payment_mode: 'deferred_split' } }),
    ]);
    expect(p?.label).toBe('Najaar 26 — Do 18:00');
    expect(p?.paymentMode).toBe('deferred_split');
    expect(p?.strictMollie).toBe(false);
    expect(p?.autoReminder).toBe(true); // rebook_auto_reminder defaults ON (matches the engine)
    expect(p?.sessionPrice).toBe(''); // no snapshot → wizard falls back to the suggested price
    expect(p?.holidays).toEqual([]);
  });

  it('reads a setting from a later cycle when the first lacks it (mixed-age rounds)', () => {
    const first = row({ settings: { rebook_round_id: ROUND, rebook_payment_mode: 'upfront' } });
    const second = row({ id: 'cycle-b', settings: { ...row().settings, rebook_session_price: 76 } });
    const p = mapRoundCyclesToPrefill(ROUND, [first, second]);
    expect(p?.sessionPrice).toBe('76');
    expect(p?.label).toBe('Najaar 26'); // found on the second cycle
  });

  it('drops malformed holiday entries instead of crashing', () => {
    const p = mapRoundCyclesToPrefill(ROUND, [
      row({ settings: { ...row().settings, rebook_holidays: [{ from: '2026-10-19' }, 'junk', { name: 'X', from: '2026-12-21', to: '2027-01-03' }] } }),
    ]);
    expect(p?.holidays).toEqual([{ name: 'X', from: '2026-12-21', to: '2027-01-03' }]);
  });
});
