import { describe, expect, it } from 'vitest';
import {
  buildMergeFields,
  compareMergeFields,
  formatSkill,
  isLinkedAccountsMergeError,
  parseMergeCounts,
  type MergeGuestFields,
} from './mergePlayers';

function guest(overrides: Partial<MergeGuestFields> = {}): MergeGuestFields {
  return {
    full_name: null,
    first_name: null,
    last_name: null,
    email: null,
    phone: null,
    skill_rating: null,
    rating_system: 'knltb',
    birth_date: null,
    notes: null,
    billing_business_name: null,
    billing_address: null,
    billing_btw_number: null,
    ...overrides,
  };
}

describe('compareMergeFields', () => {
  it('marks fields where both sides differ as conflicts', () => {
    const states = compareMergeFields(
      guest({ full_name: 'Jan Jansen', email: 'jan@a.nl' }),
      guest({ full_name: 'J. Jansen', email: 'jan@b.nl' }),
    );
    const byKey = Object.fromEntries(states.map((s) => [s.key, s]));
    expect(byKey.full_name.kind).toBe('conflict');
    expect(byKey.full_name.targetValue).toBe('Jan Jansen');
    expect(byKey.full_name.sourceValue).toBe('J. Jansen');
    expect(byKey.email.kind).toBe('conflict');
  });

  it('marks source-only values as carry_from_source and target-only as target_only', () => {
    const states = compareMergeFields(
      guest({ full_name: 'Jan', phone: '0612345678' }),
      guest({ full_name: 'Jan', email: 'jan@a.nl' }),
    );
    const byKey = Object.fromEntries(states.map((s) => [s.key, s]));
    expect(byKey.email.kind).toBe('carry_from_source');
    expect(byKey.email.sourceValue).toBe('jan@a.nl');
    expect(byKey.phone.kind).toBe('target_only');
    expect(byKey.full_name.kind).toBe('equal');
    expect(byKey.notes.kind).toBe('empty');
  });

  it('treats whitespace-only values as empty', () => {
    const states = compareMergeFields(
      guest({ full_name: 'Jan', notes: '   ' }),
      guest({ full_name: 'Jan', notes: 'real note' }),
    );
    const notes = states.find((s) => s.key === 'notes')!;
    expect(notes.kind).toBe('carry_from_source');
    expect(notes.sourceValue).toBe('real note');
  });

  it('compares emails case-insensitively but keeps original display', () => {
    const states = compareMergeFields(
      guest({ full_name: 'Jan', email: 'Jan@A.nl' }),
      guest({ full_name: 'Jan', email: 'jan@a.nl' }),
    );
    const email = states.find((s) => s.key === 'email')!;
    expect(email.kind).toBe('equal');
    expect(email.targetValue).toBe('Jan@A.nl');
  });

  it('treats skill as one composite field (rating + system)', () => {
    const equal = compareMergeFields(
      guest({ full_name: 'Jan', skill_rating: 5.5, rating_system: 'knltb' }),
      guest({ full_name: 'Jan', skill_rating: 5.5, rating_system: 'KNLTB' }),
    ).find((s) => s.key === 'skill')!;
    expect(equal.kind).toBe('equal');

    const conflict = compareMergeFields(
      guest({ full_name: 'Jan', skill_rating: 5.5, rating_system: 'knltb' }),
      guest({ full_name: 'Jan', skill_rating: 6.0, rating_system: 'knltb' }),
    ).find((s) => s.key === 'skill')!;
    expect(conflict.kind).toBe('conflict');
    expect(conflict.targetValue).toBe('5.5 KNLTB');
    expect(conflict.sourceValue).toBe('6.0 KNLTB');
  });
});

