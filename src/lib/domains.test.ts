import { describe, it, expect } from 'vitest';
import {
  getAppUrl,
  getMarketingUrl,
  getMarketingPath,
  getAcademyShortUrl,
  getTrainerShortUrl,
} from './domains';

describe('getAppUrl', () => {
  it('prefixes path with /app', () => {
    expect(getAppUrl('/player')).toBe('/app/player');
  });

  it('handles path without leading slash', () => {
    expect(getAppUrl('trainer/dashboard')).toBe('/app/trainer/dashboard');
  });
});

describe('getMarketingUrl', () => {
  it('returns full URL with language', () => {
    expect(getMarketingUrl('trainers', 'nl')).toBe('https://padeltrainer.ai/nl/trainers');
  });

  it('defaults to nl language', () => {
    expect(getMarketingUrl('blog')).toBe('https://padeltrainer.ai/nl/blog');
  });

  it('returns root marketing URL for empty path', () => {
    expect(getMarketingUrl('', 'en')).toBe('https://padeltrainer.ai/en');
  });

  it('strips leading slash from path', () => {
    expect(getMarketingUrl('/trainers', 'en')).toBe('https://padeltrainer.ai/en/trainers');
  });
});

describe('getMarketingPath', () => {
  it('returns relative path with language', () => {
    expect(getMarketingPath('blog', 'en')).toBe('/en/blog');
  });

  it('returns language root for empty path', () => {
    expect(getMarketingPath('', 'nl')).toBe('/nl');
  });
});

describe('short link helpers', () => {
  it('builds an academy short url', () => {
    expect(getAcademyShortUrl('jan-de-vries')).toBe('https://padeltrainer.ai/a/jan-de-vries');
  });

  it('builds a trainer short url', () => {
    expect(getTrainerShortUrl('rene')).toBe('https://padeltrainer.ai/t/rene');
  });
});
