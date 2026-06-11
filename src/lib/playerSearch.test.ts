import { describe, expect, it } from 'vitest';
import { filterPlayersByQuery, playerComboboxSearchValue, playerMatchesQuery } from './playerSearch';

const jan = {
  full_name: 'Jan Jansen',
  email: 'jan@padel.nl',
  phone: '+31612345678',
  billing_business_name: 'Padel Pro BV',
};
const sanne = {
  full_name: 'Sanne de Vries',
  email: 'sanne@example.com',
  phone: '',
  billing_business_name: null,
};
const jose = {
  full_name: 'José García',
  email: null,
  phone: null,
  billing_business_name: null,
};

describe('playerMatchesQuery', () => {
  it('matches partial name case-insensitively', () => {
    expect(playerMatchesQuery(jan, 'jans')).toBe(true);
    expect(playerMatchesQuery(jan, 'JAN')).toBe(true);
    expect(playerMatchesQuery(sanne, 'vries')).toBe(true);
  });

  it('matches partial email', () => {
    expect(playerMatchesQuery(jan, 'jan@padel')).toBe(true);
    expect(playerMatchesQuery(sanne, 'example.com')).toBe(true);
  });

  it('matches partial business name', () => {
    expect(playerMatchesQuery(jan, 'padel pro')).toBe(true);
    expect(playerMatchesQuery(jan, 'pro bv')).toBe(true);
    expect(playerMatchesQuery(sanne, 'padel pro')).toBe(false);
  });

  it('matches phone digits across formatting', () => {
    expect(playerMatchesQuery(jan, '612345')).toBe(true);
    expect(playerMatchesQuery(jan, '31 6 1234')).toBe(true);
    expect(playerMatchesQuery(jan, '99999')).toBe(false);
  });

  it('requires every token to match some field (cross-field AND)', () => {
    expect(playerMatchesQuery(jan, 'jan padel')).toBe(true); // name + business
    expect(playerMatchesQuery(jan, 'jan xyz')).toBe(false);
  });

  it('is diacritic-insensitive both ways', () => {
    expect(playerMatchesQuery(jose, 'jose')).toBe(true);
    expect(playerMatchesQuery(jose, 'garcia')).toBe(true);
    expect(playerMatchesQuery(jose, 'José')).toBe(true);
  });

  it('empty query matches everything', () => {
    expect(playerMatchesQuery(jan, '')).toBe(true);
    expect(playerMatchesQuery(jan, '   ')).toBe(true);
  });
});

describe('filterPlayersByQuery', () => {
  it('filters the list and keeps order', () => {
    expect(filterPlayersByQuery([jan, sanne, jose], 'an')).toEqual([jan, sanne]);
    expect(filterPlayersByQuery([jan, sanne, jose], '')).toHaveLength(3);
  });
});

describe('playerComboboxSearchValue', () => {
  it('includes name, email, business name and phone', () => {
    const v = playerComboboxSearchValue(jan);
    expect(v).toContain('Jan Jansen');
    expect(v).toContain('jan@padel.nl');
    expect(v).toContain('Padel Pro BV');
    expect(v).toContain('+31612345678');
  });

  it('skips empty fields without leaving gaps', () => {
    expect(playerComboboxSearchValue(jose)).toBe('José García');
  });
});
