import { describe, it, expect } from 'vitest';
import { PROVINCES, getProvinceBySlug, getProvincesForCountry, getAllProvinceSlugs } from './provinces';

describe('provinces', () => {
  it('all slugs are unique', () => {
    const slugs = PROVINCES.map(p => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('all provinces have at least one city', () => {
    PROVINCES.forEach(p => {
      expect(p.cities.length).toBeGreaterThan(0);
    });
  });

  it('getProvinceBySlug returns correct province', () => {
    const p = getProvinceBySlug('noord-holland');
    expect(p?.name).toBe('Noord-Holland');
    expect(p?.country).toBe('NL');
  });

  it('getProvinceBySlug returns undefined for unknown slug', () => {
    expect(getProvinceBySlug('nonexistent')).toBeUndefined();
  });

  it('getProvincesForCountry filters correctly', () => {
    const nl = getProvincesForCountry('NL');
    expect(nl.length).toBe(12);
    nl.forEach(p => expect(p.country).toBe('NL'));

    const es = getProvincesForCountry('ES');
    expect(es.length).toBe(4);

    const fr = getProvincesForCountry('FR');
    expect(fr.length).toBeGreaterThanOrEqual(7);
  });

  it('getAllProvinceSlugs returns all slugs', () => {
    const slugs = getAllProvinceSlugs();
    expect(slugs.length).toBe(PROVINCES.length);
    expect(slugs).toContain('noord-holland');
    expect(slugs).toContain('cataluna');
    expect(slugs).toContain('ile-de-france');
  });

  it('covers all 5 countries', () => {
    const countries = new Set(PROVINCES.map(p => p.country));
    expect(countries).toContain('NL');
    expect(countries).toContain('BE');
    expect(countries).toContain('ES');
    expect(countries).toContain('DE');
    expect(countries).toContain('FR');
  });
});
