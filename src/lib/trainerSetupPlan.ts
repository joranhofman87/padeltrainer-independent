/** Minimum profile fields for the dashboard “complete profile” setup step (v1). */
export interface TrainerProfileSetupInput {
  bio: string | null | undefined;
  hourlyRate: number | null | undefined;
}

export interface TrainerPublishSetupInput {
  isPublic: boolean | null | undefined;
  slug: string | null | undefined;
}

const MIN_BIO_LENGTH = 10;

/**
 * Conservative v1: bio (≥10 chars) and hourly rate > 0.
 * Name is collected at signup; does not use slug, avatar, or is_public.
 */
export function computeTrainerProfileSetupComplete(input: TrainerProfileSetupInput): boolean {
  const bio = input.bio?.trim() ?? '';
  const rate = input.hourlyRate;

  return bio.length >= MIN_BIO_LENGTH && rate != null && rate > 0;
}

/** Booking page is live when profile is published and has a public slug. */
export function computeTrainerPublishComplete(input: TrainerPublishSetupInput): boolean {
  return !!input.isPublic && !!(input.slug?.trim());
}

export interface TrainerPaymentsSetupInput {
  useManualInvoicing: boolean;
  mollieOnboardingComplete: boolean;
  mollieChargesEnabled: boolean;
  academyChargesEnabled: boolean;
}

/** Matches TrainerGetStarted / earnings: Mollie ready, manual invoicing, or academy payouts. */
export function computeTrainerPaymentsSetupComplete(input: TrainerPaymentsSetupInput): boolean {
  return (
    input.useManualInvoicing ||
    (input.mollieOnboardingComplete && input.mollieChargesEnabled) ||
    input.academyChargesEnabled
  );
}
