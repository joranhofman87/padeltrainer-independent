import { describe, it, expect } from 'vitest';
import { buildRegistrationPath, buildRegistrationUrl, shareUrlForRegistration } from './cycleRegistrationUrl';

const ID = '4bbe9966-1ef4-4087-9e82-e75284c50dbf';

describe('buildRegistrationPath', () => {
  it('academy with slug → academies/<slug>/register/<id>', () => {
    expect(buildRegistrationPath(ID, 'academy', 'rl-padel')).toBe(`academies/rl-padel/register/${ID}`);
  });

  it('club with slug → clubs/<slug>/register/<id>', () => {
    expect(buildRegistrationPath(ID, 'club', 'tc-boemerang')).toBe(`clubs/tc-boemerang/register/${ID}`);
  });

  it('trainer → slugless register/<id> (trainers never get an owner segment)', () => {
    expect(buildRegistrationPath(ID, 'trainer', 'ignored')).toBe(`register/${ID}`);
  });

  it('academy/club WITHOUT a slug falls back to slugless register/<id>', () => {
    expect(buildRegistrationPath(ID, 'academy')).toBe(`register/${ID}`);
    expect(buildRegistrationPath(ID, 'club', null)).toBe(`register/${ID}`);
  });
});

describe('buildRegistrationUrl', () => {
  it('is the absolute, lang-prefixed marketing URL of the path', () => {
    expect(buildRegistrationUrl(ID, 'academy', 'rl-padel', 'nl')).toBe(
      `https://padeltrainer.ai/nl/academies/rl-padel/register/${ID}`,
    );
    expect(buildRegistrationUrl(ID, 'trainer', null, 'en')).toBe(
      `https://padeltrainer.ai/en/register/${ID}`,
    );
  });

  it('defaults to nl', () => {
    expect(buildRegistrationUrl(ID, 'trainer')).toBe(`https://padeltrainer.ai/nl/register/${ID}`);
  });
});

describe('shareUrlForRegistration (the single source share URL)', () => {
  it('uses the branded /s/<code> short link when a code is present', () => {
    expect(shareUrlForRegistration('aB3xK9q', ID, 'academy', 'rl-padel')).toBe('https://padeltrainer.ai/s/aB3xK9q');
  });

  it('short link WINS regardless of owner type / slug (they only shape the fallback)', () => {
    expect(shareUrlForRegistration('aB3xK9q', ID, 'trainer')).toBe('https://padeltrainer.ai/s/aB3xK9q');
  });

  it('falls back to the full registration URL when no code (null / undefined / empty)', () => {
    expect(shareUrlForRegistration(null, ID, 'academy', 'rl-padel', 'nl')).toBe(
      `https://padeltrainer.ai/nl/academies/rl-padel/register/${ID}`,
    );
    expect(shareUrlForRegistration(undefined, ID, 'trainer')).toBe(
      `https://padeltrainer.ai/nl/register/${ID}`,
    );
    expect(shareUrlForRegistration('', ID, 'club', 'tc')).toBe(
      `https://padeltrainer.ai/nl/clubs/tc/register/${ID}`,
    );
  });
});
