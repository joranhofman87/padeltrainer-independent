import { describe, it, expect } from 'vitest';
import { isAppPath, localizePathWithLang } from './useLocalizedPath';

describe('isAppPath', () => {
  it('recognizes /app and /app/* paths', () => {
    expect(isAppPath('/app')).toBe(true);
    expect(isAppPath('/app/academy/trainers/abc')).toBe(true);
  });

  it('does not treat marketing paths as app paths', () => {
    expect(isAppPath('/trainers')).toBe(false);
    expect(isAppPath('/en/trainers')).toBe(false);
  });
});

describe('localizePathWithLang', () => {
  it('returns app routes unchanged', () => {
    expect(localizePathWithLang('/app/academy/trainers/x', 'en')).toBe('/app/academy/trainers/x');
    expect(localizePathWithLang('/app/academy/trainers', 'nl')).toBe('/app/academy/trainers');
  });

  it('localizes marketing routes', () => {
    expect(localizePathWithLang('/trainers', 'nl')).toBe('/nl/trainers');
    expect(localizePathWithLang('/trainer/jan', 'en')).toBe('/en/trainer/jan');
    expect(localizePathWithLang('/academies/foo', 'de')).toBe('/de/academies/foo');
  });

  it('does not double-prefix already localized paths', () => {
    expect(localizePathWithLang('/nl/trainers', 'en')).toBe('/nl/trainers');
  });
});