describe('buildMergeFields', () => {
  it('returns an empty payload when the target wins every conflict and nothing is carried', () => {
    const target = guest({ full_name: 'Jan', email: 'jan@a.nl' });
    const source = guest({ full_name: 'Johan', email: 'jan@b.nl' });
    expect(buildMergeFields(target, source)).toEqual({});
    expect(buildMergeFields(target, source, { full_name: 'target', email: 'target' })).toEqual({});
  });

  it('includes source values the admin chose', () => {
    const target = guest({ full_name: 'Jan', email: 'jan@a.nl', phone: '061' });
    const source = guest({ full_name: 'Johan', email: 'jan@b.nl', phone: '062' });
    expect(buildMergeFields(target, source, { email: 'source' })).toEqual({
      email: 'jan@b.nl',
    });
  });

  it('auto-carries source-only values without an explicit choice', () => {
    const target = guest({ full_name: 'Jan' });
    const source = guest({
      full_name: 'Jan',
      phone: ' 0612345678 ',
      billing_address: 'Straat 1',
      billing_btw_number: 'NL001',
      billing_business_name: 'Padel BV',
      birth_date: '1990-01-01',
      notes: 'lefty',
    });
    expect(buildMergeFields(target, source)).toEqual({
      phone: '0612345678',
      billing_address: 'Straat 1',
      billing_btw_number: 'NL001',
      billing_business_name: 'Padel BV',
      birth_date: '1990-01-01',
      notes: 'lefty',
    });
  });

  it('keeps name parts consistent when the full name comes from the source', () => {
    const target = guest({ full_name: 'Jan Jansen', first_name: 'Jan', last_name: 'Jansen' });
    const source = guest({ full_name: 'Johan Jansen', first_name: 'Johan', last_name: 'Jansen' });
    expect(buildMergeFields(target, source, { full_name: 'source' })).toEqual({
      full_name: 'Johan Jansen',
      first_name: 'Johan',
      last_name: 'Jansen',
    });
  });

  it('clears name parts the source does not have (null-safe)', () => {
    const target = guest({ full_name: 'Jan Jansen', first_name: 'Jan', last_name: 'Jansen' });
    const source = guest({ full_name: 'JJ', first_name: null, last_name: null });
    expect(buildMergeFields(target, source, { full_name: 'source' })).toEqual({
      full_name: 'JJ',
      first_name: null,
      last_name: null,
    });
  });

  it('emits skill_rating and rating_system together for the composite skill field', () => {
    const target = guest({ full_name: 'Jan', skill_rating: 5.5, rating_system: 'knltb' });
    const source = guest({ full_name: 'Jan', skill_rating: 7, rating_system: 'playtomic' });
    expect(buildMergeFields(target, source, { skill: 'source' })).toEqual({
      skill_rating: 7,
      rating_system: 'playtomic',
    });

    // auto-carry when target is unrated
    const unrated = guest({ full_name: 'Jan', skill_rating: null });
    expect(buildMergeFields(unrated, source)).toEqual({
      skill_rating: 7,
      rating_system: 'playtomic',
    });
  });

  it('defaults the rating system to knltb when the source has none', () => {
    const target = guest({ full_name: 'Jan' });
    const source = guest({ full_name: 'Jan', skill_rating: 4.2, rating_system: null });
    expect(buildMergeFields(target, source)).toEqual({
      skill_rating: 4.2,
      rating_system: 'knltb',
    });
  });
});

describe('formatSkill', () => {
  it('formats rating with one decimal and uppercased system', () => {
    expect(formatSkill(5.5, 'knltb')).toBe('5.5 KNLTB');
    expect(formatSkill(7, null)).toBe('7.0 KNLTB');
    expect(formatSkill(null, 'knltb')).toBeNull();
  });
});

describe('parseMergeCounts', () => {
  it('reads the RPC count payload', () => {
    expect(
      parseMergeCounts({
        target_guest_id: 'x',
        bookings_moved: 3,
        invoices_moved: 2,
        intake_requests_moved: 1,
        priority_claims_moved: 4,
        priority_claims_deduped: 1,
        metadata_rows_moved: 1,
        metadata_rows_merged: 1,
      }),
    ).toEqual({
      bookingsMoved: 3,
      invoicesMoved: 2,
      intakeRequestsMoved: 1,
      priorityClaimsMoved: 4,
      priorityClaimsDeduped: 1,
      metadataRowsMoved: 1,
      metadataRowsMerged: 1,
    });
  });

  it('falls back to zeros for missing or malformed payloads', () => {
    expect(parseMergeCounts(null).bookingsMoved).toBe(0);
    expect(parseMergeCounts('oops').invoicesMoved).toBe(0);
    expect(parseMergeCounts({ bookings_moved: 'NaN?' }).bookingsMoved).toBe(0);
  });
});

describe('isLinkedAccountsMergeError', () => {
  it('detects the two-accounts rejection from the RPC', () => {
    expect(
      isLinkedAccountsMergeError(
        'players are linked to two different accounts and cannot be merged',
      ),
    ).toBe(true);
    expect(isLinkedAccountsMergeError('source player not found')).toBe(false);
  });
});
