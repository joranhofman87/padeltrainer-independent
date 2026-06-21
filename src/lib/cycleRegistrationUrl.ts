import { getMarketingUrl } from '@/lib/domains';

export type CycleOwnerType = 'trainer' | 'club' | 'academy';

/** The marketing-route path for a cycle's public registration form. */
export function buildRegistrationPath(
  cycleId: string,
  ownerType: CycleOwnerType,
  ownerSlug?: string | null,
): string {
  if (ownerSlug) {
    if (ownerType === 'club') return `clubs/${ownerSlug}/register/${cycleId}`;
    if (ownerType === 'academy') return `academies/${ownerSlug}/register/${cycleId}`;
  }
  return `register/${cycleId}`;
}

/**
 * The full, shareable URL of a cycle's public registration form — the same URL
 * the "Share link" action copies and the QR code encodes (one source of truth).
 */
export function buildRegistrationUrl(
  cycleId: string,
  ownerType: CycleOwnerType,
  ownerSlug?: string | null,
  lang = 'nl',
): string {
  return getMarketingUrl(buildRegistrationPath(cycleId, ownerType, ownerSlug), lang);
}
