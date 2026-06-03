/** Minimum profile fields for the dashboard “complete profile” setup step (v1). */
export interface TrainerProfileSetupInput {
  fullName: string | null | undefined;
  bio: string | null | undefined;
  hourlyRate: number | null | undefined;
}

export interface TrainerPublishSetupInput {
  isPublic: boolean | null | undefined;
  slug: string | null | undefined;
}

const MIN_FULL_NAME_LENGTH = 2;
const MIN_BIO_LENGTH = 10;

/**
 * Conservative v1: name, bio (≥10 chars), and hourly rate > 0.
 * Does not use slug, avatar, or is_public.
 */
export function computeTrainerProfileSetupComplete(input: TrainerProfileSetupInput): boolean {
  const name = input.fullName?.trim() ?? '';
  const bio = input.bio?.trim() ?? '';
  const rate = input.hourlyRate;

  return name.length >= MIN_FULL_NAME_LENGTH && bio.length >= MIN_BIO_LENGTH && rate != null && rate > 0;
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
