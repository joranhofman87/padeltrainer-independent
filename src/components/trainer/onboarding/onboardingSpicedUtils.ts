/** Maps Phase 2 PAIN_OPTIONS label keys (onboarding.spiced.*) to the onboarding i18n namespace. */
export function toOnboardingNsKey(key: string): string {
  return key.startsWith('onboarding.') ? key.slice('onboarding.'.length) : key;
}
