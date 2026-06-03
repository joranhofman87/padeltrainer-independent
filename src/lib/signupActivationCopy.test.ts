import { describe, it, expect } from 'vitest';
import enClub from '@/i18n/locales/en/club.json';
import nlClub from '@/i18n/locales/nl/club.json';
import enAcademy from '@/i18n/locales/en/academy.json';
import nlAcademy from '@/i18n/locales/nl/academy.json';

const FORBIDDEN_ACTIVATION_PHRASES =
  /pending verification|pending admin review|under review|wacht op verificatie|being reviewed by our team|in behandeling door ons team|admin will review/i;

const clubSuccessKeys = (club: typeof enClub) => [club.claim.successDescription];
const academySuccessKeys = (academy: typeof enAcademy) => [
  academy.onboarding.successDescription,
  academy.onboarding.verificationNote,
];

describe('signup activation copy (signup freeze)', () => {
  it.each([
    ['club EN', enClub, clubSuccessKeys(enClub)],
    ['club NL', nlClub, clubSuccessKeys(nlClub)],
  ])('%s onboarding success messages avoid pending-approval language', (_label, _locale, messages) => {
    for (const text of messages) {
      expect(text).toBeTruthy();
      expect(text).not.toMatch(FORBIDDEN_ACTIVATION_PHRASES);
    }
  });

  it.each([
    ['academy EN', enAcademy, academySuccessKeys(enAcademy)],
    ['academy NL', nlAcademy, academySuccessKeys(nlAcademy)],
  ])('%s onboarding success messages avoid pending-approval language', (_label, _locale, messages) => {
    for (const text of messages) {
      expect(text).toBeTruthy();
      expect(text).not.toMatch(FORBIDDEN_ACTIVATION_PHRASES);
    }
  });

  it('club EN success copy states club is ready', () => {
    expect(enClub.claim.successDescription).toMatch(/Your club is ready/i);
    expect(enClub.dashboard.getStartedTitle).toBeTruthy();
    expect(enClub.dashboard.getStartedDescription).toBeTruthy();
  });

  it('club NL success copy states club is ready', () => {
    expect(nlClub.claim.successDescription).toMatch(/club is klaar/i);
  });

  it('academy EN success copy states academy is ready', () => {
    expect(enAcademy.onboarding.successDescription).toMatch(/Your academy is ready/i);
  });

  it('academy NL success copy states academy is ready', () => {
    expect(nlAcademy.onboarding.successDescription).toMatch(/academy is klaar/i);
  });
});
